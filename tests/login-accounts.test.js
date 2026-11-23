const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { createFixture } = require('./support/fixture');

// Browser account chooser contract: [.trellis/spec/backend/browser-accounts.md]
// A real isolated service issues the real cookies. `Jar` models a browser cookie jar so the
// cookie-handling rules (per-entry deadline, active-cookie-only clearing) are exercised the way a
// browser would observe them instead of by calling an internal helper.

let f;
before(async () => { f = await createFixture(); });
beforeEach(() => f.reset());
after(async () => { if (f) await f.close(); });

const ACCOUNTS = '/api/auth/accounts';
const MAX_SAVED = 5;

class Jar {
  constructor() { this.cookies = new Map(); }

  // Applies Set-Cookie lines exactly like a browser: a value replaces, and an expired/removed
  // cookie (Expires in the past or Max-Age=0) deletes the entry.
  absorb(response) {
    for (const header of response.headers.getSetCookie()) {
      const [pair, ...attributes] = header.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      const expires = attributes.map(item => item.trim()).find(item => /^expires=/i.test(item));
      const maxAge = attributes.map(item => item.trim()).find(item => /^max-age=/i.test(item));
      const removed = (maxAge && Number(maxAge.split('=')[1]) <= 0)
        || (expires && new Date(expires.split('=').slice(1).join('=')) <= new Date());
      if (!value || removed) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }

  get header() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  get(name) { return this.cookies.get(name); }
  has(name) { return this.cookies.has(name); }
}

async function jarRequest(jar, route, options = {}) {
  const result = await f.request(route, { ...options, cookie: jar.header || undefined });
  return jar.absorb(result);
}

function claims(jar, name = 'session') {
  const value = jar.get(name);
  assert.ok(value, `expected a ${name} cookie`);
  return jwt.verify(decodeURIComponent(value), process.env.JWT_SECRET);
}

function sessionRow(sid) {
  return f.pool.sessions.find(row => row.token === sid) || null;
}

function activeRowIds() {
  return f.pool.sessions.filter(row => !row.revoked_at).map(row => row.token).sort();
}

async function signIn(jar, account, extra = {}) {
  const result = await jarRequest(jar, '/oauth2/authorize', { method: 'POST',
    data: { username: account.username, password: account.clearPassword, ...extra } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result;
}

async function listAccounts(jar) {
  const result = await jarRequest(jar, ACCOUNTS);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result;
}

function assertSafeProjection(result, accounts) {
  // Safe display metadata only. No credential material may reach the JSON body.
  for (const account of accounts) {
    assert.deepEqual(Object.keys(account).sort(), ['current', 'id', 'name', 'username']);
    assert.equal(typeof account.id, 'string');
    assert.equal(typeof account.username, 'string');
    assert.equal(typeof account.current, 'boolean');
    assert.ok(account.name === null || typeof account.name === 'string');
  }
  const body = JSON.stringify(result.body);
  for (const secret of ['eyJ', 'session', 'browser_accounts', 'token', 'sid', 'password', 'sub']) {
    assert.ok(!body.includes(secret), `account list leaked ${secret}: ${body}`);
  }
}

function assertRosterCookie(jar) {
  const response = jar.has('browser_accounts');
  assert.ok(response, 'the chooser keeps its own signed roster cookie');
  return jar.get('browser_accounts');
}

test('a cookie jar signs in A, adds B, and switches back to A with A\'s original sid and deadline', async () => {
  const a = await f.user();
  const b = await f.user();
  const jar = new Jar();

  await signIn(jar, a, { session_days: 7 });
  const aClaims = claims(jar);
  assert.equal(aClaims.sub, a.id);
  const aRow = sessionRow(aClaims.sid);
  assert.ok(aRow);
  const aExpiry = new Date(aRow.expires_at).getTime();
  const aCreatedAt = new Date(aRow.created_at).toISOString();

  // Add B without logging A out. Both cookies move to B.
  await signIn(jar, b, { session_days: 14 });
  const bClaims = claims(jar);
  assert.equal(bClaims.sub, b.id);
  assert.notEqual(bClaims.sid, aClaims.sid);
  assert.ok(sessionRow(aClaims.sid), 'adding B must not revoke A\'s session');
  assert.equal(sessionRow(aClaims.sid).revoked_at, null);

  const listed = await listAccounts(jar);
  assertSafeProjection(listed, listed.body.accounts);
  assert.equal(listed.body.accounts.length, 2);
  assert.equal(listed.body.currentAccountId, b.id);
  assert.deepEqual(listed.body.accounts.map(item => item.id), [b.id, a.id], 'most recently used first');
  assert.deepEqual(listed.body.accounts.map(item => item.current), [true, false]);
  assert.equal(listed.headers.get('cache-control'), 'no-store');

  // Switch to A: only the selection changes; no new row, no renewed lifetime.
  const before = f.pool.sessions.length;
  const switched = await jarRequest(jar, `${ACCOUNTS}/switch`, { method: 'POST', data: { accountId: a.id } });
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  assert.equal(switched.body.accountId, a.id);
  const restored = claims(jar);
  assert.equal(restored.sub, a.id);
  assert.equal(restored.sid, aClaims.sid, 'switching restores the existing session, not a new one');
  assert.equal(restored.exp, aClaims.exp);
  assert.equal(f.pool.sessions.length, before, 'switching must not create a session row');
  const aRowAfter = sessionRow(aClaims.sid);
  assert.equal(new Date(aRowAfter.expires_at).getTime(), aExpiry, 'switching must not extend A');
  assert.equal(new Date(aRowAfter.created_at).toISOString(), aCreatedAt,
    'switching must not invent a recent authentication time');

  const profile = await jarRequest(jar, '/api/profile');
  assert.equal(profile.status, 200);
  assert.equal(profile.body.user.id, a.id);
  const afterList = await listAccounts(jar);
  assert.equal(afterList.body.currentAccountId, a.id);
  assert.deepEqual(afterList.body.accounts.map(item => item.id), [a.id, b.id], 'selection is most recent');
});

test('switching to A keeps A\'s exact expiry through the authenticated request and later activity', async () => {
  const a = await f.user();
  const b = await f.user();
  const jar = new Jar();
  await signIn(jar, a, { session_days: 1 });
  const aClaims = claims(jar);
  await signIn(jar, b, { session_days: 14 });
  f.pool.sessions.find(row => row.token === aClaims.sid).created_at = new Date(Date.now() - 6 * 60 * 1000);
  const switched = await jarRequest(jar, `${ACCOUNTS}/switch`, { method: 'POST', data: { accountId: a.id } });
  assert.equal(switched.status, 200);
  const profile = await jarRequest(jar, '/api/profile');
  assert.equal(profile.status, 200);
  assert.equal(profile.body.user.id, a.id);
  assert.equal(claims(jar).exp, aClaims.exp, 'neither switch nor profile activity renews the fixed session');
});

test('a legacy browser with only the active session cookie is enrolled and listed', async () => {
  const account = await f.user();
  const login = await f.login(account, { session_days: 7 });
  // Reconstruct exactly the pre-existing browser state: only the session cookie.
  const jar = new Jar();
  for (const header of login.headers.getSetCookie()) {
    const [pair, ...attributes] = header.split(';');
    const name = pair.slice(0, pair.indexOf('=')).trim();
    if (name === 'session') jar.cookies.set(name, pair.slice(pair.indexOf('=') + 1).trim());
    else if (name !== 'browser_accounts' && !attributes.some(item => /^max-age=0/i.test(item.trim()))) {
      jar.cookies.delete(name);
    }
  }
  assert.ok(jar.has('session'));
  assert.ok(!jar.has('browser_accounts'), 'a legacy browser starts without a roster');

  const listed = await listAccounts(jar);
  assert.equal(listed.body.accounts.length, 1);
  assert.equal(listed.body.accounts[0].id, account.id);
  assert.equal(listed.body.accounts[0].current, true);
  assert.equal(listed.body.currentAccountId, account.id);
  assert.ok(jar.has('browser_accounts'), 'listing enrolls the pre-existing session');

  // Enrollment is not a re-authentication: the stored sid/expiry are unchanged.
  const original = claims(jar);
  const row = sessionRow(original.sid);
  assert.equal(new Date(row.expires_at).getTime(), original.exp * 1000);
});

test('the empty browser lists no accounts and can still sign in normally', async () => {
  const jar = new Jar();
  const listed = await listAccounts(jar);
  assert.deepEqual(listed.body.accounts, []);
  assert.equal(listed.body.currentAccountId, null);
  assert.equal(listed.headers.get('cache-control'), 'no-store');
  assert.equal(f.pool.sessions.length, 0, 'listing must never create a session');

  const account = await f.user();
  await signIn(jar, account);
  assert.equal(claims(jar).sub, account.id);
  assert.equal((await listAccounts(jar)).body.accounts.length, 1);
});

test('the roster is bounded to five most recent accounts and evicts without revoking other sessions', async () => {
  const accounts = [];
  const jar = new Jar();
  for (let index = 0; index < MAX_SAVED + 2; index += 1) {
    const account = await f.user();
    accounts.push(account);
    await signIn(jar, account, { session_days: 1 });
  }
  const listed = await listAccounts(jar);
  assert.equal(listed.body.accounts.length, MAX_SAVED, 'at most five saved accounts');
  assert.deepEqual(listed.body.accounts.map(item => item.id), accounts.slice(-MAX_SAVED).reverse().map(item => item.id));
  assert.equal(listed.body.currentAccountId, accounts.at(-1).id);

  // Evicted entries were forgotten from the list, not revoked in the database.
  assert.equal(f.pool.sessions.filter(row => !row.revoked_at).length, accounts.length,
    'eviction from the roster must not revoke another session');

  const roster = assertRosterCookie(jar);
  assert.ok(Buffer.byteLength(`browser_accounts=${roster}`) < 4096, 'the roster must stay within cookie limits');
});

test('signing in again as an existing account de-duplicates its entry instead of adding a second row', async () => {
  const a = await f.user();
  const b = await f.user();
  const jar = new Jar();
  await signIn(jar, a);
  await signIn(jar, b);
  const firstA = claims(jar);
  await signIn(jar, a);
  const secondA = claims(jar);
  const listed = await listAccounts(jar);
  assert.equal(listed.body.accounts.length, 2);
  assert.deepEqual(listed.body.accounts.map(item => item.id), [a.id, b.id]);
  const aEntries = listed.body.accounts.filter(item => item.id === a.id);
  assert.equal(aEntries.length, 1);
  // The single entry follows the newest credential for that user.
  assert.equal(JSON.stringify(listed.body).includes(firstA.sid), false, 'no session identifier may be exposed');
  const switched = await jarRequest(jar, `${ACCOUNTS}/switch`, { method: 'POST', data: { accountId: a.id } });
  assert.equal(switched.status, 200);
  assert.equal(claims(jar).sid, secondA.sid);
});

test('unknown, forged and malformed account IDs fail closed without changing the active account', async () => {
  const a = await f.user();
  const outsider = await f.user();
  const jar = new Jar();
  await signIn(jar, a);
  const activeClaims = claims(jar);

  // A real user ID that this browser never authenticated is not selectable.
  for (const accountId of [outsider.id, crypto.randomUUID(), '', '  ', 'null', 0, null, [], {}]) {
    const result = await jarRequest(jar, `${ACCOUNTS}/switch`, { method: 'POST', data: { accountId } });
    assert.equal(result.status, 401, `switch ${JSON.stringify(accountId)} -> ${result.status}`);
    assert.equal(result.body.error_key, 'auth.required');
    assert.ok(result.body.error_description);
    assert.equal(claims(jar).sid, activeClaims.sid);
  }
  // Remove is equally strict: nothing is revoked for an unknown ID.
  for (const accountId of [outsider.id, crypto.randomUUID(), '', null, []]) {
    const result = await jarRequest(jar, `${ACCOUNTS}/remove`, { method: 'POST', data: { accountId } });
    assert.ok([400, 401, 404].includes(result.status), `remove ${JSON.stringify(accountId)} -> ${result.status}`);
    assert.equal(sessionRow(activeClaims.sid).revoked_at, null);
  }
  const listed = await listAccounts(jar);
  assert.deepEqual(listed.body.accounts.map(item => item.id), [a.id]);
});

test('a tampered roster grants no authority and the independent active session stays authoritative', async () => {
  const a = await f.user();
  const b = await f.user();
  const jar = new Jar();
  await signIn(jar, a);
  await signIn(jar, b);
  // B is the most recent completed login, so B is the active account and the independent
  // authoritative cookie the tampered roster must not override.
  const activeClaims = claims(jar);
  assert.equal(activeClaims.sub, b.id);
  const roster = assertRosterCookie(jar);

  // Tampering must keep the three-part JWS structure so the test exercises the signature and the
  // payload separately; a two-part string would only prove that malformed data is ignored.
  const parts = roster.split('.');
  assert.equal(parts.length, 3, 'the roster is a three-part signed token');
  const [header, payload, signature] = parts;
  const flipTail = value => `${value.slice(0, -2)}${value.endsWith('AA') ? 'BB' : 'AA'}`;
  const decodeSegment = value => JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  const encodeSegment = value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  // A payload edit must stay well-formed JSON with a plausible claim change; random byte flipping
  // could merely corrupt the encoding, which would prove nothing about signature coverage.
  const tamperedClaims = decodeSegment(payload);
  const changedEntry = Array.isArray(tamperedClaims?.accounts) ? tamperedClaims.accounts[0] : null;
  assert.ok(changedEntry, 'the roster payload carries its saved accounts');
  if (Number.isSafeInteger(changedEntry.exp)) changedEntry.exp += 1;
  else changedEntry.exp = Math.floor(Date.now() / 1000) + 3600;
  const variants = [
    // Same header/payload, wrong signature: structurally valid, cryptographically forged.
    { label: 'mutated signature', value: `${header}.${payload}.${flipTail(signature)}`, structural: true },
    // Original signature, edited but still valid JSON claims: the signature no longer covers them.
    { label: 'mutated payload', value: `${header}.${encodeSegment(tamperedClaims)}.${signature}`, structural: true },
    // A value that is not a token at all still degrades gracefully.
    { label: 'malformed value', value: 'not-a-token', structural: false }
  ];
  for (const { label, value, structural } of variants) {
    assert.equal(value.split('.').length === 3, structural, `${label} keeps its intended shape`);
    if (structural) {
      // The edited payload still parses as claims, so the rejection can only come from the signature.
      assert.doesNotThrow(() => decodeSegment(value.split('.')[1]), `${label} payload stays valid JSON`);
    }
    const broken = new Jar();
    for (const [name, cookieValue] of jar.cookies) {
      broken.cookies.set(name, name === 'browser_accounts' ? value : cookieValue);
    }
    const listed = await listAccounts(broken);
    // The forged roster carries no authority: only the active account survives, re-derived from the
    // independent valid session cookie, and the injected A entry never becomes selectable.
    assert.deepEqual(listed.body.accounts.map(item => item.id), [b.id], `${label}: roster entries are discarded`);
    assert.deepEqual(listed.body.accounts.map(item => item.current), [true]);
    assert.equal(listed.body.currentAccountId, b.id, `${label}: the active account is unchanged`);
    const switched = await jarRequest(broken, `${ACCOUNTS}/switch`, { method: 'POST', data: { accountId: a.id } });
    assert.equal(switched.status, 401, `${label}: a forged roster cannot switch to another account`);
    assert.equal(switched.body.error_key, 'auth.required');
    const profile = await jarRequest(broken, '/api/profile');
    assert.equal(profile.status, 200, `${label}: the valid active session still authenticates`);
    assert.equal(profile.body.user.id, b.id);
  }
  assert.equal(claims(jar).sid, activeClaims.sid);
  assert.equal(sessionRow(activeClaims.sid).revoked_at, null);
});

test('the roster token is never accepted as a session token', async () => {
  const a = await f.user();
  const jar = new Jar();
  await signIn(jar, a);
  const roster = assertRosterCookie(jar);
  for (const route of ['/api/profile', ACCOUNTS]) {
    const result = await f.request(route, { cookie: `session=${roster}` });
    assert.equal(result.status, route === ACCOUNTS ? 200 : 401);
    if (route === ACCOUNTS) assert.deepEqual(result.body.accounts, []);
  }
  const switched = await f.request(`${ACCOUNTS}/switch`, { method: 'POST', cookie: `session=${roster}`, data: { accountId: a.id } });
  assert.equal(switched.status, 401);
  assert.equal(sessionRow(claims(jar).sid).revoked_at, null);
});

test('each saved account keeps its own expiry, revocation and ban check', async () => {
  const a = await f.user();
  const b = await f.user();
  const jar = new Jar();
  await signIn(jar, a, { session_days: 1 });
  const aClaims = claims(jar);
  await signIn(jar, b, { session_days: 14 });
  const bClaims = claims(jar);

  // Expire A in the database only; the roster entry must not revive it.
  sessionRow(aClaims.sid).expires_at = new Date(Date.now() - 1000);
  const expiredSwitch = await jarRequest(jar, `${ACCOUNTS}/switch`, { method: 'POST', data: { accountId: a.id } });
  assert.equal(expiredSwitch.status, 401);
  assert.equal(expiredSwitch.body.error_key, 'auth.required');
  assert.equal(claims(jar).sid, bClaims.sid, 'a rejected switch leaves the active account alone');
  const prunedA = await listAccounts(jar);
  assert.deepEqual(prunedA.body.accounts.map(item => item.id), [b.id], 'expired entries are not listed');

  // Revoked B: neither usable nor listed.
  const c = await f.user();
  await signIn(jar, c, { session_days: 7 });
  await f.request('/oauth2/logout', { cookie: `session=${jar.get('session')}` });
  jar.cookies.delete('session');
  const revokedSwitch = await jarRequest(jar, `${ACCOUNTS}/switch`, { method: 'POST', data: { accountId: c.id } });
  assert.equal(revokedSwitch.status, 401);
  assert.ok(!(await listAccounts(jar)).body.accounts.some(item => item.id === c.id));
  assert.equal(sessionRow(bClaims.sid).revoked_at, null, 'the active B session is untouched');

  // Banned account cannot be selected even with a live session row and roster entry.
  const d = await f.user();
  await signIn(jar, d);
  const dClaims = claims(jar);
  // A direct model ban is not the administrator endpoint, so it does not revoke the session row.
  await f.User.update(d.id, { banned: true });
  const bannedSwitch = await jarRequest(jar, `${ACCOUNTS}/switch`, { method: 'POST', data: { accountId: d.id } });
  assert.equal(bannedSwitch.status, 401, 'a banned account cannot be selected');
  assert.ok(!(await listAccounts(jar)).body.accounts.some(item => item.id === d.id), 'banned entries are not listed');
  // Banning is evaluated on every authenticated request, so the live proof is rejected while banned.
  assert.equal((await f.request('/api/profile', { cookie: `session=${jar.get('session')}` })).status, 401,
    'a banned account is not authenticated even with a live session row');
  assert.equal(sessionRow(dClaims.sid).revoked_at, null, 'a direct model ban does not revoke the row itself');
  // The stored proof was never revoked: clearing the ban restores it without a new login.
  await f.User.update(d.id, { banned: false });
  assert.equal((await f.request('/api/profile', { cookie: `session=${jar.get('session')}` })).status, 200,
    'an unrevoked proof revalidates once the ban is cleared');
  const unbanned = await jarRequest(jar, `${ACCOUNTS}/switch`, { method: 'POST', data: { accountId: d.id } });
  assert.equal(unbanned.status, 200, 'the saved entry is usable again after the ban is cleared');
  assert.equal(claims(jar).sub, d.id);
});

test('removing an inactive account revokes only it; removing the active one clears only the active cookie', async () => {
  const a = await f.user();
  const b = await f.user();
  const jar = new Jar();
  await signIn(jar, a, { session_days: 7 });
  const aClaims = claims(jar);
  await signIn(jar, b, { session_days: 7 });
  const bClaims = claims(jar);
  const activeBefore = activeRowIds();

  // Remove inactive A.
  const removedA = await jarRequest(jar, `${ACCOUNTS}/remove`, { method: 'POST', data: { accountId: a.id } });
  assert.equal(removedA.status, 200, JSON.stringify(removedA.body));
  assert.equal(removedA.body.accountId, a.id);
  assert.ok(sessionRow(aClaims.sid).revoked_at, 'removal revokes that saved session');
  assert.equal(sessionRow(bClaims.sid).revoked_at, null, 'unrelated accounts are untouched');
  assert.ok(jar.has('session'), 'removing an inactive account must not clear the active cookie');
  assert.equal(claims(jar).sid, bClaims.sid);
  assert.equal((await f.request('/api/profile', { cookie: `session=${jar.get('session')}` })).status, 200);
  assert.deepEqual((await listAccounts(jar)).body.accounts.map(item => item.id), [b.id]);

  // Remove the active B.
  const removedB = await jarRequest(jar, `${ACCOUNTS}/remove`, { method: 'POST', data: { accountId: b.id } });
  assert.equal(removedB.status, 200);
  assert.ok(sessionRow(bClaims.sid).revoked_at);
  assert.ok(!jar.has('session'), 'removing the active account clears the active cookie');
  const remaining = await listAccounts(jar);
  assert.deepEqual(remaining.body.accounts, []);
  assert.equal(remaining.body.currentAccountId, null);
  assert.equal(f.pool.sessions.filter(row => !row.revoked_at).length, 0);
  assert.ok(activeBefore.length >= 2);
});

test('removing the active account keeps other saved accounts explicitly selectable', async () => {
  const a = await f.user();
  const b = await f.user();
  const jar = new Jar();
  await signIn(jar, a);
  const aClaims = claims(jar);
  await signIn(jar, b);
  const bClaims = claims(jar);

  const removed = await jarRequest(jar, `${ACCOUNTS}/remove`, { method: 'POST', data: { accountId: b.id } });
  assert.equal(removed.status, 200);
  assert.ok(!jar.has('session'));
  const listed = await listAccounts(jar);
  assert.deepEqual(listed.body.accounts.map(item => item.id), [a.id]);
  assert.equal(listed.body.currentAccountId, null);
  assert.deepEqual(listed.body.accounts.map(item => item.current), [false]);

  const switched = await jarRequest(jar, `${ACCOUNTS}/switch`, { method: 'POST', data: { accountId: a.id } });
  assert.equal(switched.status, 200);
  assert.equal(claims(jar).sid, aClaims.sid);
  assert.equal((await f.request('/api/profile', { cookie: `session=${jar.get('session')}` })).body.user.id, a.id);
  assert.equal(sessionRow(bClaims.sid).revoked_at !== null, true);
});

test('logout removes only the current account and leaves unrelated saved accounts available', async () => {
  const a = await f.user();
  const b = await f.user();
  const jar = new Jar();
  await signIn(jar, a);
  const aClaims = claims(jar);
  await signIn(jar, b);
  const bClaims = claims(jar);

  const logout = await jarRequest(jar, '/oauth2/logout');
  assert.equal(logout.status, 302);
  assert.ok(sessionRow(bClaims.sid).revoked_at, 'logout still revokes the current session');
  assert.equal(sessionRow(aClaims.sid).revoked_at, null, 'unrelated accounts are not logged out');
  assert.ok(!jar.has('session'));

  const listed = await listAccounts(jar);
  assert.deepEqual(listed.body.accounts.map(item => item.id), [a.id]);
  const switched = await jarRequest(jar, `${ACCOUNTS}/switch`, { method: 'POST', data: { accountId: a.id } });
  assert.equal(switched.status, 200);
  assert.equal((await f.request('/api/profile', { cookie: `session=${jar.get('session')}` })).body.user.id, a.id);
});

test('a failed password or pending MFA for another account preserves the active account and adds no entry', async () => {
  const a = await f.user();
  const b = await f.user();
  const jar = new Jar();
  // A must complete a normal login first; enabling the mandatory mailbox factor afterwards
  // keeps A's active account while making B's login require a pending factor.
  await signIn(jar, a);
  const aClaims = claims(jar);
  const accountsBefore = (await listAccounts(jar)).body.accounts;
  f.pool.settings.push({ setting_key: 'login_email_code', setting_value: 'true' });

  const failed = await jarRequest(jar, '/oauth2/authorize', { method: 'POST',
    data: { username: b.username, password: 'wrong-password-value' } });
  assert.equal(failed.status, 401);
  assert.equal(claims(jar).sid, aClaims.sid, 'a failed login preserves the active account');
  assert.deepEqual((await listAccounts(jar)).body.accounts, accountsBefore);

  // B submits valid credentials but still owes a mailbox factor: no completed login, no roster entry.
  const pending = await jarRequest(jar, '/oauth2/authorize', { method: 'POST',
    data: { username: b.username, password: b.clearPassword, session_days: 7 } });
  assert.equal(pending.status, 200, JSON.stringify(pending.body));
  assert.equal(pending.body.mfa_url, '/oauth2/mfa');
  assert.equal(claims(jar).sid, aClaims.sid, 'a pending factor challenge preserves the active account');
  const afterPending = await listAccounts(jar);
  assert.equal(afterPending.body.accounts.length, 1);
  assert.equal(afterPending.body.accounts[0].id, a.id);
  assert.equal(afterPending.body.currentAccountId, a.id);
  for (const row of f.pool.sessions) assert.notEqual(row.user_id, b.id, 'no session row for an incomplete login');

  // Completing B's factor is a real login: both accounts are then selectable.
  const completed = await jarRequest(jar, '/api/v1/auth/oauth/oidc/complete', { method: 'POST',
    data: { code: f.lastCode(b.email) } });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  const afterCompletion = await listAccounts(jar);
  assert.deepEqual(afterCompletion.body.accounts.map(item => item.id), [b.id, a.id]);
  assert.equal(afterCompletion.body.currentAccountId, b.id);
});

test('account listing and mutation routes keep same-origin protection', async () => {
  const a = await f.user();
  const jar = new Jar();
  await signIn(jar, a);
  for (const [route, data] of [[`${ACCOUNTS}/switch`, { accountId: a.id }], [`${ACCOUNTS}/remove`, { accountId: a.id }]]) {
    const crossSite = await f.request(route, { method: 'POST', cookie: jar.header, data,
      headers: { Origin: 'https://evil.example.test' } });
    assert.equal(crossSite.status, 403, `${route} must reject a cross-origin mutation`);
    const noOrigin = await f.request(route, { method: 'POST', cookie: jar.header, data,
      headers: { Origin: 'https://evil.example.test', 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(noOrigin.status, 403);
  }
  assert.equal(sessionRow(claims(jar).sid).revoked_at, null);
  assert.equal(claims(jar).sub, a.id);
});

test('an OAuth continuation keeps its original request parameters after switching accounts', async () => {
  const a = await f.user();
  const b = await f.user();
  const client = await f.client();
  const verifier = 'verifier-value-for-the-browser-account-test';
  const oauth = new URLSearchParams({
    response_type: 'code', client_id: client.id, redirect_uri: client.redirectUris[0],
    scope: 'openid profile', state: 'account-chooser-state', nonce: 'account-chooser-nonce',
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256'
  });
  const jar = new Jar();
  await signIn(jar, a);
  await signIn(jar, b);
  assert.equal((await jarRequest(jar, `${ACCOUNTS}/switch`, { method: 'POST', data: { accountId: a.id } })).status, 200);
  assert.equal(claims(jar).sub, a.id);

  const authorized = await jarRequest(jar, `/oauth2/authorize?${oauth}`);
  assert.equal(authorized.status, 302, JSON.stringify(authorized.body));
  const location = new URL(authorized.headers.get('location'));
  assert.equal(location.searchParams.get('state'), 'account-chooser-state');
  const code = location.searchParams.get('code');
  const exchanged = await f.exchange(client, { code, verifier });
  assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));
  assert.equal(jwt.decode(exchanged.body.id_token).sub, a.id);
});
