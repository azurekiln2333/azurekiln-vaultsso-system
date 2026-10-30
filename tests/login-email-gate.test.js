'use strict';
// Password-login mailbox gate API regression suite.
//
// Contract: .trellis/tasks/10-23-account-first-login/research/login-email-gate-contract.md
// (frozen 2026-10-24). Every assertion below targets observable security behaviour — what a
// client can see and what the database ends up holding — not the internal helper shape.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createFixture, randomSecret } = require('./support/fixture');
const { failNextConsume, failNextInsert } = require('./support/memory-db');
const { totpCode } = require('./support/totp-code');

const SEND = '/api/v1/auth/oauth/oidc/email/send';
const COMPLETE = '/api/v1/auth/oauth/oidc/complete';
const PENDING = '/api/v1/auth/oauth/oidc/pending';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
const SYNTHETIC_SUFFIX = '@users.invalid';

let f;
before(async () => { f = await createFixture(); });
beforeEach(() => f.reset());
after(async () => { if (f) await f.close(); });

function enableEmailSwitch() {
  f.pool.settings.push({ setting_key: 'login_email_code', setting_value: 'true' });
}

// Every account below is created with an explicitly chosen mailbox/verification state because the
// whole point of the gate is that those two columns decide the login outcome.
async function makeAccount({ email, emailVerified = true, password = randomSecret(), role = 'user', withTotp = false } = {}) {
  const username = `gate-${crypto.randomUUID()}`;
  const address = email === undefined ? `${username}@example.test` : email;
  const record = await f.User.create({ username, email: address, password, role, emailVerified });
  if (withTotp) await f.User.update(record.id, { totpSecret: TOTP_SECRET, totpEnabled: true });
  return { ...record, clearPassword: password };
}

const unverifiedAccount = (extra = {}) => makeAccount({ emailVerified: false, ...extra });
const unboundAccount = (extra = {}) => makeAccount({
  email: `gate-${crypto.randomUUID()}${SYNTHETIC_SUFFIX}`, emailVerified: false, ...extra
});

// Credential surface that must stay empty until a gate actually completes.
function credentialCounts() {
  return {
    sessions: f.pool.sessions.length,
    accessTokens: f.pool.accessTokens.length,
    refreshTokens: f.pool.refreshTokens.length,
    authCodes: f.pool.authCodes.length
  };
}

// Simulates the mail cooldown window elapsing. Attempt budgets live on the persisted code row,
// not in the rate limiter, so clearing limits never weakens a brute-force assertion.
function elapseMailCooldown() { f.pool.rateLimits.length = 0; }

const sendGate = (cookie, data) => f.request(SEND, { method: 'POST', cookie, data });
const completeGate = (cookie, data) => f.request(COMPLETE, { method: 'POST', cookie, data });
const pendingGet = cookie => f.request(PENDING, { cookie });

function storedUser(id) { return f.User.findById(id); }

function setStored(id, patch) {
  Object.assign(f.pool.users.find(row => row.id === id), patch);
}

async function assertNoCredentialsBefore(baseline, message) {
  assert.deepEqual(credentialCounts(), baseline, message);
}

test('a verified mailbox keeps the existing password login and opens no gate', async () => {
  const account = await makeAccount();
  const login = await f.login(account);
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.equal(login.body.mfa_url, undefined, 'a verified mailbox must not be sent to the MFA page');
  assert.equal(login.body.email_gate, undefined);
  assert.equal(login.body.require_email_code, undefined);
  assert.notEqual(login.cookie, '');
  assert.equal(f.pool.sessions.length, 1);
});

test('the global email switch still governs a verified mailbox and never becomes a gate', async () => {
  enableEmailSwitch();
  const account = await makeAccount();
  const login = await f.login(account);
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.equal(login.body.mfa_url, '/oauth2/mfa');
  assert.equal(login.body.require_email_code, true);
  assert.equal(login.body.code_sent, true, 'the optional global factor still sends during stage creation');
  assert.equal(login.body.email_gate, undefined, 'a verified mailbox must never enter a mandatory gate');
  assert.equal((await pendingGet(login.cookie)).body.factor, 'email');
  assert.equal(f.pool.sessions.length, 0);
});

test('an unverified mailbox gates login on a manual mailbox proof and issues no credentials', async () => {
  const baseline = credentialCounts();
  const account = await unverifiedAccount();
  const login = await f.login(account);
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.equal(login.body.email_gate, 'verify');
  assert.equal(login.body.require_email_code, true);
  assert.equal(login.body.code_sent, false, 'the mandatory gate is always a manual send');
  assert.equal(login.body.mfa_url, '/oauth2/mfa');
  await assertNoCredentialsBefore(baseline, 'no session, token or authorization code before the gate completes');
  assert.equal((await f.request('/api/profile', { cookie: login.cookie })).status, 401);

  const projection = await pendingGet(login.cookie);
  assert.equal(projection.status, 200, JSON.stringify(projection.body));
  assert.equal(projection.body.factor, 'email_verify');
  assert.equal(projection.body.email_gate, 'verify');
  assert.equal(projection.body.mail_version, 0);
  assert.equal(projection.body.code_sent, false);
  assert.match(projection.body.email, /\*/, 'the projection may only show a masked mailbox');
});

test('a mandatory gate also satisfies the global switch without a second send', async () => {
  enableEmailSwitch();
  const account = await unverifiedAccount();
  const login = await f.login(account);
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.equal(login.body.email_gate, 'verify', 'the mandatory gate supersedes the optional factor');
  assert.equal(login.body.code_sent, false);
  assert.equal((await pendingGet(login.cookie)).body.factor, 'email_verify', 'no separate email factor may appear');
});

test('an unbound account offers mailbox binding and never displays the synthetic placeholder', async () => {
  const baseline = credentialCounts();
  const account = await unboundAccount();
  const login = await f.login(account);
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.equal(login.body.email_gate, 'bind');
  assert.equal(login.body.require_email_code, true);
  assert.equal(login.body.code_sent, false);
  await assertNoCredentialsBefore(baseline, 'binding must not issue credentials');

  const projection = await pendingGet(login.cookie);
  assert.equal(projection.status, 200, JSON.stringify(projection.body));
  assert.equal(projection.body.factor, 'email_bind');
  assert.equal(projection.body.email_gate, 'bind');
  assert.equal(projection.body.mail_version, 0);
  assert.equal(projection.body.email, '', 'the @users.invalid placeholder must not leak, even masked');
});

