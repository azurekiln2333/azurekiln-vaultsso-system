// Account-first login: API regression coverage.
//
// Scope (frozen contract, research/implementation-contract.md):
//  - POST /oauth2/authorize { discover_account: true, username } -> next
//  - POST /api/email-verification/send { username, purpose: 'password_reset' }
//  - POST /api/password-reset { username, email_code, password, confirm_password }
//
// These tests deliberately never mint or expect a discovery token: the design is
// stateless and performing discovery is not an authorization prerequisite. Any
// test that fabricated a token would assert behaviour the design does not have.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { createFixture, randomSecret } = require('./support/fixture');

let f;
let Session;
let sessions;
let Token;
let tokens;

before(async () => {
  f = await createFixture();
  Session = require('../models/Session');
  sessions = new Session(f.pool);
  Token = require('../models/Token');
  tokens = new Token(f.pool);
});
beforeEach(() => f.reset());
after(async () => { if (f) await f.close(); });

// ── helpers ────────────────────────────────────────────────────────────────

function randomName(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

// Creates an account through the real model. `password: ''` is the documented
// "not set yet" marker, so this is the same representation imports/providers use.
async function createAccount({ password = '', email, emailVerified = true, banned = false } = {}) {
  const username = randomName('first');
  return f.User.create({
    username,
    email: email || `${username}@example.test`,
    password,
    emailVerified,
    banned
  });
}

function discover(username, extra = {}) {
  return f.request('/oauth2/authorize', {
    method: 'POST',
    data: { discover_account: true, username, ...extra }
  });
}

function sendSetupCode(username) {
  return f.request('/api/email-verification/send', {
    method: 'POST',
    data: { username, purpose: 'password_reset' }
  });
}

function submitSetup(username, code, password, confirmPassword) {
  return f.request('/api/password-reset', {
    method: 'POST',
    data: {
      username,
      email_code: code,
      password,
      confirm_password: confirmPassword === undefined ? password : confirmPassword
    }
  });
}

function storedUser(id) {
  return f.pool.users.find(row => row.id === id);
}

async function passwordMatches(id, candidate) {
  const row = storedUser(id);
  if (!row || !row.password) return false;
  return bcrypt.compare(candidate, row.password);
}

// Runs `submit()` while mutating stored account state immediately before the
// conditional first-password UPDATE reaches the database. The real SQL then
// executes against the changed row, so the route must observe zero affected
// rows from the CAS rather than from a pre-flight check.
async function submitWithRace(mutate, submit) {
  const hadOwnExecute = Object.prototype.hasOwnProperty.call(f.pool, 'execute');
  const originalExecute = f.pool.execute;
  let intercepted = 0;
  f.pool.execute = async (sql, params) => {
    if (/update users set /i.test(sql) && /password is null/i.test(sql)) {
      intercepted += 1;
      mutate();
    }
    return originalExecute.call(f.pool, sql, params);
  };
  try {
    return { result: await submit(), intercepted };
  } finally {
    if (hadOwnExecute) f.pool.execute = originalExecute;
    else delete f.pool.execute;
  }
}

// Grants a live session and access token so a later credential revocation would
// be observable on the pooled rows.
async function grantCredentials(account) {
  await sessions.create({ userId: account.id, token: randomSecret(), expiresAt: new Date(Date.now() + 3_600_000) });
  await tokens.createAccessToken({ userId: account.id, clientId: null, token: randomSecret(), scopes: [], expiresAt: new Date(Date.now() + 3_600_000) });
  assert.equal(f.pool.sessions.length, 1);
  assert.equal(f.pool.accessTokens.length, 1);
}

// ── discovery ──────────────────────────────────────────────────────────────

test('discovery selects the password step for an account that has a local password', async () => {
  const account = await f.user();
  const byUsername = await discover(account.username);
  assert.equal(byUsername.status, 200);
  assert.equal(byUsername.body.next, 'password');
  assert.equal(byUsername.body.email_masked, undefined);

  const byEmail = await discover(account.email);
  assert.equal(byEmail.status, 200);
  assert.equal(byEmail.body.next, 'password');
});

test('discovery selects set_password with only a masked destination for an unset password', async () => {
  const account = await createAccount();
  const result = await discover(account.username);
  assert.equal(result.status, 200);
  assert.equal(result.body.next, 'set_password');
  assert.match(result.body.email_masked, /\*{3}@example\.test$/);
  // The full stored address must never be projected.
  assert.equal(result.body.email, undefined);
  assert.ok(!JSON.stringify(result.body).includes(account.email));
  // Discovery must not authenticate the caller or start a session.
  assert.equal(result.cookie, '');
});

test('discovery treats a historical null password as unset', async () => {
  const account = await createAccount();
  storedUser(account.id).password = null;
  const result = await discover(account.username);
  assert.equal(result.status, 200);
  assert.equal(result.body.next, 'set_password');
});

test('discovery selects contact_admin for a placeholder mailbox without offering a destination', async () => {
  const account = await createAccount({ email: `${randomName('huawei')}@users.invalid` });
  const result = await discover(account.username);
  assert.equal(result.status, 200);
  assert.equal(result.body.next, 'contact_admin');
  assert.equal(result.body.email_masked, undefined);
});

test('discovery selects contact_admin for a stored value that is not a usable address', async () => {
  const account = await createAccount();
  storedUser(account.id).email = 'not-an-address';
  const result = await discover(account.username);
  assert.equal(result.status, 200);
  assert.equal(result.body.next, 'contact_admin');
  assert.equal(result.body.email_masked, undefined);
});

test('discovery reports genuinely missing identifiers and keeps ambiguous ones behind the password step', async () => {
  // Genuinely unknown username: explicit, immediate missing-account feedback.
  const missingUsername = await discover(randomName('nobody'));
  assert.equal(missingUsername.status, 404);
  assert.equal(missingUsername.body.error, 'account_not_found');
  assert.equal(missingUsername.body.error_key, 'auth.account_not_found');
  // No next step and no account metadata may ride along with the error.
  assert.equal(missingUsername.body.next, undefined);
  assert.equal(missingUsername.body.email_masked, undefined);
  assert.equal(missingUsername.body.exists, undefined);

  // Genuinely unknown email address: same feedback, still no destination disclosed.
  const missingEmail = await discover(`${randomName('nobody')}@example.test`);
  assert.equal(missingEmail.status, 404);
  assert.equal(missingEmail.body.error, 'account_not_found');
  assert.equal(missingEmail.body.error_key, 'auth.account_not_found');
  assert.equal(missingEmail.body.next, undefined);
  assert.equal(missingEmail.body.email_masked, undefined);

  // A username that collides with another account's email address makes the single-row
  // lookup return null, but the account genuinely exists. It must keep failing closed
  // through the password step instead of being reported nonexistent.
  const first = await createAccount();
  const collidingEmail = randomName('shared');
  const second = await createAccount({ email: `${collidingEmail}@example.test` });
  await f.User.update(first.id, { username: second.email });

  const ambiguous = await discover(second.email);
  assert.equal(ambiguous.status, 200);
  assert.equal(ambiguous.body.next, 'password');
  // Ambiguity selects no account: neither existence nor a destination may leak.
  assert.equal(ambiguous.body.error_key, undefined);
  assert.equal(ambiguous.body.email_masked, undefined);
  assert.equal(ambiguous.body.exists, undefined);
});

test('missing-account discovery has no side effects and never consumes a login attempt', async () => {
  const identifier = randomName('nobody');
  const attemptKeyHash = crypto.createHash('sha256').update(`login:${identifier.toLowerCase()}`).digest('hex');

  for (let index = 0; index < 6; index += 1) {
    const result = await discover(identifier);
    assert.equal(result.status, 404);
    assert.equal(result.body.error_key, 'auth.account_not_found');
    assert.ok(!result.cookie, 'a missing-account answer must not set any cookie');
  }

  assert.equal(f.mails.length, 0);
  assert.equal(f.pool.sessions.length, 0);
  assert.equal(f.pool.accessTokens.length, 0);
  assert.equal(f.pool.authCodes.length, 0);
  assert.equal(f.pool.emailVerificationCodes.length, 0);

  // Discovery only reads the lock, so the identifier's own attempt budget is untouched.
  // (The per-IP HTTP throttle writes a different key and is asserted by exclusion.)
  assert.ok(
    f.pool.rateLimits.every(row => row.rate_key !== attemptKeyHash),
    'missing-account discovery must not consume a login attempt'
  );
});

test('OAuth and lock errors take precedence over missing-account feedback', async () => {
  // Registered-but-invalid OAuth parameters are rejected before the missing-account branch.
  const unknown = randomName('nobody');
  const badOauth = await discover(unknown, {
    client_id: `client-${crypto.randomUUID()}`,
    redirect_uri: 'https://client.example.test/callback'
  });
  assert.equal(badOauth.status, 400);
  assert.equal(badOauth.body.error, 'invalid_client');
  assert.notEqual(badOauth.body.error_key, 'auth.account_not_found');

  // A locked identifier still reports the lock even though no account exists: the lock is
  // checked before the account lookup result is turned into feedback.
  const locked = randomName('nobody');
  for (let index = 0; index < 5; index += 1) {
    await f.request('/oauth2/authorize', {
      method: 'POST',
      data: { username: locked, password: randomSecret() }
    });
  }
  const lockedResult = await discover(locked);
  assert.equal(lockedResult.status, 429);
  assert.equal(lockedResult.body.error_key, 'auth.locked');
  assert.notEqual(lockedResult.body.error_key, 'auth.account_not_found');

  // The lock is evaluated first, so it outranks the OAuth validation error too.
  const lockedWithBadOauth = await discover(locked, {
    client_id: `client-${crypto.randomUUID()}`,
    redirect_uri: 'https://client.example.test/callback'
  });
  assert.equal(lockedWithBadOauth.status, 429);
  assert.equal(lockedWithBadOauth.body.error_key, 'auth.locked');
});

test('discovery never sends mail, issues credentials, or consumes a password attempt', async () => {
  const passwordless = await createAccount();
  for (let index = 0; index < 6; index += 1) {
    assert.equal((await discover(passwordless.username)).status, 200);
  }
  assert.equal(f.mails.length, 0);
  assert.equal(f.pool.sessions.length, 0);
  assert.equal(f.pool.accessTokens.length, 0);
  assert.equal(f.pool.authCodes.length, 0);
  assert.equal(f.pool.emailVerificationCodes.length, 0);

  // Repeated discovery must not burn the login attempt budget.
  const withPassword = await f.user();
  for (let index = 0; index < 6; index += 1) {
    assert.equal((await discover(withPassword.username)).status, 200);
  }
  const login = await f.login(withPassword);
  assert.equal(login.status, 200);
});

test('discovery preserves banned and locked account errors', async () => {
  const banned = await createAccount({ banned: true });
  const bannedResult = await discover(banned.username);
  assert.equal(bannedResult.status, 403);
  assert.equal(bannedResult.body.error_key, 'auth.account_banned');

  const locked = await f.user();
  for (let index = 0; index < 5; index += 1) {
    await f.request('/oauth2/authorize', {
      method: 'POST',
      data: { username: locked.username, password: randomSecret() }
    });
  }
  const lockedResult = await discover(locked.username);
  assert.equal(lockedResult.status, 429);
});

test('discovery still validates registered OAuth parameters when they are supplied', async () => {
  const app = await f.client();
  const account = await createAccount();

  const bad = await discover(account.username, {
    client_id: app.id,
    redirect_uri: 'https://attacker.example.test/callback'
  });
  assert.equal(bad.status, 400);

  // A complete original OAuth context (as the browser carries it) validates, and
  // discovery still cannot mint credentials from it.
  const verifier = randomSecret();
  const good = await discover(account.username, {
    client_id: app.id,
    redirect_uri: app.redirectUris[0],
    response_type: 'code',
    scope: 'openid profile email',
    state: randomSecret(),
    nonce: randomSecret(),
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256'
  });
  assert.equal(good.status, 200);
  assert.equal(good.body.next, 'set_password');
  assert.equal(good.body.redirect, undefined);
  assert.equal(good.cookie, '');
  assert.equal(f.pool.authCodes.length, 0);
});

// ── account-bound code sending ─────────────────────────────────────────────

test('account-bound send targets the stored address and honours the cooldown', async () => {
  const account = await createAccount();
  const sent = await sendSetupCode(account.username);
  assert.equal(sent.status, 200);
  assert.equal(sent.body.message_key, 'email_code.sent');
  assert.equal(f.mails.length, 1);
  assert.equal(f.mails[0].to, account.email);
  assert.equal(f.pool.emailVerificationCodes.length, 1);
  assert.equal(f.pool.emailVerificationCodes[0].user_id, account.id);
  assert.equal(f.pool.emailVerificationCodes[0].purpose, 'password_reset');

  const again = await sendSetupCode(account.username);
  assert.equal(again.status, 429);
  assert.equal(f.mails.length, 1);
});

test('account-bound send refuses dual identifiers and never mails a placeholder address', async () => {
  const account = await createAccount();
  const dual = await f.request('/api/email-verification/send', {
    method: 'POST',
    data: { username: account.username, email: account.email, purpose: 'password_reset' }
  });
  assert.equal(dual.status, 400);
  assert.equal(dual.body.error_key, 'auth.password.setup.invalid_identifier');
  assert.equal(f.mails.length, 0);

  const placeholder = await createAccount({ email: `${randomName('huawei')}@users.invalid` });
  const blocked = await sendSetupCode(placeholder.username);
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.error_key, 'auth.password.contact_admin');
  assert.equal(f.mails.length, 0);
  assert.equal(f.pool.emailVerificationCodes.length, 0);
});

