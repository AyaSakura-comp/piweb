import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_SESSION_TITLE_GRAPHEMES,
  generateSessionTitle,
  normalizeSessionTitle,
} from '../src/agent/session-title.js';

const tempDirs: string[] = [];
const originalEnv = { ...process.env };
const CONFIG_ENV_KEYS = ['PIDG_CONFIG', 'PI_MODEL', 'SESSION_TITLE_MODEL'];

afterEach(() => {
  vi.resetModules();
  delete process.env.PIWEB_TITLE_ARGS_OUT;
  for (const key of CONFIG_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('session title normalization', () => {
  it('keeps a clean generated title within ten graphemes', () => {
    const title = normalizeSessionTitle('標題：「規劃台南兩日旅行攻略」', '規劃台南兩日旅行攻略');

    expect(title).toBe('規劃台南兩日旅行攻略');
    expect([...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(title)]).toHaveLength(
      MAX_SESSION_TITLE_GRAPHEMES,
    );
  });

  it('counts a joined emoji as one visible character', () => {
    expect(normalizeSessionTitle('👨‍👩‍👧‍👦家庭旅行規劃指南', '家庭旅行')).toBe('👨‍👩‍👧‍👦家庭旅行規劃指南');
  });

  it('falls back to the first prompt when the model returns no usable title', () => {
    expect(normalizeSessionTitle('```\n```', '  修正登入流程的錯誤  ')).toBe('修正登入流程的錯誤');
  });
});

describe('one-shot session title generation', () => {
  it('runs pi ephemerally without tools, project context, or persisted sessions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'piweb-session-title-'));
    tempDirs.push(dir);
    const bin = join(dir, 'fake-pi.mjs');
    const argsOut = join(dir, 'args.json');
    writeFileSync(
      bin,
      `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.PIWEB_TITLE_ARGS_OUT, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write('「台南兩日遊」\\n');\n`,
    );
    chmodSync(bin, 0o755);
    process.env.PIWEB_TITLE_ARGS_OUT = argsOut;

    const title = await generateSessionTitle('規劃台南兩日旅行', {
      bin,
      cwd: dir,
      timeoutMs: 2_000,
    });
    const args = JSON.parse(readFileSync(argsOut, 'utf8')) as string[];

    expect(title).toBe('台南兩日遊');
    expect(args).toEqual(
      expect.arrayContaining([
        '--no-session',
        '--no-tools',
        '--no-extensions',
        '--no-skills',
        '--no-prompt-templates',
        '--no-themes',
        '--no-context-files',
        '--thinking',
        'off',
      ]),
    );
    const appendPromptIndex = args.indexOf('--append-system-prompt');
    expect(appendPromptIndex).toBeGreaterThanOrEqual(0);
    expect(args[appendPromptIndex + 1]).toBe('');
    expect(args).not.toContain('--continue');
    expect(args.at(-1)).toContain('規劃台南兩日旅行');
  });

  it('does not pass a gateway-only agy default model to the pi CLI', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'piweb-session-title-agy-'));
    tempDirs.push(dir);
    const bin = join(dir, 'fake-pi.mjs');
    const argsOut = join(dir, 'args.json');
    writeFileSync(
      bin,
      `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.PIWEB_TITLE_ARGS_OUT, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write('隔離標題\\n');\n`,
    );
    chmodSync(bin, 0o755);
    process.env.PIWEB_TITLE_ARGS_OUT = argsOut;
    process.env.PIDG_CONFIG = join(dir, 'missing.env');
    process.env.PI_MODEL = 'agy/gemini-3-pro';
    delete process.env.SESSION_TITLE_MODEL;

    vi.resetModules();
    const { generateSessionTitle: generateWithAgyDefault } = await import(
      '../src/agent/session-title.js'
    );
    await generateWithAgyDefault('測試 gateway model', { bin, cwd: dir, timeoutMs: 2_000 });
    const args = JSON.parse(readFileSync(argsOut, 'utf8')) as string[];

    expect(args).not.toContain('--model');
    expect(args).not.toContain('agy/gemini-3-pro');
  });
});