test('a corrupt verified flag on an unusable mailbox is still treated as unbound', async () => {
  const account = await makeAccount({ email: `gate-${crypto.randomUUID()}${SYNTHETIC_SUFFIX}`, emailVerified: true });
  const login = await f.login(account);
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.equal(login.body.email_gate, 'bind', 'email_verified=true cannot make an unusable mailbox usable');
  assert.equal(f.pool.sessions.length, 0);
});

test('a NULL email_verified counts as unverified and requires proof', async () => {
  const account = await makeAccount({ emailVerified: true });
  setStored(account.id, { email_verified: null });
  const login = await f.login(account);
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.equal(login.body.email_gate, 'verify', 'NULL verification must not be read as verified');
  assert.equal(f.pool.sessions.length, 0);
});

test('a wrong password discloses no gate, sends no mail and is indistinguishable by state', async () => {
  const verified = await makeAccount();
  const unverified = await unverifiedAccount();
  const unbound = await unboundAccount();
  for (const account of [verified, unverified, unbound]) {
    const attempts = await f.login({ username: account.username, clearPassword: 'definitely-not-it' });
    assert.equal(attempts.status, 401, JSON.stringify(attempts.body));
    assert.equal(attempts.body.email_gate, undefined);
    assert.equal(attempts.body.require_email_code, undefined);
  }
  assert.equal(f.pool.sessions.length, 0);
  assert.deepEqual(f.pool.emailVerificationCodes, [], 'a failed password must not create a pending stage');
});

test('sending requires the current mail version and simultaneous sends elect exactly one winner', async () => {
  const account = await unboundAccount();
  const login = await f.login(account);
  const target = `bound-${crypto.randomUUID()}@example.test`;

  // The version must equal the persisted integer. Whether a missing version is classified as a
  // malformed request or a stale conflict is not frozen, so assert the security-relevant outcome:
  // the send is refused and nothing is reserved or delivered.
  const unversioned = await sendGate(login.cookie, { email: target });
  assert.ok([400, 409].includes(unversioned.status), `an unversioned send must be refused (got ${unversioned.status})`);
  const refusedProjection = await pendingGet(login.cookie);
  assert.equal(refusedProjection.body.mail_version, 0, 'a refused send must not advance the version');
  assert.equal(refusedProjection.body.code_sent, false, 'a refused send must not deliver a code');

  const [first, second] = await Promise.all([
    sendGate(login.cookie, { email: target, expected_mail_version: 0 }),
    sendGate(login.cookie, { email: target, expected_mail_version: 0 })
  ]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [200, 409], 'concurrent same-version sends must resolve to one winner');
  const winner = first.status === 200 ? first : second;
  assert.equal(winner.body.mail_version, 1, 'the winning send advances the version exactly once');
  assert.equal(winner.body.code_sent, true);
});

test('retargeting invalidates the previous proof and advances the version', async () => {
  const account = await unboundAccount();
  const login = await f.login(account);
  const firstTarget = `first-${crypto.randomUUID()}@example.test`;
  const secondTarget = `second-${crypto.randomUUID()}@example.test`;

  const first = await sendGate(login.cookie, { email: firstTarget, expected_mail_version: 0 });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const staleCode = f.lastCode(firstTarget);

  elapseMailCooldown();
  const second = await sendGate(login.cookie, { email: secondTarget, expected_mail_version: 1 });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.mail_version, 2);

  const stale = await completeGate(login.cookie, { code: staleCode, expected_mail_version: 2 });
  assert.equal(stale.status, 400, 'a superseded proof must not complete after a retarget');

  const boundAddress = (await storedUser(account.id)).email;
  assert.equal(boundAddress, account.email, 'nothing may be bound by a stale proof');
});

test('binding to an address another account already owns fails without any write', async () => {
  const owner = await makeAccount();
  const account = await unboundAccount();
  const login = await f.login(account);
  const before = await storedUser(account.id);

  const attempt = await sendGate(login.cookie, { email: owner.email, expected_mail_version: 0 });
  assert.ok([400, 409].includes(attempt.status), `expected a conflict, got ${attempt.status}`);
  assert.equal(attempt.body.error_key?.startsWith('auth.'), true, JSON.stringify(attempt.body));

  const after = await storedUser(account.id);
  assert.equal(after.email, before.email, 'the target mailbox must not be bound');
  assert.ok(!after.email_verified, 'a rejected bind must not verify the account');
  assert.equal((await storedUser(owner.id)).email, owner.email, "another account's mailbox is untouched");
  assert.equal(f.pool.sessions.length, 0);
});

test('the verify stage proves the stored mailbox only and rejects a substituted destination', async () => {
  const account = await unverifiedAccount();
  const login = await f.login(account);
  const substitute = `substitute-${crypto.randomUUID()}@example.test`;

  const rejected = await sendGate(login.cookie, { email: substitute, expected_mail_version: 0 });
  assert.ok([400, 409].includes(rejected.status),
    `the verify stage must not honour a client-supplied destination (got ${rejected.status})`);

  const accepted = await sendGate(login.cookie, { expected_mail_version: 0 });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal((await storedUser(account.id)).email, account.email, 'verifying must not rewrite the mailbox');
});

