import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listSessionFamilyDirs,
  relativePathEscapesRoot,
  validateSessionFolder,
} from '../src/session/path.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('validateSessionFolder', () => {
  it('accepts valid relative folder names', () => {
    expect(validateSessionFolder('channel-123')).toBe('channel-123');
    expect(validateSessionFolder('guild/general')).toBe('guild/general');
    expect(validateSessionFolder('team/project/channel')).toBe('team/project/channel');
  });

  it('treats dot-prefixed names as children but actual parent segments as escapes', () => {
    expect(validateSessionFolder('..nested')).toBe('..nested');
    expect(relativePathEscapesRoot('..nested')).toBe(false);
    expect(relativePathEscapesRoot('..nested/child')).toBe(false);
    expect(relativePathEscapesRoot('..')).toBe(true);
    expect(relativePathEscapesRoot('../child')).toBe(true);
    expect(relativePathEscapesRoot('..\\child')).toBe(true);
  });

  it('rejects the root-level purge infrastructure namespace', () => {
    expect(() => validateSessionFolder('.piweb-purge')).toThrow(/reserved/i);
    expect(() => validateSessionFolder('.piweb-purge/session')).toThrow(/reserved/i);
  });

  it('rejects empty, absolute, and dot-segment paths', () => {
    expect(() => validateSessionFolder('   ')).toThrow('Session folder cannot be empty');
    expect(() => validateSessionFolder('/tmp/channel')).toThrow('Session folder must be relative');
    expect(() => validateSessionFolder('../channel')).toThrow(
      'Session folder contains an invalid path segment',
    );
    expect(() => validateSessionFolder('guild/./channel')).toThrow(
      'Session folder contains an invalid path segment',
    );
    expect(() => validateSessionFolder('guild/../channel')).toThrow(
      'Session folder contains an invalid path segment',
    );
  });
});

describe('listSessionFamilyDirs', () => {
  it('propagates archive-discovery I/O failures instead of silently omitting siblings', () => {
    const root = mkdtempSync(join(tmpdir(), 'piweb-session-family-denied-'));
    tempDirs.push(root);
    const active = join(root, 'web_denied');
    mkdirSync(active);
    chmodSync(root, 0o000);
    try {
      expect(() => listSessionFamilyDirs(active)).toThrow();
    } finally {
      chmodSync(root, 0o755);
    }
  });

  it('includes the active directory and every archived sibling for permanent deletion', () => {
    const root = mkdtempSync(join(tmpdir(), 'piweb-session-family-'));
    tempDirs.push(root);
    const active = join(root, 'web_12345678');
    const archiveOne = join(root, 'web_12345678__archived_20260816T010203Z');
    const archiveTwo = join(root, 'web_12345678__archived_20260816T010203Z_1');
    const archiveSymlink = join(root, 'web_12345678__archived_20260816T010203Z_2');
    const unrelated = join(root, 'web_12345678-unrelated');

    for (const dir of [active, archiveOne, archiveTwo, unrelated]) mkdirSync(dir);
    symlinkSync(unrelated, archiveSymlink, 'dir');
    mkdirSync(join(root, 'web_87654321__archived_20260816T010203Z'));

    expect(listSessionFamilyDirs(active).sort()).toEqual(
      [active, archiveOne, archiveTwo, archiveSymlink].sort(),
    );
  });
});
