import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const openDbs: Array<typeof import('../src/db.js')> = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) db.closeDb();
  vi.useRealTimers();
  vi.resetModules();
});

async function setup() {
  process.env.DB_PATH = ':memory:';
  vi.resetModules();
  const db = await import('../src/db.js');
  const { webTransport } = await import('../src/transport/web.js');
  db.initDb();
  db.registerChannel({
    jid: 'web:tool-progress',
    name: 'tool progress',
    folder: 'web_tool_progress',
    requiresTrigger: false,
    isMain: false,
    modelOverride: '',
    thinkingOverride: '',
    cwdOverride: '',
  });
  openDbs.push(db);
  return { db, stream: webTransport.createEventStreamer('web:tool-progress') };
}

// Shape of `pi --mode json` events while browser_intent's planner works.
const update = (message: string) => ({
  type: 'tool_execution_update',
  toolCallId: 'call-1',
  toolName: 'browser_intent',
  partialResult: {
    content: [{ type: 'text', text: `🎯 target\n${message}` }],
    details: { type: 'progress', stage: 'task_step', message },
  },
});

describe('tool progress', () => {
  it('batches step lines into tool-progress rows and flushes them before the result', async () => {
    vi.useFakeTimers();
    const { db, stream } = await setup();
    await stream(update('📋 [步驟 1/8] 規劃動作: click "API"'));
    await stream(update('✓ 步驟 1 完成 (CLICKED)'));
    expect(db.getRecentWebEvents('web:tool-progress')).toHaveLength(0);
    vi.advanceTimersByTime(600);
    await stream(update('🔍 正在驗證目標是否已在當前頁面實現...'));
    await stream({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'browser_intent' });
    await stream({
      type: 'message_end',
      message: { role: 'toolResult', content: [{ type: 'text', text: '✅ TASK_DONE' }, { type: 'image' }] },
    });

    const rows = db.getRecentWebEvents('web:tool-progress');
    expect(rows.map((r: any) => [r.kind, r.role, r.content])).toEqual([
      ['tool_result', 'tool-progress', '📋 [步驟 1/8] 規劃動作: click "API"\n✓ 步驟 1 完成 (CLICKED)'],
      ['tool_result', 'tool-progress', '🔍 正在驗證目標是否已在當前頁面實現...'],
      ['tool_result', '', '✅ TASK_DONE'],
    ]);
  });

  it('ignores streamed output that carries no step message (bash)', async () => {
    vi.useFakeTimers();
    const { db, stream } = await setup();
    await stream({
      type: 'tool_execution_update',
      toolCallId: 'call-2',
      toolName: 'bash',
      partialResult: { content: [{ type: 'text', text: 'line 1\nline 2' }], details: {} },
    });
    vi.advanceTimersByTime(600);
    expect(db.getRecentWebEvents('web:tool-progress')).toHaveLength(0);
  });

  it('renders progress outside .event so the running-tool clock keeps ticking', () => {
    const app = readFileSync(resolve(import.meta.dirname, '../public/app.js'), 'utf8');
    expect(app).toContain("if (event.kind === 'tool_result' && event.role === 'tool-progress') {");
    expect(app).toContain("return el('div', 'tool-progress', event.content || '');");
  });
});