test('completion requires the current version and the exact code and keeps the attempt budget on resend', async () => {
  const account = await unboundAccount();
  const login = await f.login(account);
  const target = `budget-${crypto.randomUUID()}@example.test`;
  const sent = await sendGate(login.cookie, { email: target, expected_mail_version: 0 });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const version = sent.body.mail_version;
  const code = f.lastCode(target);

  const stale = await completeGate(login.cookie, { code, expected_mail_version: version - 1 });
  assert.equal(stale.status, 409, 'completion must reject a stale mail version');

  // The parent challenge keeps a five-attempt budget. Spend the whole budget, then resend, then
  // confirm the sixth attempt is still locked: a resend must not reset the brute-force budget.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const wrong = await completeGate(login.cookie, { code: '000000', expected_mail_version: version });
    assert.equal(wrong.status, 400, `attempt ${attempt + 1}: ${JSON.stringify(wrong.body)}`);
  }
  elapseMailCooldown();
  const resend = await sendGate(login.cookie, { email: target, expected_mail_version: version });
  assert.equal(resend.status, 200, JSON.stringify(resend.body));
  const locked = await completeGate(login.cookie, { code: '000000', expected_mail_version: resend.body.mail_version });
  assert.equal(locked.status, 429, 'the budget must survive a resend');
  assert.equal(locked.body.error_key, 'auth.mfa.locked');
  assert.equal(f.pool.sessions.length, 0);
});

test('security state changes invalidate the pending gate', async () => {
  const failures = [];
  for (const [label, mutate] of [
    ['password', id => setStored(id, { password: `mutated-${randomSecret()}` })],
    ['mailbox', id => setStored(id, { email: `moved-${crypto.randomUUID()}@example.test` })],
    // A real Boolean flip. false -> NULL would leave Boolean(email_verified) unchanged and is
    // therefore correctly *not* a security-state change; false -> true must invalidate.
    ['verification flag', id => setStored(id, { email_verified: true })],
    ['role', id => setStored(id, { role: 'admin' })],
    ['ban', id => setStored(id, { banned: true })],
    ['totp enrollment', id => setStored(id, { totp_enabled: true, totp_secret: TOTP_SECRET })],
    ['authenticator revision', id => setStored(id, { totp_revision: 1 })]
  ]) {
    f.reset();
    const account = await unverifiedAccount();
    const login = await f.login(account);
    assert.equal(login.status, 200, `${label}: ${JSON.stringify(login.body)}`);
    await mutate(account.id);
    const projection = await pendingGet(login.cookie);
    if (projection.status !== 401) failures.push(`${label}: GET /pending returned ${projection.status}`);
    else if (projection.body.error_key !== 'auth.mfa.expired') failures.push(`${label}: GET /pending key ${projection.body.error_key}`);
    const attempt = await sendGate(login.cookie, { expected_mail_version: 0 });
    if (attempt.status !== 401) failures.push(`${label}: send returned ${attempt.status}`);
    else if (attempt.body.error_key !== 'auth.mfa.expired') failures.push(`${label}: send key ${attempt.body.error_key}`);
  }
  // Every dimension in pendingLoginSecurityState must invalidate a live gate on both entry points.
  // Collect all mismatches so a single defect cannot hide the others.
  assert.deepEqual(failures, [], failures.join('; '));
});

test('a successful verify marks the mailbox verified atomically and issues the session', async () => {
  const account = await unverifiedAccount();
  const login = await f.login(account);
  const sent = await sendGate(login.cookie, { expected_mail_version: 0 });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const code = f.lastCode(account.email);

  const finished = await completeGate(login.cookie, { code, expected_mail_version: sent.body.mail_version });
  assert.equal(finished.status, 200, JSON.stringify(finished.body));
  assert.equal((await f.request('/api/profile', { cookie: finished.cookie })).status, 200);
  assert.equal(f.pool.sessions.length, 1);

  const stored = await storedUser(account.id);
  assert.ok(stored.email_verified, 'proof must persist email_verified');
  assert.equal(stored.email, account.email, 'verify must not move the mailbox');
});

test('a successful bind stores the new mailbox and the next login needs no gate', async () => {
  const account = await unboundAccount();
  const login = await f.login(account);
  const target = `bound-${crypto.randomUUID()}@example.test`;
  const sent = await sendGate(login.cookie, { email: target, expected_mail_version: 0 });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));

  const finished = await completeGate(login.cookie, { code: f.lastCode(target), expected_mail_version: sent.body.mail_version });
  assert.equal(finished.status, 200, JSON.stringify(finished.body));

  const stored = await storedUser(account.id);
  assert.equal(stored.email, target, 'the bound mailbox must be persisted');
  assert.ok(stored.email_verified, 'a bound mailbox is verified by construction');

  const again = await f.login({ username: account.username, clearPassword: account.clearPassword });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.email_gate, undefined, 'the gate must not reappear once the mailbox is bound');
});

test('a consumed proof cannot be replayed', async () => {
  const account = await unverifiedAccount();
  const login = await f.login(account);
  const sent = await sendGate(login.cookie, { expected_mail_version: 0 });
  const code = f.lastCode(account.email);
  const first = await completeGate(login.cookie, { code, expected_mail_version: sent.body.mail_version });
  assert.equal(first.status, 200, JSON.stringify(first.body));

  const replay = await completeGate(login.cookie, { code, expected_mail_version: sent.body.mail_version });
  assert.ok([400, 401].includes(replay.status), `replay must fail, got ${replay.status}`);
  assert.equal(f.pool.sessions.length, 1, 'a replay must never mint a second session');
});

test('accounts without a password keep the existing setup and administrator guidance', async () => {
  // Passwordless accounts are discovered, not logged in: `password: ''` is the documented
  // "not set yet" marker, so the gate must never apply to them.
  const discover = username => f.request('/oauth2/authorize', { method: 'POST', data: { discover_account: true, username } });

  const setupPassword = await makeAccount({ password: '' });
  const setup = await discover(setupPassword.username);
  assert.equal(setup.status, 200, JSON.stringify(setup.body));
  assert.equal(setup.body.next, 'set_password', 'a usable mailbox keeps the initial-password setup');
  assert.equal(setup.body.email_gate, undefined, 'the first-password path is not a mailbox gate');

  const contactAdmin = await makeAccount({ email: `gate-${crypto.randomUUID()}${SYNTHETIC_SUFFIX}`, password: '' });
  const guidance = await discover(contactAdmin.username);
  assert.equal(guidance.status, 200, JSON.stringify(guidance.body));
  assert.equal(guidance.body.next, 'contact_admin', 'an unbound passwordless account still routes to the administrator');
  assert.equal(guidance.body.email_gate, undefined, 'it is not a mailbox gate');
});

// ── B3: the password proof deadline is absolute ───────────────────────────────

