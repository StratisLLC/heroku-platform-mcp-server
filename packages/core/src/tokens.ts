/**
 * Token storage (ARCHITECTURE.md §6).
 *
 * Three implementations, all satisfying {@link TokenStore}:
 *
 *  - {@link MemoryTokenStore}: ephemeral, in-process. Used when neither a
 *    keychain nor a passphrase is available; the host is warned at startup.
 *  - {@link EncryptedFileTokenStore}: AES-256-GCM, PBKDF2-SHA256 (600 000
 *    iterations) keyed off `HEROKUMCP_PASSPHRASE`. Single file containing the
 *    whole token map; rewritten on every mutation.
 *  - {@link KeychainTokenStore}: stores each value in the OS keychain (via
 *    `@napi-rs/keyring` in production, an injected factory in tests). Because
 *    keychains can't enumerate, the store maintains a small plaintext index
 *    file listing known account names — these are *non-secret* derivations of
 *    fingerprints / client ids and contain no token material.
 *
 * Tokens never appear in logs, audit lines, MCP responses, or error messages.
 */

import { randomBytes, createCipheriv, createDecipheriv, pbkdf2 } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const pbkdf2Async = promisify(pbkdf2);

/** Common interface for every token storage backend. */
export interface TokenStore {
  /** Read a value by key. Returns null when the key is absent. */
  get(key: string): Promise<string | null>;
  /** Write a value. Overwrites any existing value at the same key. */
  set(key: string, value: string): Promise<void>;
  /** Remove a key. No-op if the key is absent. */
  delete(key: string): Promise<void>;
  /** List known keys; optionally filtered by a prefix (`"platform:"`, `"partner:"`…). */
  list(prefix?: string): Promise<string[]>;
}

/** Specific codes for {@link TokenStoreError}. */
export type TokenStoreErrorCode =
  | 'decrypt_failed'
  | 'corrupt'
  | 'io'
  | 'no_passphrase'
  | 'keychain_unavailable';

/** Errors raised from any token store implementation. */
export class TokenStoreError extends Error {
  public readonly code: TokenStoreErrorCode;
  constructor(code: TokenStoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TokenStoreError';
    this.code = code;
    Object.setPrototypeOf(this, TokenStoreError.prototype);
  }
}

// --------------------------------------------------------------------------
// MemoryTokenStore
// --------------------------------------------------------------------------

/** Ephemeral, process-local. Useful as a last-resort fallback and in tests. */
export class MemoryTokenStore implements TokenStore {
  private readonly map = new Map<string, string>();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.map.get(key) ?? null);
  }

  set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.map.delete(key);
    return Promise.resolve();
  }

  list(prefix?: string): Promise<string[]> {
    const keys = [...this.map.keys()];
    return Promise.resolve(prefix ? keys.filter((k) => k.startsWith(prefix)) : keys);
  }
}

// --------------------------------------------------------------------------
// EncryptedFileTokenStore
// --------------------------------------------------------------------------

/** On-disk envelope format. Version 1 only at present. */
interface EncryptedFile {
  version: 1;
  kdf: 'pbkdf2-sha256';
  iterations: number;
  salt: string; // base64
  iv: string; // base64
  ciphertext: string; // base64
  tag: string; // base64
}

const FILE_MODE = 0o600;
const DEFAULT_ITERATIONS = 600_000;
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM-recommended

export interface EncryptedFileTokenStoreOptions {
  /** Path to the token file. The parent directory is created as needed. */
  path: string;
  /** Passphrase used to derive the encryption key. Must be non-empty. */
  passphrase: string;
  /** PBKDF2 iteration count. Defaults to 600 000 per OWASP guidance. */
  iterations?: number;
}

interface DecryptedState {
  map: Map<string, string>;
  derivedKey: Buffer;
  salt: Buffer;
}

/** AES-256-GCM encrypted token store. The decrypted map and derived key are
 *  cached in memory so writes don't repeat the PBKDF2 work. */
export class EncryptedFileTokenStore implements TokenStore {
  private readonly path: string;
  private readonly passphrase: string;
  private readonly iterations: number;
  private cache: DecryptedState | undefined;
  private chain: Promise<void> = Promise.resolve();

