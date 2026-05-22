import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  EncryptedFileTokenStore,
  KeychainTokenStore,
  MemoryTokenStore,
  TokenStoreError,
  createTokenStore,
} from '../src/tokens.js';
import type { KeychainEntry, KeychainEntryFactory } from '../src/tokens.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'herokumcp-tokens-'));
});

describe('MemoryTokenStore', () => {
  it('get returns null for missing keys', async () => {
    const s = new MemoryTokenStore();
    expect(await s.get('x')).toBeNull();
  });

  it('supports set / get / delete / list', async () => {
    const s = new MemoryTokenStore();
    await s.set('platform:abc', 'TOKEN-1');
    await s.set('partner:client:res', 'TOKEN-2');
    expect(await s.get('platform:abc')).toBe('TOKEN-1');
    expect(await s.list()).toHaveLength(2);
    await s.delete('platform:abc');
    expect(await s.get('platform:abc')).toBeNull();
    expect(await s.list()).toEqual(['partner:client:res']);
  });

  it('list with prefix filters results', async () => {
    const s = new MemoryTokenStore();
    await s.set('platform:a', '1');
    await s.set('platform:b', '2');
    await s.set('partner:x', '3');
    expect((await s.list('platform:')).sort()).toEqual(['platform:a', 'platform:b']);
    expect(await s.list('partner:')).toEqual(['partner:x']);
  });
});

describe('EncryptedFileTokenStore', () => {
  // Use a low iteration count in tests so PBKDF2 doesn't burn CPU time.
  const TEST_ITERATIONS = 1000;

  it('rejects empty passphrase', () => {
    expect(
      () =>
        new EncryptedFileTokenStore({
          path: join(dir, 'x.enc'),
          passphrase: '',
        }),
    ).toThrow(TokenStoreError);
  });

  it('round-trips set + get', async () => {
    const path = join(dir, 'tokens.enc');
    const s = new EncryptedFileTokenStore({
      path,
      passphrase: 'pass',
      iterations: TEST_ITERATIONS,
    });
    await s.set('platform:abc', 'TOKEN-1');
    await s.set('platform:def', 'TOKEN-2');
    expect(await s.get('platform:abc')).toBe('TOKEN-1');
    expect(await s.get('platform:def')).toBe('TOKEN-2');
    expect(await s.get('missing')).toBeNull();
  });

  it('persists across instances when the passphrase matches', async () => {
    const path = join(dir, 'tokens.enc');
    const s1 = new EncryptedFileTokenStore({
      path,
      passphrase: 'pass',
      iterations: TEST_ITERATIONS,
    });
    await s1.set('a', '1');

    const s2 = new EncryptedFileTokenStore({
      path,
      passphrase: 'pass',
      iterations: TEST_ITERATIONS,
    });
    expect(await s2.get('a')).toBe('1');
  });

  it('fails decryption with a wrong passphrase', async () => {
    const path = join(dir, 'tokens.enc');
    const s1 = new EncryptedFileTokenStore({
      path,
      passphrase: 'right',
      iterations: TEST_ITERATIONS,
    });
    await s1.set('a', '1');

    const s2 = new EncryptedFileTokenStore({
      path,
      passphrase: 'wrong',
      iterations: TEST_ITERATIONS,
    });
    await expect(s2.get('a')).rejects.toMatchObject({ code: 'decrypt_failed' });
  });

  it('writes the file with 0o600 permissions', async () => {
    const path = join(dir, 'tokens.enc');
    const s = new EncryptedFileTokenStore({
      path,
      passphrase: 'pass',
      iterations: TEST_ITERATIONS,
    });
    await s.set('a', '1');
    const st = await stat(path);
    // On macOS/Linux, mode & 0o777 should equal 0o600. Skip on platforms that don't expose mode bits.
    if (process.platform !== 'win32') {
      expect(st.mode & 0o777).toBe(0o600);
    }
  });

  it('file on disk does not contain the plaintext token', async () => {
    const path = join(dir, 'tokens.enc');
    const s = new EncryptedFileTokenStore({
      path,
      passphrase: 'pass',
      iterations: TEST_ITERATIONS,
    });
    await s.set('a', 'HRKU-abcdef-1234-5678');
    const raw = await readFile(path, { encoding: 'utf8' });
    expect(raw).not.toContain('HRKU-abcdef-1234-5678');
    expect(raw).toContain('"version":1');
    expect(raw).toContain('"kdf":"pbkdf2-sha256"');
  });

  it('delete removes a key', async () => {
    const path = join(dir, 'tokens.enc');
    const s = new EncryptedFileTokenStore({
      path,
      passphrase: 'pass',
      iterations: TEST_ITERATIONS,
    });
    await s.set('a', '1');
    await s.delete('a');
    expect(await s.get('a')).toBeNull();
  });

  it('delete is a no-op on missing keys', async () => {
    const path = join(dir, 'tokens.enc');
    const s = new EncryptedFileTokenStore({
      path,
      passphrase: 'pass',
      iterations: TEST_ITERATIONS,
    });
    await s.delete('never-existed'); // should not throw
  });

  it('list supports prefix filtering', async () => {
    const path = join(dir, 'tokens.enc');
    const s = new EncryptedFileTokenStore({
      path,
      passphrase: 'pass',
      iterations: TEST_ITERATIONS,
    });
    await s.set('platform:a', '1');
    await s.set('partner:b', '2');
    expect(await s.list('platform:')).toEqual(['platform:a']);
  });

  it('detects a corrupt file', async () => {
    const path = join(dir, 'tokens.enc');
    await writeFile(path, '{not-json', { encoding: 'utf8' });
    const s = new EncryptedFileTokenStore({
      path,
      passphrase: 'pass',
      iterations: TEST_ITERATIONS,
    });
    await expect(s.get('a')).rejects.toMatchObject({ code: 'corrupt' });
  });

  it('detects an unsupported envelope version', async () => {
    const path = join(dir, 'tokens.enc');
    await writeFile(
      path,
      JSON.stringify({
        version: 99,
        kdf: 'pbkdf2-sha256',
        iterations: 1,
        salt: '',
        iv: '',
        ciphertext: '',
        tag: '',
      }),
      { encoding: 'utf8' },
    );
    const s = new EncryptedFileTokenStore({
      path,
      passphrase: 'pass',
      iterations: TEST_ITERATIONS,
    });
    await expect(s.get('a')).rejects.toMatchObject({ code: 'corrupt' });
  });

  it('serialises concurrent writes correctly', async () => {
    const path = join(dir, 'tokens.enc');
    const s = new EncryptedFileTokenStore({
      path,
      passphrase: 'pass',
      iterations: TEST_ITERATIONS,
    });
    await Promise.all(Array.from({ length: 20 }, (_, i) => s.set(`k${i}`, `v${i}`)));
    expect((await s.list()).sort()).toEqual(Array.from({ length: 20 }, (_, i) => `k${i}`).sort());
  });
});

