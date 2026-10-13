import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { piDefaultModelRef } from '../src/agent/pi-default-model.js';

describe('piDefaultModelRef', () => {
  let dir: string;
  const write = (settings: object, mtime: number) => {
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify(settings));
    utimesSync(path, mtime, mtime);
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pi-default-'));
    process.env.PI_CODING_AGENT_DIR = dir;
  });
  afterEach(() => {
    delete process.env.PI_CODING_AGENT_DIR;
  });

  it('follows a default switched while running (no restart)', () => {
    write({ defaultProvider: 'local-llama', defaultModel: 'qwen3.6-35b-q4' }, 1000);
    expect(piDefaultModelRef()).toBe('local-llama/qwen3.6-35b-q4');
    write({ defaultProvider: 'local-strata', defaultModel: 'qwen3.8-flash' }, 2000);
    expect(piDefaultModelRef()).toBe('local-strata/qwen3.8-flash');
  });

  it('leaves resolution to pi when unset or unreadable', () => {
    write({}, 3000);
    expect(piDefaultModelRef()).toBeUndefined();
    write({ defaultProvider: 'local-llama' }, 4000);
    expect(piDefaultModelRef()).toBeUndefined();
    process.env.PI_CODING_AGENT_DIR = join(dir, 'missing');
    expect(piDefaultModelRef()).toBeUndefined();
  });
});
