const crypto = require('node:crypto');

// Authenticated encryption (AES-256-GCM) for secrets that must be recoverable by the
// server, such as TOTP seeds. A copied database or backup does not reveal them without
// the key, which lives only in the deployment environment.
const VERSION = 'v1';

function decodeKey(key) {
  if (Buffer.isBuffer(key)) return key;
  const text = String(key || '').trim();
  const decoded = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
  return decoded;
}

function createSecretBox(key) {
  const keyBytes = decodeKey(key);
  if (keyBytes.length !== 32) throw new TypeError('Secret box key must be exactly 32 bytes (base64 or hex)');
  return {
    seal(plaintext, associatedData = '') {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes, iv);
      cipher.setAAD(Buffer.from(String(associatedData)));
      const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(':');
    },
    open(sealed, associatedData = '') {
      const [version, iv, tag, ciphertext] = String(sealed || '').split(':');
      if (version !== VERSION || !iv || !tag || ciphertext === undefined) throw new Error('Unsupported sealed value');
      const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes, Buffer.from(iv, 'base64url'));
      decipher.setAAD(Buffer.from(String(associatedData)));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
    },
  };
}

module.exports = { createSecretBox, decodeKey };
