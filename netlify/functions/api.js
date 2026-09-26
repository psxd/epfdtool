import { USERS } from './users.js';

// ---------------------------------------------------------------------------
// Accounts. The list comes from the repo file ./users.js (salted SHA-256 hashes
// or, if you insist, plain text), optionally extended/overridden by the
// COMMENT_USERS Netlify env var (JSON, same shape as the file), and the single
// ADMIN_USERNAME/ADMIN_PASSWORD env pair always stays valid as well so an
// existing deployment keeps working unchanged. Values are never logged.
// ---------------------------------------------------------------------------
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

/** Normalise one users.js / COMMENT_USERS entry into a predictable shape. */
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

/** Repo accounts, extended/overridden by the optional COMMENT_USERS env JSON. */
function configuredUsers() {
  const list = new Map();
  const merge = (source) => {
    if (!source || typeof source !== 'object') return;
    for (const [key, entry] of Object.entries(source)) {
      const norm = normalizeEntry(key, entry);
      if (norm) list.set(norm.lower, norm);
    }
  };
  merge(USERS);
  if (process.env.COMMENT_USERS) {
    try { merge(JSON.parse(process.env.COMMENT_USERS)); } catch { /* bad JSON: repo accounts still apply */ }
  }
  return list;
}

/** Returns { username, name } the credentials belong to, or null. Usernames
 *  are matched case-insensitively; the repo/env spelling is what gets used. */
async function authenticate(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string' || !password) return null;
  const wanted = username.trim().toLowerCase();
  if (!wanted) return null;

  const adminUser = (process.env.ADMIN_USERNAME || '').trim();
  const adminPass = process.env.ADMIN_PASSWORD || '';
  if (adminUser && adminPass && wanted === adminUser.toLowerCase() && await safeEqual(password, adminPass)) {
    return { username: adminUser, name: adminUser };
  }

  const entry = configuredUsers().get(wanted);
  if (!entry) return null;
  if (entry.hash) {
    const [salt, digest] = entry.hash.split(':');
    if (!digest || !/^[0-9a-f]{64}$/i.test(digest)) return null; // malformed hash entry
    return await safeEqual(await sha256Hex(`${salt || ''}:${password}`), digest)
      ? { username: entry.key, name: entry.name } : null;
  }
  if (entry.password && await safeEqual(password, entry.password)) {
    return { username: entry.key, name: entry.name };
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
  // see which Netlify env vars this function actually receives, plus how many
  // accounts it can see (booleans and counts only — never values).
  if (req.method === 'GET') {
    return new Response(JSON.stringify({
      ok: true,
      env: {
        SUPABASE_URL: !!process.env.SUPABASE_URL,
        SUPABASE_ANON_KEY: !!process.env.SUPABASE_ANON_KEY,
        ADMIN_USERNAME: !!process.env.ADMIN_USERNAME,
        ADMIN_PASSWORD: !!process.env.ADMIN_PASSWORD,
        SLACK_WEBHOOK_URL: !!process.env.SLACK_WEBHOOK_URL,
        AUTH_SECRET: !!process.env.AUTH_SECRET,
        COMMENT_USERS: !!process.env.COMMENT_USERS,
      },
      accounts: {
        repoFile: Object.keys(USERS || {}).length,
        total: configuredUsers().size,
        adminPair: !!(process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD),
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
        // No built-in fallback account: the only credentials that work are the
        // ones in netlify/functions/users.js, COMMENT_USERS or the
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