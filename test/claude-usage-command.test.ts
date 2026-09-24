import { expect, it, vi } from 'vitest';
const { getUsage } = vi.hoisted(() => ({ getUsage: vi.fn() }));
vi.mock('../src/claude-usage.js', async (original) => ({
  ...(await original<typeof import('../src/claude-usage.js')>()),
  getClaudeUsageText: getUsage,
}));
import { runCommand, COMMANDS } from '../src/commands/index.js';
import { ClaudeUsageError } from '../src/claude-usage.js';
it('registers and executes Claude usage without invoking the conversation agent', async () => {
  expect(COMMANDS.some((c) => c.name === 'claude-usage')).toBe(true);
  getUsage.mockResolvedValue('Claude current status / usage\n目前時段（5 小時）：4% 已使用');
  const channel = { jid: 'web:usage', folder: 'usage' } as any;
  expect(await runCommand(channel, 'claude-usage')).toMatchObject({
    ok: true,
    text: expect.stringContaining('4%'),
  });
  getUsage.mockRejectedValue(new ClaudeUsageError('請重新登入 Claude'));
  expect(await runCommand(channel, 'claude-usage')).toEqual({
    ok: false,
    text: '請重新登入 Claude',
  });
  getUsage.mockRejectedValue(Error('secret-token'));
  expect((await runCommand(channel, 'claude-usage')).text).not.toContain('secret-token');
});