describe('KeychainTokenStore', () => {
  function makeFakeKeychain(): {
    factory: KeychainEntryFactory;
    inspect: () => Map<string, Map<string, string>>;
  } {
    const services = new Map<string, Map<string, string>>();
    const factory: KeychainEntryFactory = (service, account): KeychainEntry => ({
      getPassword: () => services.get(service)?.get(account) ?? null,
      setPassword: (value: string) => {
        let s = services.get(service);
        if (!s) {
          s = new Map();
          services.set(service, s);
        }
        s.set(account, value);
      },
      deletePassword: () => {
        const s = services.get(service);
        if (!s) return false;
        return s.delete(account);
      },
    });
    return { factory, inspect: () => services };
  }

  it('supports get / set / delete / list', async () => {
    const { factory } = makeFakeKeychain();
    const indexPath = join(dir, 'index.json');
    const s = new KeychainTokenStore({ service: 'herokumcp', indexPath, entryFactory: factory });

    expect(await s.get('platform:abc')).toBeNull();
    await s.set('platform:abc', 'TOKEN-1');
    await s.set('partner:client:res', 'TOKEN-2');
    expect(await s.get('platform:abc')).toBe('TOKEN-1');

    expect((await s.list()).sort()).toEqual(['partner:client:res', 'platform:abc']);
    expect(await s.list('platform:')).toEqual(['platform:abc']);

    await s.delete('platform:abc');
    expect(await s.get('platform:abc')).toBeNull();
    expect(await s.list()).toEqual(['partner:client:res']);
  });

  it('never writes secret values to the index file', async () => {
    const { factory } = makeFakeKeychain();
    const indexPath = join(dir, 'index.json');
    const s = new KeychainTokenStore({ service: 'herokumcp', indexPath, entryFactory: factory });
    await s.set('platform:abc', 'HRKU-supersecret-xxxx-yyyy');
    const raw = await readFile(indexPath, { encoding: 'utf8' });
    expect(raw).not.toContain('HRKU-supersecret-xxxx-yyyy');
    expect(JSON.parse(raw)).toEqual({ accounts: ['platform:abc'] });
  });

  it('surfaces keychain failures as TokenStoreError', async () => {
    const factory: KeychainEntryFactory = (): KeychainEntry => ({
      getPassword: () => {
        throw new Error('keychain busy');
      },
      setPassword: () => {
        throw new Error('keychain busy');
      },
      deletePassword: () => true,
    });
    const s = new KeychainTokenStore({
      service: 'herokumcp',
      indexPath: join(dir, 'index.json'),
      entryFactory: factory,
    });
    await expect(s.get('a')).rejects.toMatchObject({ code: 'keychain_unavailable' });
    await expect(s.set('a', 'x')).rejects.toMatchObject({ code: 'keychain_unavailable' });
  });

  it('delete tolerates a value missing from the keychain', async () => {
    const { factory } = makeFakeKeychain();
    const indexPath = join(dir, 'index.json');
    const s = new KeychainTokenStore({ service: 'herokumcp', indexPath, entryFactory: factory });
    await s.delete('never-existed'); // must not throw
  });
});

describe('createTokenStore', () => {
  it('kind: memory', async () => {
    const s = createTokenStore({ kind: 'memory' });
    await s.set('a', '1');
    expect(await s.get('a')).toBe('1');
  });

  it('kind: encrypted-file', async () => {
    const s = createTokenStore({
      kind: 'encrypted-file',
      path: join(dir, 'x.enc'),
      passphrase: 'pass',
      iterations: 1000,
    });
    await s.set('a', '1');
    expect(await s.get('a')).toBe('1');
  });

  it('kind: keychain', async () => {
    const map = new Map<string, string>();
    const s = createTokenStore({
      kind: 'keychain',
      indexPath: join(dir, 'index.json'),
      entryFactory: (_service, account) => ({
        getPassword: () => map.get(account) ?? null,
        setPassword: (v) => {
          map.set(account, v);
        },
        deletePassword: () => map.delete(account),
      }),
    });
    await s.set('a', '1');
    expect(await s.get('a')).toBe('1');
    expect(await s.list()).toEqual(['a']);
  });
});
