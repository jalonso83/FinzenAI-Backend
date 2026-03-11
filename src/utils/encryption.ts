import crypto from 'crypto';
import { ENV } from '../config/env';

/**
 * AES-256-GCM Encryption Module
 * Encrypts/decrypts sensitive data (OAuth tokens, email content).
 * Format: iv:authTag:encryptedData (all hex-encoded)
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;       // 128 bits
const AUTH_TAG_LENGTH = 16;  // 128 bits
const SEPARATOR = ':';

function getKey(): Buffer {
  const key = ENV.ENCRYPTION_KEY;
  if (!key) {
    throw new Error('ENCRYPTION_KEY environment variable is not set');
  }
  // SHA-256 hash to ensure exactly 32 bytes regardless of input length
  return crypto.createHash('sha256').update(key).digest();
}

/**
 * Encrypts a plaintext string using AES-256-GCM
 * Returns format: iv:authTag:ciphertext (hex-encoded)
 */
export function encrypt(plaintext: string): string {
  if (!plaintext) return plaintext;
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}${SEPARATOR}${authTag}${SEPARATOR}${encrypted}`;
}

/**
 * Decrypts an AES-256-GCM encrypted string
 * Expects format: iv:authTag:ciphertext (hex-encoded)
 */
export function decrypt(encryptedText: string): string {
  if (!encryptedText) return encryptedText;

  const parts = encryptedText.split(SEPARATOR);
  if (parts.length !== 3) {
    // Not encrypted (plain text) — return as-is for backward compatibility
    return encryptedText;
  }

  const [ivHex, authTagHex, ciphertext] = parts;

  // Validate hex format
  if (!/^[0-9a-f]+$/i.test(ivHex) || ivHex.length !== IV_LENGTH * 2) {
    return encryptedText; // Not our format, return as-is
  }

  try {
    const key = getKey();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch {
    // If decryption fails, assume it's plain text (pre-migration data)
    return encryptedText;
  }
}

/**
 * Checks if a string is already encrypted (matches our format)
 */
export function isEncrypted(value: string): boolean {
  if (!value) return false;
  const parts = value.split(SEPARATOR);
  if (parts.length !== 3) return false;
  const [ivHex, authTagHex] = parts;
  return (
    /^[0-9a-f]+$/i.test(ivHex) &&
    ivHex.length === IV_LENGTH * 2 &&
    /^[0-9a-f]+$/i.test(authTagHex) &&
    authTagHex.length === AUTH_TAG_LENGTH * 2
  );
}
