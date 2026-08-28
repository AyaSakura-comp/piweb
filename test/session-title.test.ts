import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_SESSION_TITLE_GRAPHEMES,
  generateSessionTitle,
  normalizeSessionTitle,
} from '../src/agent/session-title.js';

const tempDirs: string[] = [];
const originalTitleBin = process.env.SESSION_TITLE_BIN;
const originalTitleModelPath = process.env.SESSION_TITLE_MODEL_PATH;

afterEach(() => {
  if (originalTitleBin === undefined) delete process.env.SESSION_TITLE_BIN;
  else process.env.SESSION_TITLE_BIN = originalTitleBin;
  if (originalTitleModelPath === undefined) delete process.env.SESSION_TITLE_MODEL_PATH;
  else process.env.SESSION_TITLE_MODEL_PATH = originalTitleModelPath;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('session title normalization', () => {
  it('keeps a clean title within ten graphemes', () => {
    const title = normalizeSessionTitle('標題：「規劃台南兩日旅行攻略」', '規劃台南兩日旅行攻略');

    expect(title).toBe('規劃台南兩日旅行攻略');
    expect([...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(title)]).toHaveLength(
      MAX_SESSION_TITLE_GRAPHEMES,
    );
  });

  it('counts a joined emoji as one visible character', () => {
    expect(normalizeSessionTitle('👨‍👩‍👧‍👦家庭旅行規劃指南', '家庭旅行')).toBe('👨‍👩‍👧‍👦家庭旅行規劃指南');
  });

  it('falls back to the first prompt when a candidate is empty', () => {
    expect(normalizeSessionTitle('```\n```', '  修正登入流程的錯誤  ')).toBe('修正登入流程的錯誤');
  });
});

describe('in-process session title generation', () => {
  it('does not execute a configured title binary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'piweb-session-title-no-process-'));
    tempDirs.push(dir);
    const marker = join(dir, 'spawned');
    const fakeBinary = join(dir, 'fake-title-runner');
    writeFileSync(fakeBinary, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    process.env.SESSION_TITLE_BIN = fakeBinary;
    process.env.SESSION_TITLE_MODEL_PATH = join(dir, 'unused.gguf');

    await expect(generateSessionTitle('幫我規劃台南兩日旅行')).resolves.toBe('台南兩日旅行');
    expect(existsSync(marker)).toBe(false);
  });

  it('rejects work that was already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(generateSessionTitle('修正登入錯誤', { signal: controller.signal })).rejects.toThrow(
      'Session title generation aborted',
    );
  });
});
