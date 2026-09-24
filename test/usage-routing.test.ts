import { expect, it } from 'vitest';
import { resolveWebUsageCommand } from '../src/commands/usage-routing.js';
it('routes legacy and toolbar usage requests for Claude Code on the server', () => {
  expect(resolveWebUsageCommand('gpt-usage', 'claude-code/opus')).toBe('claude-usage');
  expect(resolveWebUsageCommand('gpt-usage', 'claude-code/sonnet', 'toolbar')).toBe('claude-usage');
  expect(resolveWebUsageCommand('gpt-usage', 'claude-code/haiku')).toBe('claude-usage');
});
it('preserves explicitly typed GPT requests and non-Claude providers', () => {
  expect(resolveWebUsageCommand('gpt-usage', 'claude-code/opus', 'composer')).toBe('gpt-usage');
  expect(resolveWebUsageCommand('pi gpt-usage', 'claude-code/opus')).toBe('pi gpt-usage');
  expect(resolveWebUsageCommand('gpt-usage', 'agy/claude-opus')).toBe('gpt-usage');
  expect(resolveWebUsageCommand('gpt-usage', 'openai-codex/test')).toBe('gpt-usage');
  expect(resolveWebUsageCommand('pi stop', 'claude-code/opus')).toBe('pi stop');
});
