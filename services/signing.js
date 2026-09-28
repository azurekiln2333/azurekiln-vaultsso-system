const crypto = require('node:crypto');
const fs = require('node:fs');
const jwt = require('jsonwebtoken');
const { resolveProjectPath } = require('../config/environment');

function loadSigningKeys(env = process.env) {
  if (!env.OIDC_SIGNING_KEY_FILE) {
    throw new Error('OIDC_SIGNING_KEY_FILE must point to a persistent RSA private key (at least 2048 bits)');
  }
  const privateKey = crypto.createPrivateKey(fs.readFileSync(resolveProjectPath(env.OIDC_SIGNING_KEY_FILE)));
  if (privateKey.asymmetricKeyType !== 'rsa' || privateKey.asymmetricKeyDetails.modulusLength < 2048) {
    throw new Error('The OIDC signing key must be RSA with at least 2048 bits');
  }
  const publicKey = crypto.createPublicKey(privateKey);
  const jwk = publicKey.export({ format: 'jwk' });
  const kid = crypto.createHash('sha256').update(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n })).digest('base64url');
  const publicJwk = { ...jwk, kid, use: 'sig', alg: 'RS256' };
  const keys = [publicJwk];
  if (env.OIDC_PREVIOUS_JWKS_FILE) {
    const previous = JSON.parse(fs.readFileSync(resolveProjectPath(env.OIDC_PREVIOUS_JWKS_FILE), 'utf8'));
    if (!Array.isArray(previous.keys)) throw new Error('OIDC_PREVIOUS_JWKS_FILE must contain a JWKS keys array');
    for (const key of previous.keys) {
      if (key.kty !== 'RSA' || !key.kid || key.d || key.p || key.q || (key.alg && key.alg !== 'RS256')) {
        throw new Error('Previous JWKS entries must be public RSA signing keys with unique key IDs');
      }
      const parsedKey = crypto.createPublicKey({ key, format: 'jwk' });
      if (parsedKey.asymmetricKeyDetails.modulusLength < 2048 || keys.some(item => item.kid === key.kid)) {
        throw new Error('Previous JWKS contains a weak or duplicate key');
      }
      keys.push({ ...parsedKey.export({ format: 'jwk' }), kid: key.kid, use: 'sig', alg: 'RS256' });
    }
  }
  const verificationKeys = new Map(keys.map(key => [key.kid, crypto.createPublicKey({ key, format: 'jwk' })]));
  return {
    jwks: { keys },
    sign(payload) { return jwt.sign(payload, privateKey, { algorithm: 'RS256', keyid: kid }); },
    verify(token, issuer) {
      const decoded = jwt.decode(token, { complete: true });
      const key = decoded && verificationKeys.get(decoded.header.kid);
      if (!key) throw new Error('Unknown signing key');
      return jwt.verify(token, key, { algorithms: ['RS256'], issuer });
    }
  };
}

module.exports = { loadSigningKeys };
