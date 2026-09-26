// ---------------------------------------------------------------------------
// Accounts live in Supabase, in a table called `app_users`:
//
//   insert into app_users (username, password) values ('alice', 's3cret');
//
// Adding or removing a team member is therefore one row in the Supabase Table
// Editor — no Netlify redeploy (Netlify deploys are rate/credit limited, writing
// to Supabase is not). `password` may hold plain text or a salted hash in the
// `salt:sha256hex` shape written by `npm run add-user -- … --hash`.
//
// Lookup order:
//   1. Supabase `app_users`    — authoritative: when the username is in that
//                               table its stored password decides, and the env
//                               fallbacks below are NOT consulted.
//   2. COMMENT_USERS env JSON  — private accounts, or overrides for usernames
//                               that are not in app_users.
//   3. ADMIN_USERNAME/PASSWORD — the single legacy pair, same rule as (2).
//
// Every key stays in Netlify env vars (SUPABASE_URL plus SUPABASE_ANON_KEY or,
// preferably, SUPABASE_SERVICE_ROLE_KEY) so nothing secret sits in this public
// repository. Credential values are never logged.
// ---------------------------------------------------------------------------
const APP_USERS_TABLE = 'app_users';
const SB_TIMEOUT_MS = 5000;
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time-ish compare: both sides are hashed to a fixed length first. */
async function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const [x, y] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/** True when `supplied` matches a stored app_users value: either plain text or
 *  a `salt:sha256hex` digest (both sides are hashed before comparing). */
async function passwordMatches(stored, supplied) {
  if (typeof supplied !== 'string' || !supplied) return false;
  const value = String(stored == null ? '' : stored);
  if (!value) return false;
  const hashed = /^([^:]{0,64}):([0-9a-f]{64})$/i.exec(value);
  if (hashed) return safeEqual(await sha256Hex(`${hashed[1]}:${supplied}`), hashed[2].toLowerCase());
  return safeEqual(supplied, value); // plain-text column value
}

/** Minimal PostgREST GET against Supabase. Never throws: resolves { rows } when
 *  the table answered, or { error, detail } when it could not be read. */
