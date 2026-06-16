import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  decodeFromStorage,
  decryptWithDek,
  decryptWithKek,
  encodeForStorage,
  encryptWithDek,
  encryptWithKek,
  ENVELOPE_FORMAT_VERSION,
  EnvelopeDecryptError,
  generateDek,
  generateMasterKey,
  IV_LENGTH,
  KEY_LENGTH,
  loadMasterKey,
  loadMasterKeyFromBase64,
  masterKeyFingerprint,
  TAG_LENGTH,
  timingSafeEqualBytes,
} from '../src/crypto.js';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('generateDek / generateMasterKey', () => {
  it('returns 32 bytes', () => {
    expect(generateDek().length).toBe(KEY_LENGTH);
    expect(generateMasterKey().length).toBe(KEY_LENGTH);
  });
  it('produces different values on every call', () => {
    const a = generateDek();
    const b = generateDek();
    expect(timingSafeEqualBytes(a, b)).toBe(false);
  });
});

describe('encryptWithKek / decryptWithKek', () => {
  it('round-trips a plaintext', () => {
    const kek = generateMasterKey();
    const plain = utf8('hello world');
    const parts = encryptWithKek(plain, kek);
    expect(parts.iv.length).toBe(IV_LENGTH);
    expect(parts.tag.length).toBe(TAG_LENGTH);
    expect(parts.ciphertext.length).toBe(plain.length);
    const back = decryptWithKek(parts, kek);
    expect(dec(back)).toBe('hello world');
  });

  it('rejects a tampered ciphertext', () => {
    const kek = generateMasterKey();
    const parts = encryptWithKek(utf8('hello'), kek);
    parts.ciphertext[0] = (parts.ciphertext[0] ?? 0) ^ 0xff;
    expect(() => decryptWithKek(parts, kek)).toThrow(EnvelopeDecryptError);
  });

  it('rejects a tampered iv', () => {
    const kek = generateMasterKey();
    const parts = encryptWithKek(utf8('hello'), kek);
    parts.iv[0] = (parts.iv[0] ?? 0) ^ 0xff;
    expect(() => decryptWithKek(parts, kek)).toThrow(EnvelopeDecryptError);
  });

  it('rejects a tampered tag', () => {
    const kek = generateMasterKey();
    const parts = encryptWithKek(utf8('hello'), kek);
    parts.tag[0] = (parts.tag[0] ?? 0) ^ 0xff;
    expect(() => decryptWithKek(parts, kek)).toThrow(EnvelopeDecryptError);
  });

  it('rejects the wrong key', () => {
    const kek1 = generateMasterKey();
    const kek2 = generateMasterKey();
    const parts = encryptWithKek(utf8('hello'), kek1);
    expect(() => decryptWithKek(parts, kek2)).toThrow(EnvelopeDecryptError);
  });

  it('rejects a wrong-length key', () => {
    const kek = generateMasterKey();
    const parts = encryptWithKek(utf8('hello'), kek);
    const short = new Uint8Array(16);
    expect(() => decryptWithKek(parts, short)).toThrow(EnvelopeDecryptError);
  });
});

describe('encryptWithDek / decryptWithDek', () => {
  it('round-trips a long plaintext', () => {
    const dek = generateDek();
    const plain = utf8('x'.repeat(10_000));
    const parts = encryptWithDek(plain, dek);
    const back = decryptWithDek(parts, dek);
    expect(back.length).toBe(plain.length);
    expect(dec(back).startsWith('xxxx')).toBe(true);
  });

  it('uses a fresh random iv each call (no nonce reuse)', () => {
    const dek = generateDek();
    const a = encryptWithDek(utf8('same plaintext'), dek);
    const b = encryptWithDek(utf8('same plaintext'), dek);
    expect(timingSafeEqualBytes(a.iv, b.iv)).toBe(false);
    expect(timingSafeEqualBytes(a.ciphertext, b.ciphertext)).toBe(false);
  });
});

