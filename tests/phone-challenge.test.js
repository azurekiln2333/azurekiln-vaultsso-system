const { test } = require('node:test');
const assert = require('node:assert/strict');
const PhoneChallenge = require('../models/PhoneChallenge');
const { createMemoryPool } = require('./support/memory-db');

const FUTURE = () => new Date(Date.now() + 5 * 60 * 1000);

test('SMS challenge adapts JSON context, hides target in opaque key, and consumes once', async () => {
  const pool = createMemoryPool();
  const model = new PhoneChallenge(pool);
  const created = await model.create({ phone: '+8613800138000', purpose: PhoneChallenge.PURPOSES.SMS_LOGIN,
    context: { channel: 'sms', phone: '+8613800138000', sessionDays: 7, oauth: { state: 'saved' } }, expiresAt: FUTURE() });
  assert.ok(created.id);
  assert.ok(created.binding);
  const row = await model.findById(created.id);
  assert.deepEqual(row.context, { channel: 'sms', phone: '+8613800138000', sessionDays: 7,
    oauth: { state: 'saved' }, purpose: PhoneChallenge.PURPOSES.SMS_LOGIN });
  assert.ok(row.email.startsWith('phone-challenge:phone_sms_login:'));
  assert.doesNotMatch(row.email, /13800138000/);
  assert.notEqual(row.code_hash, created.binding);
  assert.equal(await model.incrementAttempts(row.id, 5), true);
  assert.equal((await model.findById(row.id)).attempts, 1);
  assert.equal(await model.consume(row.id), true);
  assert.equal(await model.consume(row.id), false);
  assert.ok((await model.findById(row.id)).consumed_at);
});

test('H5 token challenge uses an opaque ref without inventing a phone or storing the ref', async () => {
  const pool = createMemoryPool();
  const model = new PhoneChallenge(pool);
  const created = await model.create({ purpose: PhoneChallenge.PURPOSES.H5_LOGIN, ref: 'opaque-h5-ref',
    context: { channel: 'h5', sessionDays: 1 }, expiresAt: FUTURE() });
  const row = await model.findById(created.id);
  assert.equal(row.context.phone, undefined);
  assert.equal(row.context.channel, 'h5');
  assert.ok(row.email.startsWith('phone-challenge:phone_h5_login:'));
  assert.doesNotMatch(row.email, /opaque-h5-ref/);
  assert.equal(await model.invalidateRef('opaque-h5-ref', PhoneChallenge.PURPOSES.H5_LOGIN), 1);
  assert.ok((await model.findById(created.id)).consumed_at);
});

test('H5 completion may bind the provider-returned phone only after phone proof', async () => {
  const pool = createMemoryPool();
  const model = new PhoneChallenge(pool);
  const created = await model.create({ phone: '+8613900139000', purpose: PhoneChallenge.PURPOSES.H5_LOGIN,
    context: { channel: 'h5', sessionDays: 14 }, expiresAt: FUTURE() });
  const row = await model.findById(created.id);
  assert.equal(row.context.phone, '+8613900139000');
  assert.ok(row.email.startsWith('phone-challenge:phone_h5_login:'));
});

test('unsupported purpose and malformed/expired challenges fail closed', async () => {
  const pool = createMemoryPool();
  const model = new PhoneChallenge(pool);
  await assert.rejects(() => model.create({ phone: '+8613800138000', purpose: 'email_login', expiresAt: FUTURE() }));
  await assert.rejects(() => model.create({ purpose: PhoneChallenge.PURPOSES.H5_LOGIN,
    ref: 'unsafe/ref', expiresAt: FUTURE() }));
  const expired = await model.create({ phone: '+8613800138000', purpose: PhoneChallenge.PURPOSES.SMS_LOGIN,
    expiresAt: new Date(Date.now() - 1000) });
  assert.equal(await model.incrementAttempts(expired.id, 5), false);
  assert.equal(await model.consume(expired.id), false);
});
