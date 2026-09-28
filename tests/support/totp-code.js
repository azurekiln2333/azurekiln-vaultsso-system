const crypto = require('node:crypto');

// Independent RFC 6238 generator for exercising codes returned by enrollment.
function totpCode(secret, offset = 0) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...secret].map(letter => alphabet.indexOf(letter).toString(2).padStart(5, '0')).join('');
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(parseInt(bits.slice(index, index + 8), 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
  const digest = crypto.createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const index = digest.at(-1) & 15;
  return String((digest.readUInt32BE(index) & 0x7fffffff) % 1000000).padStart(6, '0');
}

module.exports = { totpCode };
