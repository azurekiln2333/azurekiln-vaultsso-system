const crypto = require('node:crypto');

function createSecretCipher(rootSecret, purpose) {
  const key = crypto.createHash('sha256').update(`${rootSecret}:${purpose}`).digest();
  return {
    encrypt(value) {
      if (!value) return '';
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
      return `enc:v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`;
    },
    decrypt(value) {
      if (!value) return '';
      const encoded = String(value);
      if (!encoded.startsWith('enc:v1:')) return encoded;
      const parts = encoded.split(':');
      if (parts.length !== 5) throw new Error('Invalid encrypted credential');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[2], 'base64url'));
      decipher.setAuthTag(Buffer.from(parts[3], 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(parts[4], 'base64url')), decipher.final()]).toString('utf8');
    }
  };
}

module.exports = { createSecretCipher };
