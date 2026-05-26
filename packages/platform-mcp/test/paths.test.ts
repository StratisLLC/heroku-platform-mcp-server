import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { resolvePaths } from '../src/paths.js';

describe('resolvePaths', () => {
  it('honours an explicit HEROKUMCP_HOME', () => {
    const paths = resolvePaths({
      env: { HEROKUMCP_HOME: '/tmp/explicit' },
      platform: 'linux',
      homedirFn: () => '/home/test',
    });
    expect(paths.home).toBe('/tmp/explicit');
    expect(paths.capabilitiesDir).toBe('/tmp/explicit/capabilities');
    expect(paths.capabilityFile('abc123')).toBe('/tmp/explicit/capabilities/abc123.json');
    expect(paths.auditDir).toBe('/tmp/explicit/audit');
    expect(paths.schemaCachePath).toBe('/tmp/explicit/schema-cache.json');
  });

  it('defaults to ~/Library/Application Support/herokumcp on macOS', () => {
    const paths = resolvePaths({ env: {}, platform: 'darwin', homedirFn: () => '/Users/x' });
    expect(paths.home).toBe(join('/Users/x', 'Library', 'Application Support', 'herokumcp'));
  });

  it('defaults to %APPDATA%/herokumcp on Windows', () => {
    const paths = resolvePaths({
      env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' },
      platform: 'win32',
      homedirFn: () => 'C:\\Users\\x',
    });
    // join() will use forward slashes on POSIX test hosts but the segment matters.
    expect(paths.home.endsWith('herokumcp')).toBe(true);
    expect(paths.home.includes('Roaming')).toBe(true);
  });

  it('defaults to XDG_CONFIG_HOME/herokumcp on Linux', () => {
    const paths = resolvePaths({
      env: { XDG_CONFIG_HOME: '/xdg' },
      platform: 'linux',
      homedirFn: () => '/home/test',
    });
    expect(paths.home).toBe('/xdg/herokumcp');
  });

  it('falls back to ~/.config/herokumcp when XDG is unset', () => {
    const paths = resolvePaths({ env: {}, platform: 'linux', homedirFn: () => '/home/test' });
    expect(paths.home).toBe('/home/test/.config/herokumcp');
  });
});
