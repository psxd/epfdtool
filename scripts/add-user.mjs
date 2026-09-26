#!/usr/bin/env node
// Adds (or replaces) a login account in the Supabase `app_users` table that
// netlify/functions/api.js authenticates against. No Netlify deploy is needed:
// the account works as soon as the row is written.
//
//   npm run add-user -- alice "s3cret-pw"           # plain-text password
//   npm run add-user -- alice "s3cret-pw" --hash    # salted SHA-256 instead
//   npm run add-user -- alice "new-pw"    --force   # replace an existing row
//   npm run add-user -- --verify alice "s3cret-pw"  # only test the login
//   npm run add-user -- --list                      # who can log in right now
//
// Supabase keys come from the environment...
//   SUPABASE_URL=... SUPABASE_ANON_KEY=... npm run add-user -- alice "pw"
// ...or, when they are not exported locally, from the deployed function's
// get-config action, which hands out the same public anon key the browser uses.
//
// Writing a row needs either SUPABASE_SERVICE_ROLE_KEY (the script then INSERTs
// it for you) or one paste into the Supabase SQL editor: the public anon key may
// only SELECT app_users.
import { createHash, randomBytes } from 'node:crypto';

const FUNCTION_URL = process.env.FUNCTION_URL || 'https://epfdtool.netlify.app/.netlify/functions/api';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));
const [username, password] = positional;

const usage = `Usage: npm run add-user -- <username> "<password>" [--hash] [--force] [--verify]
       npm run add-user -- --list

  --hash    store a salted SHA-256 hash instead of the readable password
  --force   replace the row when the username already exists
  --verify  only check that the login works; change nothing
  --list    print the accounts the deployed function can see

Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (optional),
     FUNCTION_URL (defaults to ${FUNCTION_URL})`;

const die = (message, code = 1) => {
  console.error(`${message}\n\n${usage}`);
  process.exit(code);
};

const json = async (res) => (res && res.ok ? res.json().catch(() => ({})) : {});

// --list needs no username and no local keys: the function reports its own view
// of app_users (account names only — never passwords).
if (flags.has('--list')) {
  const res = await fetch(`${FUNCTION_URL}?diag=1`).catch(() => null);
  const diag = await json(res);
  if (!diag.accounts) die(`Could not read the health check at ${FUNCTION_URL}?diag=1`);
  const acc = diag.accounts;
  console.log(`Accounts (${acc.source || 'app_users'}): ${acc.count ?? 0}`
    + `${acc.reachable === false ? `  [unreachable: ${acc.error}]` : ''}`);
  for (const user of acc.users || []) console.log(`  - ${user}`);
  const fb = acc.envFallbacks || {};
  console.log(`Env fallbacks: COMMENT_USERS accounts=${fb.commentUsers ?? 0}, ADMIN pair ${fb.adminPair ? 'set' : 'unset'}`);
  process.exit(0);
}

if (!username) die('Need a username.');
if (!/^[A-Za-z0-9._@-]{1,64}$/.test(username)) {
  die(`Username "${username}" may only contain letters, digits and . _ @ - (max 64 chars).`);
}
if (!password) die('Need a password.');

/** Supabase URL + keys: environment first, deployed function as the fallback. */
async function resolveConfig() {
  let url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  let anonKey = (process.env.SUPABASE_ANON_KEY || '').trim();
  let source = 'environment';
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (url && (anonKey || serviceKey)) return { url, anonKey, serviceKey, source };

  const res = await fetch(FUNCTION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify({ action: 'get-config' }),
  }).catch(() => null);
  const data = await json(res);
  url = url || String(data.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  anonKey = anonKey || String(data.SUPABASE_ANON_KEY || '').trim();
  source = `deployed function (${FUNCTION_URL})`;
  if (!url || (!anonKey && !serviceKey)) {
    die('Could not find the Supabase keys: export SUPABASE_URL and SUPABASE_ANON_KEY '
      + '(or SUPABASE_SERVICE_ROLE_KEY), or make sure the deployed function answers get-config.');
  }
  return { url, anonKey, serviceKey, source };
}
/** Logs in through the deployed function — exactly what the browser does. */
async function checkLogin() {
  const res = await fetch(FUNCTION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify({ action: 'login', username, password }),
  }).catch(() => null);
  if (!res) return { ok: false, detail: `could not reach ${FUNCTION_URL}` };
  const data = await json(res);
  const ok = res.status === 200 && data.success === true;
  return { ok, name: data.name, detail: `HTTP ${res.status} ${JSON.stringify(data)}` };
}