  constructor(opts: EncryptedFileTokenStoreOptions) {
    if (!opts.passphrase) {
      throw new TokenStoreError(
        'no_passphrase',
        'EncryptedFileTokenStore requires a non-empty passphrase.',
      );
    }
    this.path = opts.path;
    this.passphrase = opts.passphrase;
    this.iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  }

  get(key: string): Promise<string | null> {
    return this.runSerial(async () => {
      const state = await this.load();
      return state.map.get(key) ?? null;
    });
  }

  set(key: string, value: string): Promise<void> {
    return this.runSerial(async () => {
      const state = await this.load();
      state.map.set(key, value);
      await this.save(state);
    });
  }

  delete(key: string): Promise<void> {
    return this.runSerial(async () => {
      const state = await this.load();
      if (state.map.delete(key)) await this.save(state);
    });
  }

  list(prefix?: string): Promise<string[]> {
    return this.runSerial(async () => {
      const state = await this.load();
      const keys = [...state.map.keys()];
      return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
    });
  }

  /** Forget the cached derived key. Subsequent operations re-read the file. */
  resetCache(): void {
    this.cache = undefined;
  }

  private runSerial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async load(): Promise<DecryptedState> {
    if (this.cache) return this.cache;

    let raw: string;
    try {
      raw = await readFile(this.path, { encoding: 'utf8' });
    } catch (err) {
      if (isENOENT(err)) {
        const salt = randomBytes(16);
        const derivedKey = await pbkdf2Async(
          this.passphrase,
          salt,
          this.iterations,
          KEY_BYTES,
          'sha256',
        );
        this.cache = { map: new Map(), derivedKey, salt };
        return this.cache;
      }
      throw new TokenStoreError('io', `Failed to read ${this.path}`, { cause: err });
    }

    let envelope: EncryptedFile;
    try {
      envelope = JSON.parse(raw) as EncryptedFile;
    } catch (err) {
      throw new TokenStoreError('corrupt', `Token file ${this.path} is not valid JSON.`, {
        cause: err,
      });
    }
    if (envelope.version !== 1 || envelope.kdf !== 'pbkdf2-sha256') {
      throw new TokenStoreError(
        'corrupt',
        `Token file ${this.path} uses an unsupported version or KDF.`,
      );
    }

    const salt = Buffer.from(envelope.salt, 'base64');
    const iv = Buffer.from(envelope.iv, 'base64');
    const tag = Buffer.from(envelope.tag, 'base64');
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
    const derivedKey = await pbkdf2Async(
      this.passphrase,
      salt,
      envelope.iterations,
      KEY_BYTES,
      'sha256',
    );

    let plaintext: Buffer;
    try {
      const decipher = createDecipheriv('aes-256-gcm', derivedKey, iv);
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (err) {
      throw new TokenStoreError(
        'decrypt_failed',
        'Failed to decrypt token file — passphrase wrong or file tampered with.',
        { cause: err },
      );
    }

    let parsed: Record<string, string>;
    try {
      parsed = JSON.parse(plaintext.toString('utf8')) as Record<string, string>;
    } catch (err) {
      throw new TokenStoreError('corrupt', 'Decrypted token map is not valid JSON.', {
        cause: err,
      });
    }
    this.cache = { map: new Map(Object.entries(parsed)), derivedKey, salt };
    return this.cache;
  }

  private async save(state: DecryptedState): Promise<void> {
    const plaintext = Buffer.from(JSON.stringify(Object.fromEntries(state.map)), 'utf8');
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', state.derivedKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    const envelope: EncryptedFile = {
      version: 1,
      kdf: 'pbkdf2-sha256',
      iterations: this.iterations,
      salt: state.salt.toString('base64'),
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: tag.toString('base64'),
    };
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(envelope), { encoding: 'utf8', mode: FILE_MODE });
    // writeFile only honours `mode` on creation; ensure restrictive mode on overwrite too.
    await chmod(this.path, FILE_MODE).catch(() => undefined);
  }
}

// --------------------------------------------------------------------------
// KeychainTokenStore
// --------------------------------------------------------------------------

/** Minimal contract for a keychain entry, matching `@napi-rs/keyring`'s
 *  `Entry` instance shape. The factory lets tests inject a fake. */
export interface KeychainEntry {
  getPassword(): string | null;
  setPassword(value: string): void;
  deletePassword(): boolean;
}

