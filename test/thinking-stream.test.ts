import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const openDbs: Array<typeof import('../src/db.js')> = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) db.closeDb();
  vi.resetModules();
});

async function setup() {
  process.env.DB_PATH = ':memory:';
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
  return { db, stream: webTransport.createEventStreamer('web:thinking-stream') };
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
    expect(answerRenderer).toContain('const followLatest = isNearBottom()');
    expect(answerRenderer).toContain("settleTranscriptUpdate(host, $('jump-live'), followLatest)");
    expect(answerRenderer).toContain('requestAnimationFrame(settle)');
    expect(answerRenderer).not.toContain('host.scrollTop = host.scrollHeight');
  });
});

describe('intermediate assistant text', () => {
  it('folds text that is followed by a tool call into thinking instead of leaving an answer preview', async () => {
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
      { kind: 'thinking', content: 'Now let me generate the song:' },
      { kind: 'tool', content: '{"command":"generate-song"}' },
    ]);
  });
});