test('a resend or retarget never extends the original password proof deadline', async () => {
  const account = await unboundAccount();
  const login = await f.login(account);
  const parent = () => f.pool.emailVerificationCodes.find(row => row.purpose === 'password_mfa');
  // The adapter stores pending_context as an object; MySQL returns a string. Accept both, exactly
  // like the server's readPendingContext.
  const deadline = () => {
    const raw = parent().pending_context;
    return (typeof raw === 'string' ? JSON.parse(raw) : raw).proofExpiresAt;
  };
  const original = deadline();
  assert.ok(Number.isFinite(original) && original > Date.now(), 'the parent must persist a proof deadline');

  const first = await sendGate(login.cookie, { email: `d1-${crypto.randomUUID()}@example.test`, expected_mail_version: 0 });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(deadline(), original, 'a send must not move the proof deadline');

  elapseMailCooldown();
  const second = await sendGate(login.cookie, { email: `d2-${crypto.randomUUID()}@example.test`, expected_mail_version: first.body.mail_version });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(deadline(), original, 'a retarget must not move the proof deadline');

  // No issued proof may outlive the original password proof either.
  const issued = f.pool.emailVerificationCodes.filter(row => row.purpose === 'login_gate');
  assert.ok(issued.length > 0, 'the sends must have issued gate codes');
  for (const row of issued) {
    assert.ok(new Date(row.expires_at).getTime() <= original, 'a gate code must not outlive the password proof');
  }
});

// ── B4: mail limits are per target *and* per challenge ───────────────────────

test('one target mailbox is rate-limited across separate account challenges', async () => {
  // B4: the send route must not let unrelated account challenges hammer one mailbox. The account
  // cooldown is per challenge; the target cooldown has to be consumed as well.
  const shared = `shared-${crypto.randomUUID()}@example.test`;
  const one = await f.login(await unboundAccount());
  const two = await f.login(await unboundAccount());

  const a = await sendGate(one.cookie, { email: shared, expected_mail_version: 0 });
  assert.equal(a.status, 200, JSON.stringify(a.body));

  const b = await sendGate(two.cookie, { email: shared, expected_mail_version: 0 });
  assert.equal(b.status, 429, 'one target mailbox must be rate-limited across account challenges');
  assert.equal(b.body.error_key, 'auth.email_gate.cooldown');
  assert.equal(f.pool.sessions.length, 0);
});

// ── B5: native header transport and origin boundary ───────────────────────────

test('native clients can send with X-Oidc-Pending while foreign browser origins stay rejected', async () => {
  const account = await unboundAccount();
  const login = await f.login(account);
  const token = decodeURIComponent(login.cookie.match(/oidc_pending=([^;]+)/)[1]);

  // A cookie-less native client identifies itself with the header and no browser Origin.
  const native = await f.request(SEND, {
    method: 'POST', headers: { 'X-Oidc-Pending': token, Origin: '' },
    data: { email: `native-${crypto.randomUUID()}@example.test`, expected_mail_version: 0 }
  });
  assert.equal(native.status, 200, JSON.stringify(native.body));

  elapseMailCooldown();
  const foreign = await f.request(SEND, {
    method: 'POST', headers: { 'X-Oidc-Pending': token, Origin: 'https://evil.example.test' },
    data: { email: `evil-${crypto.randomUUID()}@example.test`, expected_mail_version: native.body.mail_version }
  });
  assert.equal(foreign.status, 403, 'a foreign browser origin must not use the send route');
});

// ── B8: a late zero-row consume must roll back an already-accepted factor ─────

test('a zero-row parent consume rolls back an already-accepted TOTP factor', async () => {
  // A verified mailbox means no gate: the completion goes straight through the TOTP factor, which
  // is the non-gate branch B8 describes.
  const account = await makeAccount({ withTotp: true });
  setStored(account.id, { totp_last_counter: -1 });
  const login = await f.login(account);
  assert.equal(login.body.require_totp, true, JSON.stringify(login.body));

  const parent = f.pool.emailVerificationCodes.find(row => row.purpose === 'password_mfa');
  assert.ok(parent, 'the TOTP stage must have a persisted parent pending');
  const code = totpCode(TOTP_SECRET);
  const counterBefore = storedUser(account.id).totp_last_counter;

  // Make the parent consume report zero rows *after* the TOTP factor was accepted.
  failNextConsume(parent.id);
  const failed = await completeGate(login.cookie, { code });
  assert.notEqual(failed.status, 200, 'a zero-row parent consume must never complete the login');
  assert.equal(f.pool.sessions.length, 0, 'no session may be committed');
  assert.equal(storedUser(account.id).totp_last_counter, counterBefore,
    'the accepted TOTP counter must roll back with the parent consume');

  // Because the factor rolled back instead of being consumed, the very same code still works.
  // If it had been committed, this replay would be rejected and the user would be locked out of
  // a code they legitimately hold.
  const retry = await completeGate(login.cookie, { code });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(f.pool.sessions.length, 1, 'the retry must issue exactly one session');
});