test('account-bound send never mails an account that already has a password', async () => {
  const account = await f.user();
  const result = await sendSetupCode(account.username);
  // The response shape is intentionally not pinned here; the security invariant is
  // that no mail and no usable code are produced for an account that can already log in.
  assert.notEqual(result.status, 200);
  assert.equal(f.mails.length, 0);
  assert.equal(f.pool.emailVerificationCodes.length, 0);
});

test('account-bound send keeps the generic unknown-account response', async () => {
  const result = await sendSetupCode(randomName('nobody'));
  assert.equal(result.status, 200);
  assert.equal(result.body.message_key, 'email_code.sent');
  assert.equal(f.mails.length, 0);
  assert.equal(f.pool.emailVerificationCodes.length, 0);
});

// ── first-password submission ──────────────────────────────────────────────

test('first-password setup succeeds without any prior discovery and without a token', async () => {
  const account = await createAccount({ emailVerified: false });
  await sendSetupCode(account.username);
  const code = f.lastCode(account.email);

  // Deliberately no discover() call before this submit.
  const password = randomSecret();
  const result = await submitSetup(account.username, code, password);

  assert.equal(result.status, 200);
  assert.equal(result.body.message_key, 'auth.password_reset.updated');
  assert.ok(await passwordMatches(account.id, password));
  assert.equal(storedUser(account.id).email_verified, true);
  // Setup must not authenticate the user.
  assert.equal(result.cookie, '');
  assert.equal(f.pool.sessions.length, 0);
  assert.equal(f.pool.accessTokens.length, 0);
  assert.equal(f.pool.authCodes.length, 0);

  // The new password is now usable through the ordinary login path.
  const login = await f.request('/oauth2/authorize', {
    method: 'POST',
    data: { username: account.username, password }
  });
  assert.equal(login.status, 200);
});

