const crypto = require('crypto');

// RFC 4648 base32 (no padding), the alphabet authenticator apps expect.
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
const TOTP_VERIFY_WINDOW = 1;

function generateSecret() {
  const bytes = crypto.randomBytes(20);
  let secret = '';
  for (let offset = 0; offset < bytes.length; offset += 5) {
    const chunk = bytes.subarray(offset, Math.min(offset + 5, bytes.length));
    let buffer = 0;
    let bits = 0;
    for (const byte of chunk) {
      buffer = (buffer << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        bits -= 5;
        secret += BASE32_ALPHABET[(buffer >>> bits) & 31];
      }
    }
  }
  return secret;
}

function decodeBase32(secret) {
  const clean = String(secret || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  if (!clean) {
    return Buffer.alloc(0);
  }

  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value < 0) {
      continue;
    }
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function hotp(secret, counter) {
  const key = decodeBase32(secret);
  if (!key.length) {
    return '';
  }

  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuffer.writeUInt32BE(counter % 0x100000000, 4);

  const digest = crypto.createHmac('sha1', key).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

function matchingTotpCounter(secret, code, window = TOTP_VERIFY_WINDOW) {
  const normalized = String(code || '').replace(/\s+/g, '');
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(normalized)) {
    return null;
  }

  const counter = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
  for (let drift = -window; drift <= window; drift++) {
    const expected = hotp(secret, counter + drift);
    if (expected && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(normalized))) {
      return counter + drift;
    }
  }
  return null;
}

function verifyTotp(secret, code, window = TOTP_VERIFY_WINDOW) {
  return matchingTotpCounter(secret, code, window) !== null;
}

function buildOtpauthUri({ secret, account, issuer = 'VaultSSO' }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS)
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

module.exports = {
  generateSecret,
  verifyTotp,
  matchingTotpCounter,
  buildOtpauthUri
};
