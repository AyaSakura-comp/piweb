import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const CUSTOM_PI_VERSION = '0.84.1';
const PI_PACKAGES = ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent'] as const;

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(resolve(path), 'utf8')) as Record<string, any>;
}

describe('pi dependency deployment contract', () => {
  it('pins imported pi libraries to the customized agent version in the manifest and lockfile', () => {
    const manifest = readJson('package.json');
    const lockfile = readJson('package-lock.json');
    const lockedRoot = lockfile.packages[''];

    for (const packageName of PI_PACKAGES) {
      expect(manifest.peerDependencies[packageName]).toBe(CUSTOM_PI_VERSION);
      expect(manifest.devDependencies[packageName]).toBe(CUSTOM_PI_VERSION);
      expect(lockedRoot.peerDependencies[packageName]).toBe(CUSTOM_PI_VERSION);
      expect(lockedRoot.devDependencies[packageName]).toBe(CUSTOM_PI_VERSION);
      expect(lockfile.packages[`node_modules/${packageName}`].version).toBe(CUSTOM_PI_VERSION);
    }
  });

  it('requires a Node runtime supported by the customized agent', () => {
    const manifest = readJson('package.json');
    const lockfile = readJson('package-lock.json');

    expect(manifest.engines.node).toBe('>=22.19.0');
    expect(lockfile.packages[''].engines.node).toBe('>=22.19.0');
  });
});