async function waitFor(predicate, message, timeout = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

const rawContext = value => (typeof value === 'string' ? JSON.parse(value) : value);

// ── B6: reserved version/target under delayed and failing SMTP ───────────────

test('a delayed send reports its own reserved version and target, not a newer one', async () => {
  const account = await unboundAccount();
  const login = await f.login(account);
  const slowTarget = `slow-${crypto.randomUUID()}@example.test`;
  const fastTarget = `fast-${crypto.randomUUID()}@example.test`;

  const hold = f.holdNextMail();
  const slow = sendGate(login.cookie, { email: slowTarget, expected_mail_version: 0 });
  await waitFor(() => f.blockedMailCount() > 0, 'the first delivery never reached SMTP');

  elapseMailCooldown();
  const fast = await sendGate(login.cookie, { email: fastTarget, expected_mail_version: 1 });
  assert.equal(fast.status, 200, JSON.stringify(fast.body));
  assert.equal(fast.body.mail_version, 2);

  hold.release();
  const delayed = await slow;
  assert.equal(delayed.status, 200, JSON.stringify(delayed.body));
  assert.equal(delayed.body.sent, true);
  assert.equal(delayed.body.mail_version, 1,
    'the delayed response must report the version it reserved, not the newer one');
  assert.ok(f.lastCode(slowTarget), 'the delayed attempt must deliver to its own target');
  assert.ok(f.lastCode(fastTarget), 'the later attempt must deliver to its own target');
});

test('a failed delayed delivery consumes only its own proof and leaves the newer one usable', async () => {
  const account = await unboundAccount();
  const login = await f.login(account);
  const slowTarget = `fail-${crypto.randomUUID()}@example.test`;
  const keepTarget = `keep-${crypto.randomUUID()}@example.test`;

  const hold = f.holdNextMail();
  const slow = sendGate(login.cookie, { email: slowTarget, expected_mail_version: 0 });
  await waitFor(() => f.blockedMailCount() > 0, 'the first delivery never reached SMTP');

  elapseMailCooldown();
  const fast = await sendGate(login.cookie, { email: keepTarget, expected_mail_version: 1 });
  assert.equal(fast.status, 200, JSON.stringify(fast.body));
  const keepCode = f.lastCode(keepTarget);

  hold.fail(Object.assign(new Error('smtp down'), { status: 502, code: 'smtp.test_failed' }));
  const delayed = await slow;
  assert.equal(delayed.status, 502, JSON.stringify(delayed.body));
  // The exact delivery-failure key is not frozen (p3 currently maps it to email_delivery_failed);
  // the security property is the reserved version, the false code_sent, and the surviving newer proof.
  assert.ok(['smtp.test_failed', 'email_delivery_failed'].includes(delayed.body.error_key),
    `a failed delivery must report a delivery failure (got ${delayed.body.error_key})`);
  assert.equal(delayed.body.mail_version, 1, 'a failed send must echo the version it reserved');
  assert.equal(delayed.body.code_sent, false, 'a failed send must not claim a delivered code');

  // The failure consumed only the delayed attempt's own row, so the newer proof still completes.
  const finished = await completeGate(login.cookie, { code: keepCode, expected_mail_version: fast.body.mail_version });
  assert.equal(finished.status, 200, JSON.stringify(finished.body));
  assert.equal(f.pool.sessions.length, 1);
});

// ── B7: native next_step rotation ────────────────────────────────────────────

test('the TOTP to gate transition returns a rotated credential usable by cookie-less clients', async () => {
  const account = await makeAccount({ withTotp: true, emailVerified: false });
  setStored(account.id, { totp_last_counter: -1 });
  const login = await f.login(account);
  assert.equal(login.body.require_totp, true, JSON.stringify(login.body));
  const initialToken = login.body.pending_token;
  assert.ok(initialToken, 'the initial stage must also expose its credential in the body');
  assert.equal(login.body.pending_header, 'X-Oidc-Pending');

  const step = await f.request(COMPLETE, {
    method: 'POST', headers: { 'X-Oidc-Pending': initialToken, Origin: '' },
    data: { code: totpCode(TOTP_SECRET) }
  });
  assert.equal(step.status, 200, JSON.stringify(step.body));
  assert.equal(step.body.next_step, true);
  assert.equal(step.body.mfa_url, '/oauth2/mfa');
  assert.equal(step.body.factor, 'email_verify', JSON.stringify(step.body));
  const rotated = step.body.pending_token;
  assert.ok(rotated, 'the intermediate response must return the successor credential');
  assert.notEqual(rotated, initialToken, 'the successor must be a different credential');
  assert.equal(f.pool.sessions.length, 0, 'the intermediate stage must not issue a session');

  // The consumed predecessor must no longer authorise anything. It is rejected either as an
  // unsupported stage (its factor is still 'totp') or as an expired credential — never accepted.
  const mailsBefore = f.mails.length;
  const staleSend = await f.request(SEND, {
    method: 'POST', headers: { 'X-Oidc-Pending': initialToken, Origin: '' },
    data: { expected_mail_version: 0 }
  });
  assert.ok([400, 401].includes(staleSend.status), `the consumed predecessor must be rejected (got ${staleSend.status})`);
  assert.equal(f.mails.length, mailsBefore, 'a consumed predecessor must never trigger a delivery');

  // The rotated credential is the one a cookie-less client can actually continue with.
  const rotatedSend = await f.request(SEND, {
    method: 'POST', headers: { 'X-Oidc-Pending': rotated, Origin: '' },
    data: { expected_mail_version: 0 }
  });
  assert.equal(rotatedSend.status, 200, JSON.stringify(rotatedSend.body));
  assert.equal(rotatedSend.body.mail_version, 1);
});

// ── B8 (recovery variant): zero-row consume must roll back a recovery code ────

test('a zero-row parent consume rolls back an already-accepted recovery code', async () => {
  const RECOVERY_CODE = 'ABCD-1234-EFGH-5678';
  const normalized = RECOVERY_CODE.replace(/[^A-Z0-9]/g, '');
  const hash = crypto.createHash('sha256').update(normalized).digest('hex');

  const account = await makeAccount({ withTotp: true });
  setStored(account.id, { totp_last_counter: -1, recovery_codes: JSON.stringify([hash]) });
  const login = await f.login(account);
  assert.equal(login.body.require_totp, true, JSON.stringify(login.body));
  const parent = f.pool.emailVerificationCodes.find(row => row.purpose === 'password_mfa');
  const before = storedUser(account.id).recovery_codes;

  failNextConsume(parent.id);
  const failed = await completeGate(login.cookie, { code: RECOVERY_CODE });
  assert.notEqual(failed.status, 200, 'a zero-row parent consume must never complete the login');
  assert.equal(f.pool.sessions.length, 0);
  assert.equal(storedUser(account.id).recovery_codes, before,
    'the accepted recovery code must roll back with the parent consume');

  // Because it rolled back, the same recovery code still works on retry.
  const retry = await completeGate(login.cookie, { code: RECOVERY_CODE });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(f.pool.sessions.length, 1);
});

// ── B3 (transition half): the successor stage is bounded by the original ─────

test('the TOTP to gate transition never outlives the original password proof', async () => {
  const account = await makeAccount({ withTotp: true, emailVerified: false });
  setStored(account.id, { totp_last_counter: -1 });
  const login = await f.login(account);
  assert.equal(login.body.require_totp, true, JSON.stringify(login.body));

  const parents = () => f.pool.emailVerificationCodes.filter(row => row.purpose === 'password_mfa');
  const original = parents().at(-1);
  const originalExpiry = new Date(original.expires_at).getTime();
  const originalProof = rawContext(original.pending_context).proofExpiresAt;
  assert.ok(Number.isFinite(originalProof),
    'every password-source stage must persist its proof deadline, including the TOTP stage');

  const step = await completeGate(login.cookie, { code: totpCode(TOTP_SECRET) });
  assert.equal(step.status, 200, JSON.stringify(step.body));
  assert.equal(step.body.next_step, true, JSON.stringify(step.body));

  const successor = parents().at(-1);
  assert.notEqual(successor.id, original.id, 'the transition must persist a successor stage');
  assert.ok(new Date(successor.expires_at).getTime() <= originalExpiry,
    'the successor stage must not outlive the original pending');
  const successorProof = rawContext(successor.pending_context).proofExpiresAt;
  assert.ok(Number.isFinite(successorProof) && successorProof <= originalProof,
    'the successor must not extend the original password proof deadline');
  assert.equal(rawContext(successor.pending_context).totpSatisfied, true,
    'the successor must record that the authenticator prerequisite was satisfied');
});

// ── entry-point closure: probe and direct submission cannot bypass ──────────

test('the native probe and the direct authorize path cannot bypass the mailbox gate', async () => {
  const account = await unverifiedAccount();
  const probe = await f.request('/oauth2/authorize', { method: 'POST', data: {
    username: account.username, password: account.clearPassword, check_verification: true
  } });
  assert.equal(probe.status, 200, JSON.stringify(probe.body));
  assert.equal(probe.body.verification_required, true);
  assert.equal(probe.body.factor, 'email_verify');
  assert.equal(probe.body.email_gate, 'verify');
  assert.equal(probe.body.code_sent, false, 'the probe must never send a mandatory gate code');
  assert.equal(f.pool.sessions.length, 0);
  assert.equal(f.pool.emailVerificationCodes.length, 0, 'the probe must not create a stage');
  assert.equal(f.mails.length, 0, 'the probe must not send mail');

  // An unbound account is reported as needing a bind, without exposing the placeholder.
  const unbound = await unboundAccount();
  const bindProbe = await f.request('/oauth2/authorize', { method: 'POST', data: {
    username: unbound.username, password: unbound.clearPassword, check_verification: true
  } });
  assert.equal(bindProbe.status, 200, JSON.stringify(bindProbe.body));
  assert.equal(bindProbe.body.factor, 'email_bind');
  assert.equal(bindProbe.body.email_gate, 'bind');
  assert.equal(bindProbe.body.email_masked, undefined, 'the placeholder must never be masked into the probe');
  assert.equal(f.mails.length, 0);

  // A client that skips the UI and posts a code straight to the login endpoint still gets gated.
  const direct = await f.request('/oauth2/authorize', { method: 'POST', data: {
    username: account.username, password: account.clearPassword, email_code: '123456'
  } });
  assert.notEqual(direct.status, 302, 'the direct path must not mint an authorization code');
  assert.equal(direct.body.email_gate, 'verify', JSON.stringify(direct.body));
  assert.equal(f.pool.sessions.length, 0);
  assert.equal(f.pool.authCodes.length, 0);
});

// ── direct path: a failed successor must roll back the supplied factor ────────

test('a failed direct successor insert rolls back the supplied recovery code', async () => {
  // Direct /oauth2/authorize with an inline factor for an unverified mailbox: after the factor is
  // accepted the server must create the gate stage in the SAME account transaction, so a failed
  // successor insert cannot leave the factor consumed. A recovery code is used rather than a TOTP
  // code because its one-shot state is directly observable (no 30s window), so the assertion is
  // deterministic instead of order- or clock-dependent.
  const RECOVERY_CODE = 'WXYZ-2345-MNPQ-6789';
  const hash = crypto.createHash('sha256').update(RECOVERY_CODE.replace(/[^A-Z0-9]/g, '')).digest('hex');
  const account = await makeAccount({ withTotp: true, emailVerified: false });
  setStored(account.id, { totp_last_counter: -1, recovery_codes: JSON.stringify([hash]) });
  const before = storedUser(account.id).recovery_codes;

  failNextInsert('email_verification_codes');
  const attempt = await f.login(account, { totp_code: RECOVERY_CODE });
  assert.ok(attempt.status >= 400, `a failed direct successor must not succeed (got ${attempt.status})`);
  assert.equal(f.pool.sessions.length, 0, 'no session may survive a rolled-back direct successor');
  assert.equal(storedUser(account.id).recovery_codes, before,
    'the accepted direct recovery code must roll back with the successor insert');

  // Because the factor rolled back, the very same recovery code still advances to the gate.
  const retry = await f.login(account, { totp_code: RECOVERY_CODE });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.ok(['bind', 'verify'].includes(retry.body.email_gate), JSON.stringify(retry.body));
  assert.equal(f.pool.sessions.length, 0, 'the gate stage is not a credential');
});

// ── raw version typing: coercion must never be accepted ──────────────────────

test('a send version must be a raw non-negative integer, not a coercible value', async () => {
  // Number(null) === 0, Number(false) === 0 and Number('') === 0 all pass Number.isInteger, so a
  // coercion bug would accept every one of these as version 0.
  for (const malformed of [null, false, true, '', '0', '1', 1.5, -1]) {
    f.reset();
    const account = await unboundAccount();
    const login = await f.login(account);
    const target = `raw-${crypto.randomUUID()}@example.test`;

    const send = await sendGate(login.cookie, { email: target, expected_mail_version: malformed });
    assert.ok([400, 409].includes(send.status),
      `send expected_mail_version=${JSON.stringify(malformed)} must be rejected (got ${send.status})`);
    assert.equal(f.mails.length, 0, `send ${JSON.stringify(malformed)} must not deliver mail`);
    const projection = await pendingGet(login.cookie);
    assert.equal(projection.body.mail_version, 0,
      `send ${JSON.stringify(malformed)} must not advance the version`);
    assert.equal(projection.body.code_sent, false,
      `send ${JSON.stringify(malformed)} must not reserve a code`);
  }
});

test('a completion version must be a raw non-negative integer, not a coercible value', async () => {
  // Here the persisted version is 1, so only values that coerce to 1 (true, '1') would sneak through.
  for (const malformed of [true, '1', null, false, '']) {
    f.reset();
    const account = await unverifiedAccount();
    const login = await f.login(account);
    const sent = await sendGate(login.cookie, { expected_mail_version: 0 });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.mail_version, 1);
    const code = f.lastCode(account.email);

    const attempt = await completeGate(login.cookie, { code, expected_mail_version: malformed });
    assert.ok([400, 409].includes(attempt.status),
      `complete expected_mail_version=${JSON.stringify(malformed)} must be rejected (got ${attempt.status})`);
    assert.equal(f.pool.sessions.length, 0,
      `complete ${JSON.stringify(malformed)} must not issue a session`);
  }
});

