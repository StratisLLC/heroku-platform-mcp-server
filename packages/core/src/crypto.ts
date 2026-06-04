/**
 * Envelope-encryption primitives for the hosted HTTP server (Phase 4).
 *
 * Two-key model:
 *   - Master KEK: AES-256 key supplied via `HEROKUMCP_MASTER_KEY` env var,
 *     32 bytes base64-encoded. Loaded once at server start.
 *   - Per-user DEK: 32 random bytes generated on a user's first sign-in. The
 *     DEK is itself AES-256-GCM-encrypted with the KEK and stored alongside
 *     the user record. Heroku access/refresh tokens are AES-256-GCM-encrypted
 *     with the DEK.
 *
 * This indirection means rotating the KEK requires re-wrapping each user's
 * DEK only, not the much larger token blobs. (Full rotation is a Phase 10
 * concern; Phase 4 supplies the primitives.)
 *
 * Wire format for `encodeForStorage`:
 *
 *   version(1B) | iv(12B) | tag(16B) | ciphertext(...)
 *
 * The version byte fences future format changes; we only support v1 for now.
 * AES-256-GCM authenticates the IV + tag + ciphertext together so any
 * tampering with any of those three parts fails `decipher.final()` and we
 * surface a typed error instead of silently producing garbage plaintext.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** Format-version byte stored at the start of every encoded blob. */
export const ENVELOPE_FORMAT_VERSION = 0x01;

/** AES-256 key length in bytes. */
export const KEY_LENGTH = 32;
/** AES-GCM IV length in bytes (Node accepts 12; 12 is the GCM standard). */
export const IV_LENGTH = 12;
/** AES-GCM auth tag length in bytes. */
export const TAG_LENGTH = 16;

/** Raw envelope parts. */
export interface EnvelopeParts {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
}

/** Thrown when a ciphertext cannot be decrypted — wrong key, tampered IV,
 *  tampered tag, tampered body, or malformed envelope. The error message is
 *  intentionally generic so it doesn't leak which check failed; the caller
 *  decides whether to log details. */
export class EnvelopeDecryptError extends Error {
  constructor(message = 'envelope decryption failed') {
    super(message);
    this.name = 'EnvelopeDecryptError';
  }
}

/** Generate a fresh per-user DEK (32 random bytes). */
export function generateDek(): Uint8Array {
  return new Uint8Array(randomBytes(KEY_LENGTH));
}

/** Generate a 32-byte master KEK. Used by the admin CLI's key-generation
 *  command and by tests; production KEKs are supplied via env var. */
export function generateMasterKey(): Uint8Array {
  return new Uint8Array(randomBytes(KEY_LENGTH));
}

/** Encrypt `plaintext` under `kek` using AES-256-GCM with a random IV. */
export function encryptWithKek(plaintext: Uint8Array, kek: Uint8Array): EnvelopeParts {
  return encryptGcm(plaintext, kek);
}

/** Decrypt parts under `kek`. Throws {@link EnvelopeDecryptError} on any
 *  authentication failure. */
export function decryptWithKek(parts: EnvelopeParts, kek: Uint8Array): Uint8Array {
  return decryptGcm(parts, kek);
}

/** Encrypt `plaintext` under `dek` using AES-256-GCM with a random IV. */
export function encryptWithDek(plaintext: Uint8Array, dek: Uint8Array): EnvelopeParts {
  return encryptGcm(plaintext, dek);
}

/** Decrypt parts under `dek`. Throws {@link EnvelopeDecryptError} on any
 *  authentication failure. */
export function decryptWithDek(parts: EnvelopeParts, dek: Uint8Array): Uint8Array {
  return decryptGcm(parts, dek);
}

/**
 * Pack envelope parts into a single byte blob suitable for a Postgres `bytea`
 * column. The blob always starts with the version byte so old records remain
 * decodable when we ship a v2 format.
 */
export function encodeForStorage(parts: EnvelopeParts): Uint8Array {
  if (parts.iv.length !== IV_LENGTH) {
    throw new Error(`encodeForStorage: iv must be ${IV_LENGTH} bytes, got ${parts.iv.length}`);
  }
  if (parts.tag.length !== TAG_LENGTH) {
    throw new Error(`encodeForStorage: tag must be ${TAG_LENGTH} bytes, got ${parts.tag.length}`);
  }
  const out = new Uint8Array(1 + IV_LENGTH + TAG_LENGTH + parts.ciphertext.length);
  out[0] = ENVELOPE_FORMAT_VERSION;
  out.set(parts.iv, 1);
  out.set(parts.tag, 1 + IV_LENGTH);
  out.set(parts.ciphertext, 1 + IV_LENGTH + TAG_LENGTH);
  return out;
}

