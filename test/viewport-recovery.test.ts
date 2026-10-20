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

  it('keeps the shell on the layout viewport at rest and pins it to the panned visual viewport for the keyboard', () => {
    const css = read('app.css');
    expect(css).not.toContain('--app-viewport-height');
    expect(css).toMatch(/\.app\s*\{[^}]*height: 100dvh;/);
    expect(css).toMatch(/html\.keyboard-shell \.app\s*\{[^}]*position: fixed;[^}]*top: var\(--keyboard-shell-top[^}]*height: var\(--keyboard-shell-height/);
    expect(css).toMatch(/html\.keyboard-shell \.composer-wrap\s*\{[^}]*padding-bottom: 10px;/);
    expect(read('viewport-shell.js')).toContain('viewport.offsetTop');
    expect(read('app.css')).toMatch(/\.main\s*\{[^}]*height: 100%;/);
    expect(read('session-dashboard.css')).not.toContain('--dashboard-vv-h');
    expect(read('session-dashboard.js')).not.toContain('syncDashboardVisualViewport');
  });

  it('gives an iOS 26 standalone page the full viewport (WebKit 301108)', () => {
    expect(read('app.css')).toMatch(
      /@media \(display-mode: standalone\)\s*\{\s*html\s*\{\s*min-height: min\(100lvh, calc\(100% \+ env\(safe-area-inset-top\)\)\);/,
    );
  });
});
