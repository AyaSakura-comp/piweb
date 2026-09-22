import { test, expect } from 'playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createClaudeSubagentTracker } from '../../src/agent/claude-subagents.js';
import { readSubagents } from '../../src/session/subagents.js';

test('Claude child snapshots render live progress and final text in the shared mobile viewer', async ({
  page,
}, info) => {
  const root = mkdtempSync(join(tmpdir(), 'claude-child-ui-'));
  const channel = join(root, 'channel');
  mkdirSync(channel);
  const parent = 'parent-claude-ui';
  const child = 'a0123456789';
  const transcript = join(root, parent + '.jsonl');
  writeFileSync(transcript, '');
  const childDir = join(root, parent, 'subagents');
  mkdirSync(childDir, { recursive: true });
  const source = join(childDir, `agent-${child}.jsonl`);
  const row = (type: string, uuid: string, message: unknown) => ({
    type,
    uuid,
    message,
    agentId: child,
    sessionId: parent,
    isSidechain: true,
  });
  writeFileSync(
    source,
    [
      row('user', 'u1', { role: 'user', content: 'Read fixture input' }),
      row('assistant', 'a1', {
        role: 'assistant',
        model: 'claude-haiku-test',
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'read1', name: 'Read', input: { file_path: 'fixture.txt' } },
        ],
      }),
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  );
  writeFileSync(
    join(channel, 'claude-tmux-session.json'),
    JSON.stringify({ sessionId: parent, cwd: root, modelRef: 'claude-code/opus' }),
  );
  const tracker = createClaudeSubagentTracker(channel, parent);
  tracker.observe({
    sessionId: parent,
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'call',
          name: 'Agent',
          input: { description: 'Claude fixture reader' },
        },
      ],
    },
  });
  tracker.observe({
    sessionId: parent,
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'call' }] },
    toolUseResult: { agentId: child, isAsync: true },
  });
  tracker.refresh(transcript);
  const session = {
    jid: 'web:claude-child',
    name: 'Claude parent',
    kind: 'standard',
    deleted: false,
    model: 'claude-code/opus',
    thinking: 'medium',
    badge: null,
    busy: true,
    lastReplyId: 0,
  };
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.pathname);
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions: [session] } });
    if (path.endsWith('/events'))
      return route.fulfill({ json: { events: [], busy: true, hasMore: false, session } });
    if (path.endsWith('/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 60000\n\n' });
    if (path.endsWith('/subagents')) {
      const data = await readSubagents(channel, 'owner', {
        scope: url.searchParams.get('scope') || undefined,
        child: url.searchParams.get('child') || undefined,
        after: url.searchParams.get('after') || undefined,
      });
      return route.fulfill({ json: data });
    }
    return route.fulfill({ json: { models: [], commands: [], sessions: [] } });
  });
  try {
    await page.goto('/');
    await page.locator('#btn-more').click();
    await page.locator('#mi-subagents').click();
    const dialog = page.getByRole('dialog', { name: 'Subagents' });
    const item = dialog.locator('.subagent-row');
    await expect(item).toContainText('CLAUDE');
    await expect(item).toContainText('Running');
    await page.screenshot({ path: info.outputPath('01-claude-child-running.png') });
    await item.click();
    await expect(dialog.locator('.subagents-note')).toContainText('CLAUDE');
    await expect(dialog.locator('.subagents-note')).toContainText('Read only');
    await dialog.locator('.event.tool summary').click();
    appendFileSync(
      source,
      JSON.stringify(
        row('assistant', 'final', {
          role: 'assistant',
          model: 'claude-haiku-test',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'CHILD_FINAL 中文完成' }],
        }),
      ) + '\n',
    );
    tracker.observe({
      sessionId: parent,
      type: 'system',
      subtype: 'turn_duration',
      pendingBackgroundAgentCount: 0,
    });
    tracker.refresh(transcript);
    await expect(dialog.locator('.msg:not(.msg-user)')).toContainText('CHILD_FINAL 中文完成');
    await expect(dialog.locator('.event.tool')).toHaveAttribute('open', '');
    await expect(dialog.locator('.subagents-note')).toContainText('Response ready');
    await page.screenshot({ path: info.outputPath('02-claude-child-final.png') });
    expect(
      await dialog.evaluate((e) => {
        const r = e.getBoundingClientRect();
        return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
      }),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth === document.documentElement.clientWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    tracker.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
