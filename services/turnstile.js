const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

async function verifyTurnstile({ token, secret, ip, hostname, action, fetchImpl = globalThis.fetch }) {
  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.set('remoteip', ip);

  let result;
  try {
    const response = await fetchImpl(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) return { ok: false, unavailable: true };
    result = await response.json();
  } catch {
    return { ok: false, unavailable: true };
  }

  return {
    ok: result?.success === true && (!hostname || result.hostname === hostname) && result.action === action,
    unavailable: false
  };
}

module.exports = { verifyTurnstile };