test('first-password setup rejects wrong, expired, replayed and other-account codes', async () => {
  const account = await createAccount();
  await sendSetupCode(account.username);
  const code = f.lastCode(account.email);

  const wrong = await submitSetup(account.username, code === '000000' ? '111111' : '000000', randomSecret());
  assert.equal(wrong.status, 400);
  assert.equal(storedUser(account.id).password, '');

  // Another account's code cannot set this account's password.
  const other = await createAccount();
  const stolen = await submitSetup(other.username, code, randomSecret());
  assert.equal(stolen.status, 400);
  assert.equal(storedUser(other.id).password, '');

  // Expiry: age the pending record past its window.
  const record = f.pool.emailVerificationCodes.find(row => row.user_id === account.id && !row.consumed_at);
  record.expires_at = new Date(Date.now() - 60_000).toISOString();
  const expired = await submitSetup(account.username, code, randomSecret());
  assert.equal(expired.status, 400);
  assert.equal(storedUser(account.id).password, '');

  // Replay: a fresh code works once, then never again.
  record.expires_at = new Date(Date.now() + 600_000).toISOString();
  record.attempts = 0;
  const password = randomSecret();
  assert.equal((await submitSetup(account.username, code, password)).status, 200);
  const replay = await submitSetup(account.username, code, randomSecret());
  // The account now has a password, so the first-password-only gate reports a
  // state change. It must not consume the request as a generic invalid code and
  // it must not rewrite the password that was just established.
  assert.equal(replay.status, 409);
  assert.equal(replay.body.error_key, 'auth.password.setup_changed');
  assert.ok(await passwordMatches(account.id, password));
});

