import { describe, expect, it } from 'vitest';
import { parseGptUsageArgs, renderGptUsageResult } from '../src/cli/gpt-usage.js';

const usage = {
  plan: 'plus',
  activeLimit: null,
  credits: { balance: null, hasCredits: null, unlimited: null },
  primary: {
    usedPercent: 20,
    windowMinutes: 300,
    resetAt: 1786429200,
    resetAfterSeconds: 3600,
  },
  secondary: {
    usedPercent: 40,
    windowMinutes: 10080,
    resetAt: 1787000000,
    resetAfterSeconds: 570800,
  },
  httpStatus: 200,
};

describe('bundled gpt-usage CLI', () => {
  it('accepts JSON output and a model override', () => {
    expect(parseGptUsageArgs(['--json', '--model', 'gpt-5.6'])).toEqual({
      asJson: true,
      model: 'gpt-5.6',
    });
  });

  it('rejects a missing model value', () => {
    expect(() => parseGptUsageArgs(['--model'])).toThrow('--model requires a value');
  });

  it('renders machine-readable JSON for automation', () => {
    expect(JSON.parse(renderGptUsageResult(usage, true))).toEqual(usage);
  });

  it('renders the same human-readable report used by piweb commands', () => {
    expect(renderGptUsageResult(usage, false)).toContain('ChatGPT/Codex 用量');
  });
});