export type KeychainEntryFactory = (service: string, account: string) => KeychainEntry;

export interface KeychainTokenStoreOptions {
  /** Keychain service name. ARCHITECTURE.md §6 uses `"herokumcp"`. */
  service: string;
  /** Path to a JSON file listing known account names. Plaintext; non-secret. */
  indexPath: string;
  /** Factory that produces an entry object for a (service, account) pair. */
  entryFactory: KeychainEntryFactory;
}

/** OS-keychain-backed store with a small plaintext index file (account names only). */
export class KeychainTokenStore implements TokenStore {
  private readonly service: string;
  private readonly indexPath: string;
  private readonly entryFactory: KeychainEntryFactory;
  private chain: Promise<void> = Promise.resolve();

  constructor(opts: KeychainTokenStoreOptions) {
    this.service = opts.service;
    this.indexPath = opts.indexPath;
    this.entryFactory = opts.entryFactory;
  }

  get(key: string): Promise<string | null> {
    try {
      return Promise.resolve(this.entryFactory(this.service, key).getPassword());
    } catch (err) {
      return Promise.reject(
        new TokenStoreError('keychain_unavailable', 'Keychain read failed.', { cause: err }),
      );
    }
  }

  set(key: string, value: string): Promise<void> {
    return this.runSerial(async () => {
      try {
        this.entryFactory(this.service, key).setPassword(value);
      } catch (err) {
        throw new TokenStoreError('keychain_unavailable', 'Keychain write failed.', { cause: err });
      }
      const index = await this.loadIndex();
      if (!index.has(key)) {
        index.add(key);
        await this.saveIndex(index);
      }
    });
  }

  delete(key: string): Promise<void> {
    return this.runSerial(async () => {
      try {
        this.entryFactory(this.service, key).deletePassword();
      } catch {
        // Already absent in keychain; we still want to update the index.
      }
      const index = await this.loadIndex();
      if (index.delete(key)) await this.saveIndex(index);
    });
  }

  async list(prefix?: string): Promise<string[]> {
    const index = await this.loadIndex();
    const names = [...index];
    return prefix ? names.filter((n) => n.startsWith(prefix)) : names;
  }

  private runSerial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async loadIndex(): Promise<Set<string>> {
    try {
      const text = await readFile(this.indexPath, { encoding: 'utf8' });
      const parsed = JSON.parse(text) as { accounts?: string[] };
      return new Set(parsed.accounts ?? []);
    } catch (err) {
      if (isENOENT(err)) return new Set();
      throw new TokenStoreError('io', `Failed to read keychain index ${this.indexPath}.`, {
        cause: err,
      });
    }
  }

  private async saveIndex(set: Set<string>): Promise<void> {
    await mkdir(dirname(this.indexPath), { recursive: true });
    const body = JSON.stringify({ accounts: [...set].sort() });
    await writeFile(this.indexPath, body, { encoding: 'utf8', mode: FILE_MODE });
    if (set.size === 0) {
      // Empty file is fine; leave it on disk so future writes are idempotent.
      try {
        await unlink(this.indexPath);
      } catch {
        // ignore — keeping the file is harmless
      }
    }
  }
}

// --------------------------------------------------------------------------
// Factory
// --------------------------------------------------------------------------

export type CreateTokenStoreOptions =
  | { kind: 'memory' }
  | { kind: 'encrypted-file'; path: string; passphrase: string; iterations?: number }
  | {
      kind: 'keychain';
      service?: string;
      indexPath: string;
      entryFactory: KeychainEntryFactory;
    };

/** Construct a {@link TokenStore} given the kind and its required options. */
export function createTokenStore(opts: CreateTokenStoreOptions): TokenStore {
  switch (opts.kind) {
    case 'memory':
      return new MemoryTokenStore();
    case 'encrypted-file': {
      const efOpts: EncryptedFileTokenStoreOptions = {
        path: opts.path,
        passphrase: opts.passphrase,
      };
      if (opts.iterations !== undefined) efOpts.iterations = opts.iterations;
      return new EncryptedFileTokenStore(efOpts);
    }
    case 'keychain':
      return new KeychainTokenStore({
        service: opts.service ?? 'herokumcp',
        indexPath: opts.indexPath,
        entryFactory: opts.entryFactory,
      });
  }
}

function isENOENT(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}
