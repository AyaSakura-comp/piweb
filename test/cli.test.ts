import { describe, expect, it } from 'vitest';
import { formatHelpText } from '../src/cli.js';

describe('formatHelpText', () => {
  it('mentions the primary distribution commands', () => {
    const help = formatHelpText();

    expect(help).toContain('pi-discord setup');
    expect(help).toContain('pi-discord start');
    expect(help).toContain('pi-discord status');
    expect(help).toContain('pi-discord register');
    expect(help).toContain('pi-discord daemon install');
  });
});
