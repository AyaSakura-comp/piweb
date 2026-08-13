import { afterEach, describe, expect, it, vi } from 'vitest';

const getGptUsageTextMock = vi.fn(async () => '🤖 bundled usage');

vi.mock('../src/gpt-usage.js', () => ({
  getGptUsageText: getGptUsageTextMock,
}));

function channel() {
  return {
    jid: 'web:usage123',
    name: 'Usage session',
    folder: 'web_usage123',
    requiresTrigger: false,
    isMain: false,
    modelOverride: '',
    thinkingOverride: '' as const,
    cwdOverride: '',
  };
}

afterEach(() => {
  getGptUsageTextMock.mockClear();
});

describe('bundled GPT usage integrations', () => {
  it('runs the web command through the repository implementation', async () => {
    const { runCommand } = await import('../src/commands/index.js');

    const result = await runCommand(channel(), 'gpt-usage');

    expect(getGptUsageTextMock).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: true, text: '```text\n🤖 bundled usage\n```' });
  });

  it('runs the Discord slash command through the same repository implementation', async () => {
    const { handleChatCommand } = await import('../src/discord/slash-commands.js');
    const interaction = {
      commandName: 'gpt-usage',
      options: { getSubcommand: vi.fn() },
      inGuild: () => false,
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      replied: false,
      deferred: true,
    };

    await handleChatCommand(interaction as never);

    expect(getGptUsageTextMock).toHaveBeenCalledOnce();
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: '```text\n🤖 bundled usage\n```',
    });
  });
});