// ── B12: Express is case-insensitive, so the security boundary must be too ───

const SEND_VARIANTS = [
  '/api/v1/auth/oauth/oidc/email/send',
  '/API/V1/AUTH/OAUTH/OIDC/EMAIL/SEND',
  '/Api/V1/Auth/Oauth/Oidc/Email/Send',
  '/api/v1/auth/oauth/oidc/email/send/'
];

const COMPLETE_VARIANTS = [
  '/api/v1/auth/oauth/oidc/complete',
  '/API/V1/AUTH/OAUTH/OIDC/COMPLETE',
  '/Api/V1/Auth/Oauth/Oidc/Complete',
  '/api/v1/auth/oauth/oidc/complete/'
];

test('case and trailing-slash variants of the send route cannot bypass the origin boundary', async () => {
  for (const variant of SEND_VARIANTS) {
    f.reset();
    const account = await unboundAccount();
    const login = await f.login(account);
    const token = decodeURIComponent(login.cookie.match(/oidc_pending=([^;]+)/)[1]);
    const mailsBefore = f.mails.length;

    const hostile = await f.request(variant, {
      method: 'POST', headers: { 'X-Oidc-Pending': token, Origin: 'https://evil.example.test' },
      data: { email: `evil-${crypto.randomUUID()}@example.test`, expected_mail_version: 0 }
    });
    assert.equal(hostile.status, 403,
      `${variant}: a foreign origin must be rejected (got ${hostile.status})`);
    assert.equal(f.mails.length, mailsBefore, `${variant}: a rejected request must not send mail`);
    assert.equal(f.pool.sessions.length, 0, `${variant}: no session may be issued`);
    assert.equal(f.pool.authCodes.length, 0, `${variant}: no authorization code may be issued`);
    const projection = await pendingGet(login.cookie);
    assert.equal(projection.body.mail_version, 0, `${variant}: the boundary must run before the version guard`);
  }
});

