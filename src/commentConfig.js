// Replace this with your actual Netlify live site URL
const NETLIFY_API_URL = 'https://epfdtool.netlify.app/.netlify/functions/api';

// Helper to grab the saved token from localStorage
function getAuthToken() {
  return localStorage.getItem('auth_token');
}

// 1. Fetch Supabase keys dynamically on load
export async function getSupabaseConfig() {
  const response = await fetch(NETLIFY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'get-config' })
  });
  return await response.json(); // Returns { SUPABASE_URL, SUPABASE_ANON_KEY }
}

// 2. Secure Login Check
export async function verifyLogin(username, password) {
  const response = await fetch(NETLIFY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'login', username, password })
  });
  const result = await response.json();
  
  // If login succeeds and returns a token, save it securely in localStorage
  if (result.success && result.token) {
    localStorage.setItem('auth_token', result.token);
  }
  
  return result.success;
}

// 3. Secure Slack Messenger (Now sends the auth token)
export async function sendSlackNotification(message) {
  const token = getAuthToken();

  const response = await fetch(NETLIFY_API_URL, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}` // Passing the auth token here
    },
    body: JSON.stringify({ action: 'send-slack', message })
  });

  if (!response.ok) {
    throw new Error('Unauthorized or failed to send notification.');
  }

  return await response.json();
}