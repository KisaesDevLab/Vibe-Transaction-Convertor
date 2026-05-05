import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

// Wraps secrets like the Anthropic API key with AES-256-GCM. The key is
// derived from SESSION_SECRET via HKDF-SHA256 with a domain-separating
// `info` string so the cookie-signing key and the secret-wrap key cannot
// collide (ADR-020).

const HKDF_INFO = Buffer.from('vibetc:system_settings:secret-wrap', 'utf8');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

const deriveKey = (): Buffer => {
  const session = process.env.SESSION_SECRET;
  if (!session || session.length < 32) {
    throw new Error('SESSION_SECRET must be set and at least 32 bytes');
  }
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(session, 'utf8'), Buffer.alloc(0), HKDF_INFO, 32),
  );
};

export const wrapSecret = (plaintext: string): Buffer => {
  const key = deriveKey();
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, tag, enc]);
};

export const unwrapSecret = (blob: Buffer): string => {
  if (blob.length < NONCE_BYTES + TAG_BYTES) throw new Error('ciphertext too short');
  const key = deriveKey();
  const nonce = blob.subarray(0, NONCE_BYTES);
  const tag = blob.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
  const enc = blob.subarray(NONCE_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString('utf8');
};