test('case and trailing-slash variants of the complete route cannot bypass the origin boundary', async () => {
  for (const variant of COMPLETE_VARIANTS) {
    f.reset();
    const account = await unverifiedAccount();
    const login = await f.login(account);
    const sent = await sendGate(login.cookie, { expected_mail_version: 0 });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const code = f.lastCode(account.email);

    const hostile = await f.request(variant, {
      method: 'POST', headers: { Origin: 'https://evil.example.test' }, cookie: login.cookie,
      data: { code, expected_mail_version: sent.body.mail_version }
    });
    assert.equal(hostile.status, 403,
      `${variant}: a foreign origin must be rejected (got ${hostile.status})`);
    assert.equal(f.pool.sessions.length, 0, `${variant}: no session may be issued`);
    assert.equal(f.pool.authCodes.length, 0, `${variant}: no authorization code may be issued`);
    // The proof must still be usable afterwards: the boundary rejected the request before consuming it.
    const legit = await completeGate(login.cookie, { code, expected_mail_version: sent.body.mail_version });
    assert.equal(legit.status, 200, `${variant}: the rejected request must not consume the proof`);
  }
});

test('native clients keep working across case and trailing-slash variants', async () => {
  for (const variant of SEND_VARIANTS) {
    f.reset();
    const account = await unboundAccount();
    const login = await f.login(account);
    const token = decodeURIComponent(login.cookie.match(/oidc_pending=([^;]+)/)[1]);

    const native = await f.request(variant, {
      method: 'POST', headers: { 'X-Oidc-Pending': token, Origin: '' },
      data: { email: `native-${crypto.randomUUID()}@example.test`, expected_mail_version: 0 }
    });
    assert.equal(native.status, 200,
      `${variant}: a native client must still be able to send (got ${native.status})`);
    assert.equal(native.body.mail_version, 1, `${variant}: the machine allowance must reach the handler`);
  }
});

test('native clients can complete across case and trailing-slash variants', async () => {
  for (const variant of COMPLETE_VARIANTS) {
    f.reset();
    const account = await unverifiedAccount();
    const login = await f.login(account);
    const token = decodeURIComponent(login.cookie.match(/oidc_pending=([^;]+)/)[1]);

    const sent = await f.request(SEND, {
      method: 'POST', headers: { 'X-Oidc-Pending': token, Origin: '' },
      data: { expected_mail_version: 0 }
    });
    assert.equal(sent.status, 200, `${variant}: ${JSON.stringify(sent.body)}`);
    const code = f.lastCode(account.email);

    // Cookie-less continuation: the rotated header credential, no browser Origin.
    const done = await f.request(variant, {
      method: 'POST', headers: { 'X-Oidc-Pending': sent.body.pending_token, Origin: '' },
      data: { code, expected_mail_version: sent.body.mail_version }
    });
    assert.equal(done.status, 200, `${variant}: ${JSON.stringify(done.body)}`);
    assert.match(done.cookie, /session=/, `${variant}: a native completion must issue a session credential`);
    assert.equal(f.pool.sessions.filter(row => !row.revoked_at).length, 1, `${variant}: exactly one session`);
  }
});