test('setup rejects dual identifiers and placeholder mailboxes', async () => {
  const account = await createAccount();
  await sendSetupCode(account.username);
  const code = f.lastCode(account.email);

  const dual = await f.request('/api/password-reset', {
    method: 'POST',
    data: { username: account.username, email: account.email, email_code: code, password: randomSecret() }
  });
  assert.equal(dual.status, 400);
  assert.equal(dual.body.error_key, 'auth.password.setup.invalid_identifier');
  assert.equal(storedUser(account.id).password, '');

  const placeholder = await createAccount({ email: `${randomName('huawei')}@users.invalid` });
  const blocked = await submitSetup(placeholder.username, '123456', randomSecret());
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.error_key, 'auth.password.contact_admin');
  assert.equal(storedUser(placeholder.id).password, '');
});

test('changing the account email after sending invalidates the pending setup', async () => {
  const account = await createAccount();
  await sendSetupCode(account.username);
  const code = f.lastCode(account.email);

  const replacement = `${randomName('moved')}@example.test`;
  await f.User.update(account.id, { email: replacement });

  const result = await submitSetup(account.username, code, randomSecret());
  assert.equal(result.status, 400);
  assert.equal(storedUser(account.id).password, '');
});

test('a password written concurrently with the conditional update is not overwritten and existing grants survive', async () => {
  const account = await createAccount();
  await sendSetupCode(account.username);
  const code = f.lastCode(account.email);
  await grantCredentials(account);

  const concurrentPassword = await bcrypt.hash(randomSecret(), 12);

  // The competing writer lands between this request's account read and its CAS.
  const { result, intercepted } = await submitWithRace(
    () => { storedUser(account.id).password = concurrentPassword; },
    () => submitSetup(account.username, code, randomSecret())
  );

  assert.equal(intercepted, 1, 'exactly one conditional UPDATE must execute');
  assert.equal(result.status, 409);
  assert.equal(result.body.error_key, 'auth.password.setup_changed');
  // Zero affected rows: the concurrent password is intact and nothing was revoked.
  assert.equal(storedUser(account.id).password, concurrentPassword);
  assert.equal(f.pool.sessions[0].revoked_at, null);
  assert.equal(f.pool.accessTokens.length, 1);
});

