const { spawn } = require('child_process');

const PORT = Number(process.env.E2E_PORT || 3199);
const BASE_URL = `http://127.0.0.1:${PORT}`;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function parseCookies(headers) {
  const cookies = headers.getSetCookie ? headers.getSetCookie() : [];
  return cookies.map(cookie => cookie.split(';')[0]).join('; ');
}

async function request(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    redirect: 'manual',
    ...options,
    headers: {
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  return { response, text };
}

async function waitForServer() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10000) {
    try {
      const { response } = await request('/.well-known/openid-configuration');
      if (response.status === 200) {
        return;
      }
    } catch (error) {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw new Error('Server did not start in time');
}

async function runChecks() {
  const discovery = await request('/.well-known/openid-configuration');
  assert(discovery.response.status === 200, 'Discovery endpoint should return 200');
  const metadata = JSON.parse(discovery.text);
  assert(metadata.code_challenge_methods_supported.includes('S256'), 'Discovery should advertise PKCE S256');

  const login = await request('/oauth2/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=demo%40vaultsso.com&password=demo123'
  });
  assert(login.response.status === 200, 'Demo login should return 200');
  const cookie = parseCookies(login.response.headers);
  assert(cookie.includes('session='), 'Demo login should set a session cookie');

  const clients = await request('/api/clients', {
    headers: { Cookie: cookie }
  });
  assert(clients.response.status === 200, 'Admin client list should return 200');
  const clientList = JSON.parse(clients.text);
  assert(clientList.some(client => client.id === 'salesforce-prod'), 'Demo clients should include salesforce-prod');

  const authorize = await request('/oauth2/authorize?response_type=code&client_id=salesforce-prod&redirect_uri=http%3A%2F%2Flocalhost%3A3146%2Fcallback&scope=openid%20profile%20email&state=e2e', {
    headers: { Cookie: cookie }
  });
  assert(authorize.response.status >= 300 && authorize.response.status < 400, 'Authorize should redirect with a code');
  const location = authorize.response.headers.get('location');
  const redirectUrl = new URL(location);
  const code = redirectUrl.searchParams.get('code');
  assert(code, 'Authorize redirect should include a code');

  const token = await request('/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'http://localhost:3146/callback',
      client_id: 'salesforce-prod',
      client_secret: 'salesforce-secret'
    }).toString()
  });
  assert(token.response.status === 200, 'Token endpoint should exchange authorization code');
  const tokenPayload = JSON.parse(token.text);
  assert(tokenPayload.access_token, 'Token response should include access_token');
  assert(tokenPayload.id_token, 'Token response should include id_token');

  const userinfo = await request('/oauth2/userinfo', {
    headers: { Authorization: `Bearer ${tokenPayload.access_token}` }
  });
  assert(userinfo.response.status === 200, 'UserInfo should return 200 for access token');
  const userinfoPayload = JSON.parse(userinfo.text);
  assert(userinfoPayload.email === 'demo@vaultsso.com', 'UserInfo should return demo user email');

  const introspect = await request('/oauth2/introspect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: tokenPayload.access_token }).toString()
  });
  assert(introspect.response.status === 200, 'Introspection should return 200');
  assert(JSON.parse(introspect.text).active === true, 'Introspection should mark access token active');
}

async function main() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DB_DRIVER: 'memory',
      PORT: String(PORT),
      PUBLIC_BASE_URL: BASE_URL
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });

  try {
    await waitForServer();
    await runChecks();
    console.log('E2E checks passed');
  } catch (error) {
    console.error(output);
    throw error;
  } finally {
    child.kill('SIGTERM');
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
