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
      const validUser = process.env.ADMIN_USERNAME || 'admin';
      const validPass = process.env.ADMIN_PASSWORD || 'password';

      if (username === validUser && password === validPass) {
        // Derive a stateless token from the server-side secret (no literal
        // credential/token values in this public repository).
        const token = await signToken(username);
        return new Response(JSON.stringify({ success: true, token }), { status: 200, headers: corsHeaders });
      } else {
        return new Response(JSON.stringify({ success: false }), { status: 401, headers: corsHeaders });
      }
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