// ── atomic completion and challenge binding, kept as permanent regressions ────

test('two simultaneous completions with the same exact proof issue at most one session', async () => {
  const account = await unverifiedAccount();
  const login = await f.login(account);
  const sent = await sendGate(login.cookie, { expected_mail_version: 0 });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const code = f.lastCode(account.email);

  const [first, second] = await Promise.all([
    completeGate(login.cookie, { code, expected_mail_version: sent.body.mail_version }),
    completeGate(login.cookie, { code, expected_mail_version: sent.body.mail_version })
  ]);
  const winners = [first, second].filter(response => response.status === 200);
  assert.equal(winners.length, 1, `exactly one completion may win (got ${first.status}/${second.status})`);
  assert.equal(f.pool.sessions.length, 1, 'at most one session may be issued');
  assert.equal(f.pool.sessions.filter(row => !row.revoked_at).length, 1, 'no duplicated usable credential');
});

test('a final session insert failure rolls back the mailbox change and both proof consumptions', async () => {
  const account = await unboundAccount();
  const login = await f.login(account);
  const target = `bound-${crypto.randomUUID()}@example.test`;
  const sent = await sendGate(login.cookie, { email: target, expected_mail_version: 0 });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const code = f.lastCode(target);
  const parentId = f.pool.emailVerificationCodes.find(row => row.purpose === 'password_mfa').id;

  // Fail the very last write: the issued session. Everything before it must roll back.
  failNextInsert('sessions');
  const failed = await completeGate(login.cookie, { code, expected_mail_version: sent.body.mail_version });
  assert.notEqual(failed.status, 200, 'a failed final session insert must not report success');
  assert.doesNotMatch(failed.cookie, /session=/, 'no success cookie may be emitted');
  assert.equal(f.pool.sessions.length, 0, 'no session row may survive');

  const stored = await storedUser(account.id);
  assert.equal(stored.email, account.email, 'the mailbox bind must roll back');
  assert.ok(!stored.email_verified, 'verification must roll back');
  assert.ok(!f.pool.emailVerificationCodes.find(row => row.id === parentId).consumed_at,
    'the parent pending must not be consumed');
  assert.ok(!f.pool.emailVerificationCodes.find(row => row.purpose === 'login_gate' && row.email === target).consumed_at,
    'the gate proof must not be consumed');

  // The identical proof must still work, and now complete the bind.
  const retry = await completeGate(login.cookie, { code, expected_mail_version: sent.body.mail_version });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal((await storedUser(account.id)).email, target, 'the retry must persist the bind');
  assert.equal(f.pool.sessions.filter(row => !row.revoked_at).length, 1);
});

test('a proof from a separate pending for the same account cannot complete another challenge', async () => {
  // Same account, two independent pendings: this isolates parent/codeId binding rather than
  // account binding. Account binding is covered by the cross-account checks elsewhere.
  const account = await unverifiedAccount();
  const loginA = await f.login(account);
  const loginB = await f.login(account);
  assert.notEqual(loginA.cookie, loginB.cookie, 'each login must carry its own pending');
  const parentIds = f.pool.emailVerificationCodes.filter(row => row.purpose === 'password_mfa').map(row => row.id);
  assert.equal(parentIds.length, 2, 'the same account must hold two distinct pending challenges');

  const sentA = await sendGate(loginA.cookie, { expected_mail_version: 0 });
  assert.equal(sentA.status, 200, JSON.stringify(sentA.body));
  const codeA = f.lastCode(account.email);

  // Only the mail cooldown elapses; both challenges live on the same stored mailbox.
  elapseMailCooldown();
  const sentB = await sendGate(loginB.cookie, { expected_mail_version: 0 });
  assert.equal(sentB.status, 200, JSON.stringify(sentB.body));
  const codeB = f.lastCode(account.email);
  assert.notEqual(codeA, codeB, 'the two challenges must hold different codes');

  // B's code must not complete A's challenge even though destination and version match.
  const cross = await completeGate(loginA.cookie, { code: codeB, expected_mail_version: sentA.body.mail_version });
  assert.ok([400, 401].includes(cross.status), `a foreign proof must be rejected (got ${cross.status})`);
  assert.doesNotMatch(cross.cookie, /session=/);
  assert.equal(f.pool.sessions.length, 0, 'no session may be issued for a foreign proof');

  // A's own proof is untouched and still completes.
  const own = await completeGate(loginA.cookie, { code: codeA, expected_mail_version: sentA.body.mail_version });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal(f.pool.sessions.filter(row => !row.revoked_at).length, 1);
});

test('a target claimed after sending conflicts and leaves the original state intact', async () => {
  const account = await unboundAccount();
  const login = await f.login(account);
  const target = `contested-${crypto.randomUUID()}@example.test`;
  const sent = await sendGate(login.cookie, { email: target, expected_mail_version: 0 });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const code = f.lastCode(target);
  const parentId = f.pool.emailVerificationCodes.find(row => row.purpose === 'password_mfa').id;
  const gateRow = f.pool.emailVerificationCodes.find(row => row.purpose === 'login_gate' && row.email === target);

  // Another account claims the target between sending and completion.
  const rival = await f.User.create({
    username: `rival-${crypto.randomUUID()}`, email: target, password: randomSecret(), emailVerified: true
  });

  const conflict = await completeGate(login.cookie, { code, expected_mail_version: sent.body.mail_version });
  assert.ok([409, 400].includes(conflict.status), `a claimed target must conflict (got ${conflict.status})`);
  assert.doesNotMatch(conflict.cookie, /session=/);
  assert.equal(f.pool.sessions.length, 0, 'no credential may be issued on conflict');

  const stored = await storedUser(account.id);
  assert.equal(stored.email, account.email, 'the original (unbound) mailbox must be intact');
  assert.equal((await storedUser(rival.id)).email, target, "the rival's mailbox must be untouched");
  assert.ok(!f.pool.emailVerificationCodes.find(row => row.id === parentId).consumed_at,
    'the parent pending must not be consumed');
  assert.ok(!f.pool.emailVerificationCodes.find(row => row.id === gateRow.id).consumed_at,
    'the gate proof must not be consumed');
});
