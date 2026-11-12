import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadOrCreateSecretKey,
  normalizeSecretInputs,
  openSecret,
  redactDeep,
  sealSecret,
  secretRedactor,
  secretVarBase,
  SecretInputError,
} from '../src/secrets.js';

// 2026-11-12: 「放在 disk 的時候至少是被加密過的，丟到 agent 的時候才解開」.
// Made-up details only.
const DETAIL = { name: 'GitHub', username: 'octo-user-7731', password: `pa$$ w0rd"q'x` };

const keyDir = () => mkdtempSync(join(tmpdir(), 'piweb-secret-key-'));

describe('sealing login details', () => {
  it('opens with the private key, and the sealed text shows neither value', () => {
    const { privateKey, publicKeyRaw } = loadOrCreateSecretKey(join(keyDir(), 'key.pem'));
    const sealed = sealSecret(publicKeyRaw, DETAIL);
    expect(sealed.base).toBe('PIWEB_SECRET_GITHUB');
    expect(sealed.blob).not.toContain(DETAIL.username);
    expect(sealed.blob).not.toContain(DETAIL.password);
    expect(Buffer.from(sealed.blob).toString('base64')).not.toContain(
      Buffer.from(DETAIL.password).toString('base64'),
    );
    expect(openSecret(privateKey, sealed)).toEqual({ ...DETAIL, base: 'PIWEB_SECRET_GITHUB' });
  });

  it('seals the same detail differently every time', () => {
    const { publicKeyRaw } = loadOrCreateSecretKey(join(keyDir(), 'key.pem'));
    expect(sealSecret(publicKeyRaw, DETAIL).blob).not.toBe(sealSecret(publicKeyRaw, DETAIL).blob);
  });

  it('refuses a detail that was altered, moved to another name, or sealed to another key', () => {
    const { privateKey, publicKeyRaw } = loadOrCreateSecretKey(join(keyDir(), 'key.pem'));
    const sealed = sealSecret(publicKeyRaw, DETAIL);
    const parts = sealed.blob.split('.');
    const body = Buffer.from(parts[3], 'base64url');
    body[0] ^= 1;
    parts[3] = body.toString('base64url');
    expect(() => openSecret(privateKey, { ...sealed, blob: parts.join('.') })).toThrow();
    expect(() => openSecret(privateKey, { ...sealed, base: 'PIWEB_SECRET_GITLAB' })).toThrow();
    const other = loadOrCreateSecretKey(join(keyDir(), 'key.pem'));
    expect(() => openSecret(other.privateKey, sealed)).toThrow();
  });

  it('makes the key once, readable by its owner only, and reads the same key back', () => {
    const path = join(keyDir(), 'nested', 'key.pem');
    const first = loadOrCreateSecretKey(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadOrCreateSecretKey(path).publicKeyRaw).toBe(first.publicKeyRaw);
  });

  it('tightens a key file other users could read', () => {
    const path = join(keyDir(), 'key.pem');
    const made = loadOrCreateSecretKey(path);
    writeFileSync(path, readFileSync(path), { mode: 0o644 });
    expect(loadOrCreateSecretKey(path).publicKeyRaw).toBe(made.publicKeyRaw);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('what the composer may send', () => {
  it('names variables after the detail, the same way every time', () => {
    expect(secretVarBase('GitHub')).toBe('PIWEB_SECRET_GITHUB');
    expect(secretVarBase(' my bank (TW) ')).toBe('PIWEB_SECRET_MY_BANK_TW');
    expect(secretVarBase('1Password')).toBe('PIWEB_SECRET_N1PASSWORD');
    expect(secretVarBase('公司信箱')).toMatch(/^PIWEB_SECRET_LOGIN_[0-9A-F]{6}$/);
    expect(secretVarBase('公司信箱')).toBe(secretVarBase('公司信箱'));
    expect(secretVarBase('公司信箱')).not.toBe(secretVarBase('學校信箱'));
  });

  it('takes a name and at least one of account and password', () => {
    expect(normalizeSecretInputs(undefined)).toEqual([]);
    expect(normalizeSecretInputs([{ name: '  Git  Hub ', password: 'x' }])).toEqual([
      { name: 'Git Hub', username: '', password: 'x' },
    ]);
    expect(() => normalizeSecretInputs([{ name: '', password: 'x' }])).toThrow(SecretInputError);
    expect(() => normalizeSecretInputs([{ name: 'A' }])).toThrow(SecretInputError);
    expect(() => normalizeSecretInputs([{ name: 'A', password: 5 }])).toThrow(SecretInputError);
    expect(() => normalizeSecretInputs({ name: 'A' })).toThrow(SecretInputError);
    expect(() =>
      normalizeSecretInputs([
        { name: 'GitHub', password: 'a' },
        { name: 'github', password: 'b' },
      ]),
    ).toThrow(SecretInputError);
    expect(() =>
      normalizeSecretInputs(Array.from({ length: 9 }, (_, i) => ({ name: `n${i}`, password: 'p' }))),
    ).toThrow(SecretInputError);
  });
});

describe('scrubbing values out of output', () => {
  const opened = [{ ...DETAIL, base: 'PIWEB_SECRET_GITHUB' }];

  it('swaps each value for its variable name', () => {
    const redact = secretRedactor(opened);
    expect(redact(`login ${DETAIL.username} / ${DETAIL.password} ok`)).toBe(
      'login $PIWEB_SECRET_GITHUB_USER / $PIWEB_SECRET_GITHUB_PASS ok',
    );
  });

  it('leaves values too short to be anything but a common word', () => {
    const redact = secretRedactor([{ name: 'X', base: 'PIWEB_SECRET_X', username: 'bob', password: 'longer-pass' }]);
    expect(redact('bob typed longer-pass')).toBe('bob typed $PIWEB_SECRET_X_PASS');
  });

  it('copies only what changed and never touches the original', () => {
    const redact = secretRedactor(opened);
    const event = { type: 'tool', result: { text: `pw=${DETAIL.password}` }, other: { n: 1 } };
    const out = redactDeep(event, redact);
    expect(out.result.text).toBe('pw=$PIWEB_SECRET_GITHUB_PASS');
    expect(event.result.text).toBe(`pw=${DETAIL.password}`);
    expect(out.other).toBe(event.other);
    const clean = { a: ['nothing here'] };
    expect(redactDeep(clean, redact)).toBe(clean);
  });
});
