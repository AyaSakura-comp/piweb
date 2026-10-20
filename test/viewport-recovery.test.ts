import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (name: string) => readFileSync(resolve(import.meta.dirname, '../public', name), 'utf8');

describe('iOS viewport integration', () => {
  it('uses the shared visible-height binder instead of blur-only display:none recovery', () => {
    const app = read('app.js');
    expect(app).toContain('bindViewportShell(window, document, syncViewportSizes)');
    expect(app).not.toContain('recoverStandaloneViewport');
    expect(app).not.toContain('maximumViewportHeight');
    expect(app).not.toContain('recoverViewportShell');
    expect(app).toContain('keepComposerBottomVisible()');
  });

  it('sizes the main view and dashboard from the same shell rather than independent dvh caches', () => {
    expect(read('app.css')).toContain('height: var(--app-viewport-height, 100dvh)');
    expect(read('app.css')).toMatch(/\.main\s*\{[^}]*height: 100%;/);
    expect(read('session-dashboard.css')).not.toContain('--dashboard-vv-h');
    expect(read('session-dashboard.js')).not.toContain('syncDashboardVisualViewport');
  });
});
