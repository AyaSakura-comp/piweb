import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const html = readFileSync(resolve(import.meta.dirname, '../public/index.html'), 'utf8');
const app = readFileSync(resolve(import.meta.dirname, '../public/app.js'), 'utf8');
const css = readFileSync(resolve(import.meta.dirname, '../public/app.css'), 'utf8');

describe('thinking level picker', () => {
  it('exposes an accessible topbar icon and bottom sheet', () => {
    expect(html).toContain('id="btn-thinking"');
    expect(html).toContain('aria-label="Choose thinking level"');
    expect(html).toContain('id="thinking-sheet"');
    expect(html).toContain('id="thinking-list"');
  });

  it('sets the selected level only for the active session', () => {
    expect(app).toContain('const jid = state.activeJid');
    expect(app).toContain("runQuickCommand('pi thinking', { level })");
    expect(app).toContain('awaitThinkingOverride(jid, level)');
  });

  it('visually marks both the button and current picker row', () => {
    expect(app).toContain("button.dataset.level = current || 'default'");
    expect(app).toContain("`thinking-item${level === current ? ' current' : ''}`");
    expect(css).toContain('.thinking-item.current');
    expect(css).toContain('#btn-thinking[data-level');
  });
});