describe('encodeForStorage / decodeFromStorage', () => {
  it('round-trips through a single bytea blob', () => {
    const dek = generateDek();
    const parts = encryptWithDek(utf8('blob test'), dek);
    const blob = encodeForStorage(parts);
    expect(blob[0]).toBe(ENVELOPE_FORMAT_VERSION);
    expect(blob.length).toBe(1 + IV_LENGTH + TAG_LENGTH + parts.ciphertext.length);

    const decoded = decodeFromStorage(blob);
    expect(decoded.iv).toEqual(parts.iv);
    expect(decoded.tag).toEqual(parts.tag);
    expect(decoded.ciphertext).toEqual(parts.ciphertext);

    const back = decryptWithDek(decoded, dek);
    expect(dec(back)).toBe('blob test');
  });

  it('rejects too-short blobs', () => {
    expect(() => decodeFromStorage(new Uint8Array(5))).toThrow(EnvelopeDecryptError);
  });

  it('rejects unknown format versions', () => {
    const dek = generateDek();
    const parts = encryptWithDek(utf8('blob'), dek);
    const blob = encodeForStorage(parts);
    blob[0] = 0x02;
    expect(() => decodeFromStorage(blob)).toThrow(EnvelopeDecryptError);
  });
});

describe('loadMasterKey', () => {
  it('decodes a 32-byte base64 key', () => {
    const raw = randomBytes(KEY_LENGTH);
    const b64 = raw.toString('base64');
    const k = loadMasterKey(b64);
    expect(k.length).toBe(KEY_LENGTH);
    expect(Buffer.from(k).equals(raw)).toBe(true);
  });

  it('decodes a 32-byte base64 key with padding', () => {
    const raw = randomBytes(KEY_LENGTH);
    const b64 = raw.toString('base64');
    expect(b64.endsWith('=')).toBe(true); // 32 bytes always yields one '=' pad
    const k = loadMasterKey(b64);
    expect(Buffer.from(k).equals(raw)).toBe(true);
  });

  it('decodes a 64-char hex key', () => {
    const raw = randomBytes(KEY_LENGTH);
    const hex = raw.toString('hex');
    expect(hex.length).toBe(64);
    const k = loadMasterKey(hex);
    expect(k.length).toBe(KEY_LENGTH);
    expect(Buffer.from(k).equals(raw)).toBe(true);
  });

  it('accepts mixed-case hex', () => {
    const raw = randomBytes(KEY_LENGTH);
    const hex = raw.toString('hex').toUpperCase();
    const k = loadMasterKey(hex);
    expect(Buffer.from(k).equals(raw)).toBe(true);
  });

  it('trims surrounding whitespace before parsing hex', () => {
    const raw = randomBytes(KEY_LENGTH);
    const hex = raw.toString('hex');
    const k = loadMasterKey(`  ${hex}\n`);
    expect(Buffer.from(k).equals(raw)).toBe(true);
  });

  it('does not mistake a 64-char hex string for base64 (would decode to 48 bytes)', () => {
    // 64 hex chars are also valid base64; as base64 they decode to 48 bytes.
    // Hex detection must win so the key is the intended 32 bytes.
    const hex = 'a'.repeat(64);
    const k = loadMasterKey(hex);
    expect(k.length).toBe(KEY_LENGTH);
  });

  it('rejects wrong-length base64 with a helpful message', () => {
    const short = Buffer.from('too short').toString('base64');
    expect(() => loadMasterKey(short)).toThrow(/HEROKUMCP_MASTER_KEY/);
    expect(() => loadMasterKey(short)).toThrow(/expected 32/);
  });

  it('rejects garbage input with the documented error message', () => {
    expect(() => loadMasterKey('!!! not a key !!!')).toThrow(/HEROKUMCP_MASTER_KEY/);
    expect(() => loadMasterKey('!!! not a key !!!')).toThrow(/openssl rand -hex/);
  });

  it('is exported under the legacy loadMasterKeyFromBase64 alias', () => {
    expect(loadMasterKeyFromBase64).toBe(loadMasterKey);
  });
});

describe('masterKeyFingerprint', () => {
  it('returns 8 lowercase hex chars', () => {
    const k = generateMasterKey();
    const fp = masterKeyFingerprint(k);
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
  });
  it('is stable for the same key and different for distinct keys', () => {
    const a = generateMasterKey();
    const b = generateMasterKey();
    expect(masterKeyFingerprint(a)).toBe(masterKeyFingerprint(a));
    expect(masterKeyFingerprint(a)).not.toBe(masterKeyFingerprint(b));
  });
});

describe('timingSafeEqualBytes', () => {
  it('matches identical byte arrays', () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 4]);
    expect(timingSafeEqualBytes(a, b)).toBe(true);
  });
  it('rejects different lengths without throwing', () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3, 4]);
    expect(timingSafeEqualBytes(a, b)).toBe(false);
  });
  it('rejects different contents', () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 5]);
    expect(timingSafeEqualBytes(a, b)).toBe(false);
  });
});
