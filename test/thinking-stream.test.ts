import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const openDbs: Array<typeof import('../src/db.js')> = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) db.closeDb();
  vi.resetModules();
});

async function setup(path = ':memory:') {
  process.env.DB_PATH = path;
  vi.resetModules();
  const db = await import('../src/db.js');
  const { webTransport } = await import('../src/transport/web.js');
  db.initDb();
  db.registerChannel({
    jid: 'web:thinking-stream',
    name: 'thinking stream',
    folder: 'web_thinking_stream',
    requiresTrigger: false,
    isMain: false,
    modelOverride: '',
    thinkingOverride: '',
    cwdOverride: '',
  });
  openDbs.push(db);
  return { db, webTransport, stream: webTransport.createEventStreamer('web:thinking-stream') };
}

describe('streamed thinking UI', () => {
  it('keeps an in-flight thinking block collapsed', () => {
    const app = readFileSync(resolve(import.meta.dirname, '../public/app.js'), 'utf8');
    const renderer =
      app.match(/function renderPartialThinking\(thinking\) \{([\s\S]*?)\n\}/)?.[1] ?? '';

    expect(renderer).toContain("node = el('details', 'event thinking partial')");
    expect(renderer).not.toContain('node.open = true');
  });

  it('preserves the reader position when streaming placeholders finish', () => {
    const app = readFileSync(resolve(import.meta.dirname, '../public/app.js'), 'utf8');
    const answerRenderer =
      app.match(/function renderPartial\(text, thinking = ''\) \{([\s\S]*?)\n\}/)?.[1] ?? '';

    // Proximity is captured before either placeholder mutates the transcript,
    // then reused after layout so a reader who scrolled up is never pulled down.
    expect(answerRenderer).toContain('const followLatest = shouldFollowTranscriptTail()');
    expect(answerRenderer).toContain(
      "settleTranscriptUpdate(host, $('jump-live'), followLatest, 'auto', canFollowTranscriptNow())",
    );
    expect(answerRenderer).toContain('requestAnimationFrame(settle)');
    expect(answerRenderer).not.toContain('host.scrollTop = host.scrollHeight');
  });
});

describe('intermediate assistant text', () => {
  it.each(['turn_end', 'agent_end'])(
    'retains the answer after %s until its final message is published',
    async (type) => {
      const { db, webTransport, stream } = await setup();
      const content = '## Already read\n\nKeep these visible glyphs.\n\n';
      await stream({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: content },
      });
      await stream({ type });
      expect(db.getLiveOutput('web:thinking-stream')?.content).toBe(content);
      expect(db.getRecentWebEvents('web:thinking-stream')).toHaveLength(0);
      await webTransport.sendResponse('web:thinking-stream', content);
      expect(db.getLiveOutput('web:thinking-stream')).toBeNull();
      expect(db.getRecentWebEvents('web:thinking-stream')[0].content).toBe(content.trim());
    },
  );

  it('cleans an aborted/unpublished answer and cannot resurrect it with the delayed flush', async () => {
    const { db, webTransport, stream } = await setup();
    await stream({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'aborted answer' },
    });
    await stream({ type: 'agent_end' });
    await webTransport.clearTyping('web:thinking-stream');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(db.getLiveOutput('web:thinking-stream')).toBeNull();
    expect(db.getRecentWebEvents('web:thinking-stream')).toHaveLength(0);
  });

  it('cancels a delayed live-buffer flush during final typing cleanup', async () => {
    const { db, webTransport, stream } = await setup();

    await stream({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'must stay with old Life' },
    });
    await webTransport.clearTyping('web:thinking-stream');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));

    expect(db.getLiveOutput('web:thinking-stream')).toBeNull();
  });

  it('persists text that is followed by a tool call as plain narration, not thinking', async () => {
    const { db, stream } = await setup();

    await stream({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'Now let me generate the song:' },
    });
    await stream({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_end',
        toolCall: { name: 'bash', arguments: { command: 'generate-song' } },
      },
    });

    expect(db.getLiveOutput('web:thinking-stream')).toBeNull();
    expect(
      db.getRecentWebEvents('web:thinking-stream').map((event) => ({
        kind: event.kind,
        content: event.content,
      })),
    ).toEqual([
      { kind: 'narration', content: 'Now let me generate the song:' },
      { kind: 'tool', content: '$ generate-song' },
    ]);
  });

  it('writes whole-record narration from adapters as plain narration', async () => {
    const { db, stream } = await setup();

    await stream({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_end', content: 'The tests cover Life mode.' },
    });
    await stream({
      type: 'message_update',
      assistantMessageEvent: { type: 'narration_end', content: '生成成功！現在驗證影片品質：' },
    });

    expect(
      db.getRecentWebEvents('web:thinking-stream').map((event) => [event.kind, event.role, event.content]),
    ).toEqual([
      ['thinking', '', 'The tests cover Life mode.'],
      ['narration', 'assistant', '生成成功！現在驗證影片品質：'],
    ]);
  });
});