/** Reverse of {@link encodeForStorage}. Throws on malformed input. */
export function decodeFromStorage(blob: Uint8Array): EnvelopeParts {
  if (blob.length < 1 + IV_LENGTH + TAG_LENGTH) {
    throw new EnvelopeDecryptError('envelope blob too short');
  }
  const version = blob[0];
  if (version !== ENVELOPE_FORMAT_VERSION) {
    throw new EnvelopeDecryptError(`unsupported envelope version: ${version}`);
  }
  const iv = blob.slice(1, 1 + IV_LENGTH);
  const tag = blob.slice(1 + IV_LENGTH, 1 + IV_LENGTH + TAG_LENGTH);
  const ciphertext = blob.slice(1 + IV_LENGTH + TAG_LENGTH);
  return { iv, tag, ciphertext };
}

/**
 * Parse a 32-byte master key supplied in either hex or base64. We accept both
 * because operators generate it different ways:
 *
 *   - `openssl rand -base64 32`  → 44-char base64 (the documented default)
 *   - `openssl rand -hex 32`     → 64-char hex
 *   - Heroku app.json `"generator": "secret"` → 64-char hex
 *
 * Hex is detected first (exactly 64 chars from [0-9a-fA-F]) because such a
 * string is *also* valid base64 and would otherwise mis-decode to 48 bytes.
 * Length is validated so an operator who pastes a wrong value gets a clear
 * error at startup rather than a confusing decryption failure on first sign-in.
 */
export function loadMasterKey(input: string): Uint8Array {
  const trimmed = input.trim();

  // Hex: exactly 64 chars (= 32 bytes), only hex digits.
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return new Uint8Array(Buffer.from(trimmed, 'hex'));
  }

  // Otherwise treat as base64. Buffer.from is lenient (it never throws and
  // silently drops invalid chars), so we lean on the length check to reject
  // both wrong-length keys and garbage input.
  const decoded = Buffer.from(trimmed, 'base64');
  if (decoded.length !== KEY_LENGTH) {
    throw new Error(
      `HEROKUMCP_MASTER_KEY: could not parse as a ${KEY_LENGTH}-byte key ` +
        `(base64-decoded length ${decoded.length} bytes, expected ${KEY_LENGTH}). ` +
        `Generate with \`openssl rand -base64 ${KEY_LENGTH}\` or \`openssl rand -hex ${KEY_LENGTH}\`.`,
    );
  }
  return new Uint8Array(decoded);
}

/**
 * @deprecated Use {@link loadMasterKey}, which also accepts hex. Retained as a
 * thin alias so older imports keep working.
 */
export const loadMasterKeyFromBase64 = loadMasterKey;

/** Stable fingerprint for a master key (first 8 hex chars of SHA-256). Used
 *  by /admin/status so operators can verify they're running with the key they
 *  expect — never the key itself. */
export function masterKeyFingerprint(kek: Uint8Array): string {
  return createHash('sha256').update(kek).digest('hex').slice(0, 8);
}

/** Constant-time comparison of two byte sequences of equal length. Returns
 *  `false` when the lengths differ (without timing leak on the length check
 *  itself, since we don't even invoke `timingSafeEqual` in that case). */
export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function encryptGcm(plaintext: Uint8Array, key: Uint8Array): EnvelopeParts {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`encryptGcm: key must be ${KEY_LENGTH} bytes, got ${key.length}`);
  }
  const iv = new Uint8Array(randomBytes(IV_LENGTH));
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv,
    tag: new Uint8Array(tag),
    ciphertext: new Uint8Array(ciphertext),
  };
}

function decryptGcm(parts: EnvelopeParts, key: Uint8Array): Uint8Array {
  if (key.length !== KEY_LENGTH) {
    throw new EnvelopeDecryptError();
  }
  if (parts.iv.length !== IV_LENGTH || parts.tag.length !== TAG_LENGTH) {
    throw new EnvelopeDecryptError();
  }
  const decipher = createDecipheriv('aes-256-gcm', key, parts.iv);
  decipher.setAuthTag(parts.tag);
  try {
    const out = Buffer.concat([decipher.update(parts.ciphertext), decipher.final()]);
    return new Uint8Array(out);
  } catch {
    throw new EnvelopeDecryptError();
  }
}
