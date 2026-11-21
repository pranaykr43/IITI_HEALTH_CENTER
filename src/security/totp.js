const crypto = require('node:crypto');

// RFC 6238 time-based one-time passwords (HMAC-SHA1, 30-second steps, 6 digits), the
// profile supported by common authenticator apps.
const STEP_SECONDS = 30;
const DIGITS = 6;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(text) {
  const clean = String(text || '').toUpperCase().replace(/[\s=-]/g, '');
  if (!/^[A-Z2-7]+$/.test(clean)) throw new TypeError('Invalid base32 secret');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secretBytes, counter, digits = DIGITS) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', secretBytes).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % (10 ** digits)).padStart(digits, '0');
}

function currentStep(nowMs = Date.now()) {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

function totp(secret, nowMs = Date.now()) {
  return hotp(base32Decode(secret), currentStep(nowMs));
}

// Returns the matched time step, or null. Steps at or before lastUsedStep are rejected so
// an observed code cannot be replayed, and one step of clock drift is tolerated each way.
function verifyTotp(secret, code, { nowMs = Date.now(), window = 1, lastUsedStep = 0 } = {}) {
  const normalized = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(normalized)) return null;
  const secretBytes = base32Decode(secret);
  const step = currentStep(nowMs);
  const expected = Buffer.from(normalized);
  for (let candidate = step - window; candidate <= step + window; candidate += 1) {
    if (candidate <= lastUsedStep) continue;
    if (crypto.timingSafeEqual(Buffer.from(hotp(secretBytes, candidate)), expected)) return candidate;
  }
  return null;
}

function otpauthUri({ issuer, account, secret }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

module.exports = {
  STEP_SECONDS,
  base32Encode,
  base32Decode,
  generateSecret,
  hotp,
  totp,
  currentStep,
  verifyTotp,
  otpauthUri,
};
