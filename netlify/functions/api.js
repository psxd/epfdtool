export default async (req, context) => {
  // 1. Handle CORS Preflight request from GitHub Pages
  if (req.method === 'OPTIONS') {
    return new Response('OK', {
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
    const { action, username, password, message } = body;

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
        // Generate/return a secure token (or JWT)
        const token = 'your-secure-auth-token-xyz';
        return new Response(JSON.stringify({ success: true, token }), { status: 200, headers: corsHeaders });
      } else {
        return new Response(JSON.stringify({ success: false }), { status: 401, headers: corsHeaders });
      }
    }

    // Action 3: Send Slack Notification (Protected)
    if (action === 'send-slack') {
      const authHeader = req.headers.get('authorization');
      
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return new Response(JSON.stringify({ error: 'Unauthorized: Missing token' }), { status: 401, headers: corsHeaders });
      }

      const token = authHeader.split(' ')[1];
      if (token !== 'your-secure-auth-token-xyz') {
        return new Response(JSON.stringify({ error: 'Forbidden: Invalid token' }), { status: 403, headers: corsHeaders });
      }

      // TODO: Add your Slack Webhook fetch logic here using process.env.SLACK_WEBHOOK_URL
      console.log('Sending message to Slack:', message);

      return new Response(JSON.stringify({ success: true, message: 'Sent!' }), { status: 200, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: 'Invalid action' }), { status: 400, headers: corsHeaders });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
};