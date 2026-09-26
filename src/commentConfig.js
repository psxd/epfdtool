// Netlify function endpoint. All secrets (Supabase keys, admin credentials,
// Slack webhook) live in Netlify env vars — never in this repo, which is
// public. Keep this URL pointing at the deployed function site.
const NETLIFY_API_URL = 'https://epfdtool.netlify.app/.netlify/functions/api';

// Helpers for the signed-in identity. The token is what the Netlify function
// validated; user/name are stored so a reload keeps attributing comments to the
// same account (and so multi-user deployments can show a friendly name).
function getAuthToken() {
  return localStorage.getItem('auth_token');
}

/** Canonical username of the last successful login ('' when signed out). */
export function getAuthUser() {
  return localStorage.getItem('auth_user') || '';
}

/** Friendly display name of the signed-in account (falls back to username). */
export function getAuthName() {
  return localStorage.getItem('auth_name') || getAuthUser();
}

function clearAuth() {
  localStorage.removeItem('auth_token');
  localStorage.removeItem('auth_user');
  localStorage.removeItem('auth_name');
}

// Every call is sent as a CORS "simple request": POST + text/plain body + no
// custom headers. Browsers then skip the OPTIONS preflight completely, so the
// GitHub Pages origin (psxd.github.io) can talk to Netlify without depending on
// the preflight handler. The server parses the JSON body regardless of the
// declared content type.
async function postAction(payload) {
  const response = await fetch(NETLIFY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* non-JSON error page */ }
  return { ok: response.ok, status: response.status, data };
}

/** Turn a failed response into a readable Error (used by callers that throw). */
function httpError(res, what) {
  const detail = (res.data && (res.data.error || res.data.message)) || '';
  return new Error(`${what} failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`);
}

// 1. Fetch Supabase keys dynamically on load
export async function getSupabaseConfig() {
  const res = await postAction({ action: 'get-config' });
  if (!res.ok) throw httpError(res, 'Config request');
  return res.data; // { SUPABASE_URL, SUPABASE_ANON_KEY }
}

// 2. Secure Login Check — returns false for wrong credentials, throws on a
// real failure (offline, function down) so the UI can tell the two apart.
export async function verifyLogin(username, password) {
  const res = await postAction({ action: 'login', username, password });
  if (res.status === 401 || res.status === 403) {
    clearAuth(); // don't keep a stale/foreign token
    return false;
  }
  if (!res.ok) throw httpError(res, 'Login');
  if (res.data && res.data.success && res.data.token) {
    // The function is the source of truth for the account's spelling and for
    // the friendly name shown in the UI.
    const user = res.data.username || username;
    localStorage.setItem('auth_token', res.data.token);
    localStorage.setItem('auth_user', user);
    localStorage.setItem('auth_name', res.data.name || user);
    return true;
  }
  return false;
}

// 3. Secure Slack Messenger — the token travels inside the JSON body (not an
// Authorization header) to keep the request preflight-free.
export async function sendSlackNotification(message) {
  const res = await postAction({ action: 'send-slack', message, token: getAuthToken() });
  if (!res.ok) throw httpError(res, 'Slack notification');
  return res.data;
}