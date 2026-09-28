const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);

async function hashClientSecret(secret) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(secret, salt, 32);
  return `scrypt$${salt}$${hash.toString('hex')}`;
}

async function verifyClientSecret(secret, stored) {
  if (typeof secret !== 'string' || !secret || secret.length > 1024 || typeof stored !== 'string') return false;
  if (stored.startsWith('scrypt$')) {
    const parts = stored.split('$');
    if (parts.length !== 3 || !/^[a-f0-9]{32}$/.test(parts[1]) || !/^[a-f0-9]{64}$/.test(parts[2])) return false;
    const hash = await scrypt(secret, parts[1], 32);
    return crypto.timingSafeEqual(hash, Buffer.from(parts[2], 'hex'));
  }
  // Existing credentials remain usable until the administrator explicitly rotates them.
  // New and rotated secrets are always stored as salted hashes.
  const actual = crypto.createHash('sha256').update(secret).digest();
  const expected = crypto.createHash('sha256').update(stored).digest();
  return crypto.timingSafeEqual(actual, expected);
}

module.exports = { hashClientSecret, verifyClientSecret };