test('an email changed concurrently with the conditional update is not overwritten and existing grants survive', async () => {
  const account = await createAccount();
  await sendSetupCode(account.username);
  const code = f.lastCode(account.email);
  await grantCredentials(account);

  const replacement = `${randomName('moved')}@example.test`;

  const { result, intercepted } = await submitWithRace(
    () => { storedUser(account.id).email = replacement; },
    () => submitSetup(account.username, code, randomSecret())
  );

  assert.equal(intercepted, 1, 'exactly one conditional UPDATE must execute');
  assert.equal(result.status, 409);
  assert.equal(result.body.error_key, 'auth.password.setup_changed');
  // Zero affected rows: the concurrent email is intact and no password was written.
  assert.equal(storedUser(account.id).email, replacement);
  assert.equal(storedUser(account.id).password, '');
  assert.equal(f.pool.sessions[0].revoked_at, null);
  assert.equal(f.pool.accessTokens.length, 1);
});

test('setup rejects a confirmation mismatch without writing a password', async () => {
  const account = await createAccount();
  await sendSetupCode(account.username);
  const code = f.lastCode(account.email);

  const result = await submitSetup(account.username, code, randomSecret(), randomSecret());
  assert.equal(result.status, 400);
  assert.equal(result.body.error_key, 'validation.password.confirm_mismatch');
  assert.equal(storedUser(account.id).password, '');
});

test('the first-password flow works end to end with the account email as the identifier', async () => {
  const account = await createAccount();

  const sent = await sendSetupCode(account.email);
  assert.equal(sent.status, 200);
  assert.equal(f.mails.length, 1);
  assert.equal(f.mails[0].to, account.email);

  const code = f.lastCode(account.email);
  const password = randomSecret();
  const result = await submitSetup(account.email, code, password, password);
  assert.equal(result.status, 200);
  assert.equal(result.body.message_key, 'auth.password_reset.updated');
  assert.equal(result.cookie, '');
  assert.ok(await passwordMatches(account.id, password));

  // The new password is usable through the ordinary login path afterwards.
  const login = await f.request('/oauth2/authorize', {
    method: 'POST',
    data: { username: account.email, password }
  });
  assert.equal(login.status, 200);
});

// ── legacy contracts ───────────────────────────────────────────────────────

test('the email-based reset contract keeps its current semantics', async () => {
  const account = await f.user();
  await f.request('/api/email-verification/send', {
    method: 'POST',
    data: { email: account.email, purpose: 'password_reset' }
  });
  const password = randomSecret();
  const result = await f.request('/api/password-reset', {
    method: 'POST',
    data: { email: account.email, email_code: f.lastCode(account.email), password }
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.message_key, 'auth.password_reset.updated');
  assert.ok(await passwordMatches(account.id, password));
});

test('native check_verification and direct credential login are unchanged', async () => {
  const account = await f.user();

  const probe = await f.request('/oauth2/authorize', {
    method: 'POST',
    data: { username: account.username, password: account.clearPassword, check_verification: true }
  });
  assert.equal(probe.status, 200);
  assert.equal(probe.body.verification_required, true);
  assert.equal(f.pool.sessions.length, 0);

  // An empty password is still rejected before account lookup on the normal branch.
  const empty = await f.request('/oauth2/authorize', {
    method: 'POST',
    data: { username: account.username, password: '' }
  });
  assert.equal(empty.status, 400);

  const login = await f.login(account);
  assert.equal(login.status, 200);
  assert.equal(f.pool.sessions.length, 1);
});