const config = await resolveConfig();
console.log(`Supabase: ${config.url}  (keys from ${config.source})`);

const authHeaders = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  apikey: config.serviceKey || config.anonKey,
  Authorization: `Bearer ${config.serviceKey || config.anonKey}`,
};
const userFilter = `username=eq.${encodeURIComponent(username)}`;

async function rest(path, init = {}) {
  const res = await fetch(`${config.url}/rest/v1/${path}`, { headers: authHeaders, ...init });
  const text = await res.text().catch(() => '');
  return { ok: res.ok, status: res.status, text };
}

const read = await rest(`app_users?select=username&${userFilter}&limit=1`);
let exists = false;
if (read.ok) {
  try { exists = JSON.parse(read.text || '[]').length > 0; } catch { exists = false; }
} else {
  console.log(`! Could not read app_users (HTTP ${read.status}): ${read.text.slice(0, 200).replace(/\s+/g, ' ')}`);
  console.log('  Run the app_users block from supabase.txt in the Supabase SQL editor first.');
}

if (flags.has('--verify')) {
  const result = await checkLogin();
  console.log(result.ok
    ? `OK — "${username}" can log in${result.name && result.name !== username ? ` (shown as ${result.name})` : ''}.`
    : `FAILED — "${username}" cannot log in: ${result.detail}`);
  process.exit(result.ok ? 0 : 1);
}

if (exists && !flags.has('--force')) {
  console.log(`"${username}" already exists in app_users — nothing changed.`);
  console.log('Re-run with --force to replace its password:');
  console.log(`  npm run add-user -- ${username} "<new password>" --force`);
  process.exit(2);
}

// Plain text keeps the table readable in the Supabase UI; --hash stores
// `salt:sha256hex`, which the function also understands and which stays safe
// even though the anon key can read this table.
let stored = password;
if (flags.has('--hash')) {
  const salt = randomBytes(8).toString('hex');
  stored = `${salt}:${createHash('sha256').update(`${salt}:${password}`).digest('hex')}`;
}
const style = flags.has('--hash') ? 'hashed' : 'plain text';

let wrote = false;
if (config.serviceKey) {
  const res = await rest(exists ? `app_users?${userFilter}` : 'app_users', {
    method: exists ? 'PATCH' : 'POST',
    headers: { ...authHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify({ username, password: stored }),
  });
  wrote = res.ok;
  console.log(res.ok
    ? `${exists ? 'Updated' : 'Added'} "${username}" with the ${style} password (service-role key).`
    : `! Write failed (HTTP ${res.status}): ${res.text.slice(0, 200).replace(/\s+/g, ' ')}`);
} else {
  const literal = (value) => `'${String(value).replace(/'/g, "''")}'`;
  console.log('\nPaste this into the Supabase SQL editor (the Table Editor cannot write it:');
  console.log('the public anon key may only SELECT app_users), then press Run:\n');
  console.log(`  insert into app_users (username, password) values (${literal(username)}, ${literal(stored)})`);
  console.log('  on conflict (username) do update set password = excluded.password;\n');
  console.log('Then confirm it works:');
  console.log(`  npm run add-user -- --verify ${username} "${password}"`);
}

if (wrote) {
  const result = await checkLogin();
  console.log(result.ok
    ? `Verified — "${username}" logs in${result.name && result.name !== username ? ` (shown as ${result.name})` : ''}, password stored as ${style}.`
    : `! Row was written but the login still fails: ${result.detail}`);
  console.log('See the accounts the function knows about with:');
  console.log('  npm run add-user -- --list');
  process.exit(result.ok ? 0 : 1);
}