async function supabaseGet(query) {
  const base = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  // A service-role key is optional (see netlify.toml): it is what lets the
  // public "read app_users" RLS policy be dropped. Falls back to the anon key.
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '').trim();
  if (!base || !key) return { error: 'not-configured' };

  let res;
  try {
    res = await fetch(`${base}/rest/v1/${query}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(SB_TIMEOUT_MS),
    });
  } catch (err) {
    return { error: err && err.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
  }

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    // 404 = table missing, 401/403 = RLS blocking this key.
    return { error: `http-${res.status}`, detail: text.slice(0, 200).replace(/\s+/g, ' ') };
  }
  try {
    const rows = text ? JSON.parse(text) : [];
    return { rows: Array.isArray(rows) ? rows : [] };
  } catch {
    return { error: 'bad-json' };
  }
}

/** One app_users account: { row } (null when the username is unknown) or { error }. */
async function supabaseLookup(username) {
  // The table stores whatever spelling was inserted, so try the typed spelling
  // and its lowercase form to keep logins case-insensitive.
  for (const candidate of [...new Set([username, username.toLowerCase()])]) {
    const query = `${APP_USERS_TABLE}?select=username,password`
      + `&username=eq.${encodeURIComponent(candidate)}&limit=1`;
    const res = await supabaseGet(query);
    if (res.error) return res;
    const row = res.rows[0];
    if (row && typeof row.username === 'string') {
      return { row: { username: row.username, password: row.password } };
    }
  }
  return { row: null };
}

/** Usernames only — used by the ?diag=1 health check, never passwords. */
async function supabaseListUsers() {
  const res = await supabaseGet(`${APP_USERS_TABLE}?select=username&order=username.asc`);
  if (res.error) return res;
  return { usernames: res.rows.map((r) => r && r.username).filter((u) => typeof u === 'string') };
}

/** Normalise one COMMENT_USERS entry into a predictable shape. */
function normalizeEntry(key, entry) {
  const raw = String(key == null ? '' : key).trim();
  if (!raw) return null;
  const base = { key: raw, lower: raw.toLowerCase(), name: raw, hash: null, password: null };
  if (typeof entry === 'string') return { ...base, password: entry };
  if (!entry || typeof entry !== 'object') return null;
  return {
    ...base,
    name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : raw,
    hash: typeof entry.hash === 'string' && entry.hash.trim() ? entry.hash.trim() : null,
    password: typeof entry.password === 'string' ? entry.password : null,
  };
}

/** Private accounts from the optional COMMENT_USERS env JSON, in the shape the
 *  old repo file used: {"bob":{"password":"hunter2","name":"Bob"},"carol":"pw"} */
function configuredUsers() {
  const list = new Map();
  const merge = (source) => {
    if (!source || typeof source !== 'object') return;
    for (const [key, entry] of Object.entries(source)) {
      const norm = normalizeEntry(key, entry);
      if (norm) list.set(norm.lower, norm);
    }
  };
  if (process.env.COMMENT_USERS) {
    try { merge(JSON.parse(process.env.COMMENT_USERS)); } catch { /* bad JSON: app_users still applies */ }
  }
  return list;
}

/** Returns { username, name } the credentials belong to, or null.
 *  Usernames are matched case-insensitively; the stored spelling is kept. */
async function authenticate(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string' || !password) return null;
  const typed = username.trim();
  // Only a plausible login name; whitespace or '%' cannot be a row key here.
  if (!typed || typed.length > 64 || /[\s%]/.test(typed)) return null;
  const wanted = typed.toLowerCase();

  // 1. Supabase `app_users` — the account store. When the username is in that
  //    table its password is the only one that works: the env fallbacks below
  //    are deliberately not consulted, so changing or deleting the row takes
  //    effect immediately.
  const sb = await supabaseLookup(typed);
  if (sb.error) {
    // Values are never logged — only why the primary store was unusable.
    console.warn(`app_users lookup failed (${sb.error}${sb.detail ? `: ${sb.detail}` : ''}) — falling back to env accounts`);
  } else if (sb.row) {
    // app_users has no display-name column, so the username is its own name.
    return await passwordMatches(sb.row.password, password)
      ? { username: sb.row.username, name: sb.row.username } : null;
  }

  // 2. COMMENT_USERS env JSON (private accounts / env-only usernames).
  const entry = configuredUsers().get(wanted);
  if (entry && await passwordMatches(entry.hash || entry.password, password)) {
    return { username: entry.key, name: entry.name };
  }

  // 3. Legacy single admin pair, so existing deployments keep working.
  const adminUser = (process.env.ADMIN_USERNAME || '').trim();
  const adminPass = process.env.ADMIN_PASSWORD || '';
  if (adminUser && adminPass && wanted === adminUser.toLowerCase() && await safeEqual(password, adminPass)) {
    return { username: adminUser, name: adminUser };
  }
  return null;
}

// Issues and checks short, stateless auth tokens. The secret never appears in
// this (public) repository: it comes from the Netlify env vars, falling back to
// the admin password so an existing deployment keeps working without new config.
async function signToken(username) {
  const secret = process.env.AUTH_SECRET || process.env.ADMIN_PASSWORD || 'epfd-dev-secret';
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(username));
  return `${username}.${[...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

async function tokenIsValid(token) {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const username = token.slice(0, token.lastIndexOf('.'));
  if (!username) return false;
  return token === (await signToken(username));
}

export default async (req, context) => {
  // 1. Handle CORS Preflight request from GitHub Pages
  if (req.method === 'OPTIONS') {
    // Note: a 204 must have a null body — passing 'OK' throws a TypeError.
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*', // Or restrict to your specific GitHub Pages URL
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
    });
  }

  // Standard CORS headers for all responses
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  // Health check: open <site>/.netlify/functions/api?diag=1 in a browser tab to
  // see which Netlify env vars this function actually receives and which accounts
  // it can see. Booleans and account NAMES only — never a key, password or token.
  if (req.method === 'GET') {
    const sb = await supabaseListUsers();
    return new Response(JSON.stringify({
      ok: true,
      env: {
        SUPABASE_URL: !!process.env.SUPABASE_URL,
        SUPABASE_ANON_KEY: !!process.env.SUPABASE_ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
        ADMIN_USERNAME: !!process.env.ADMIN_USERNAME,
        ADMIN_PASSWORD: !!process.env.ADMIN_PASSWORD,
        SLACK_WEBHOOK_URL: !!process.env.SLACK_WEBHOOK_URL,
        AUTH_SECRET: !!process.env.AUTH_SECRET,
        COMMENT_USERS: !!process.env.COMMENT_USERS,
      },
      accounts: {
        source: `supabase:${APP_USERS_TABLE}`,
        reachable: !sb.error,
        error: sb.error ? `${sb.error}${sb.detail ? ` — ${sb.detail}` : ''}` : null,
        count: (sb.usernames || []).length,
        users: sb.usernames || [],
        envFallbacks: {
          commentUsers: configuredUsers().size,
          adminPair: !!(process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD),
        },
      },
    }, null, 2), { status: 200, headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { action, username, password, message, token: bodyToken } = body;

    // Action 1: Get Supabase Config
    if (action === 'get-config') {
      return new Response(JSON.stringify({
        SUPABASE_URL: process.env.SUPABASE_URL,
        SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY
      }), { status: 200, headers: corsHeaders });
    }

    // Action 2: Login
    if (action === 'login') {
      const who = await authenticate(username, password);
      if (!who) {
        // No built-in fallback account: valid credentials only come from
        // Supabase app_users, the COMMENT_USERS env JSON or the
        // ADMIN_USERNAME/ADMIN_PASSWORD env pair.
        return new Response(JSON.stringify({ success: false }), { status: 401, headers: corsHeaders });
      }
      // Derive a stateless token from the server-side secret (no literal
      // credential/token values in this public repository).
      const token = await signToken(who.username);
      return new Response(JSON.stringify({
        success: true, token, username: who.username, name: who.name,
      }), { status: 200, headers: corsHeaders });
    }

    // Action 3: Send Slack Notification (Protected)
    if (action === 'send-slack') {
      // Token may arrive in the JSON body (preferred: keeps the browser request
      // preflight-free) or as a classic Authorization: Bearer header.
      const authHeader = req.headers.get('authorization');
      const token = bodyToken
        || (authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null);

      if (!token) {
        return new Response(JSON.stringify({ error: 'Unauthorized: Missing token' }), { status: 401, headers: corsHeaders });
      }
      if (!(await tokenIsValid(token))) {
        return new Response(JSON.stringify({ error: 'Forbidden: Invalid token' }), { status: 403, headers: corsHeaders });
      }

      // Send the message to Slack using the webhook stored in Netlify env vars.
      const webhook = process.env.SLACK_WEBHOOK_URL;
      if (!webhook) {
        return new Response(JSON.stringify({ success: false, error: 'SLACK_WEBHOOK_URL not configured' }), { status: 500, headers: corsHeaders });
      }
      const slackRes = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message }),
      });
      if (!slackRes.ok) {
        const detail = await slackRes.text();
        return new Response(JSON.stringify({ success: false, error: `Slack returned ${slackRes.status}: ${detail.slice(0, 120)}` }), { status: 502, headers: corsHeaders });
      }

      return new Response(JSON.stringify({ success: true, message: 'Sent!' }), { status: 200, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: 'Invalid action' }), { status: 400, headers: corsHeaders });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
};