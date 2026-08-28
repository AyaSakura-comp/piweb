import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readPublic = (name: string) =>
  readFileSync(resolve(import.meta.dirname, `../public/${name}`), 'utf8');

describe('Life mode UI contract', () => {
  it('provides simplified Life chrome and a right-edge swipe affordance', () => {
    const html = readPublic('index.html');
    const css = readPublic('app.css');

    expect(html).toContain('id="btn-life-back"');
    expect(html).toContain('id="life-edge-hint"');
    expect(html).toContain('id="life-swipe-preview"');
    expect(css).toContain('.app.life-mode');
    expect(css).toContain('.life-swipe-preview');
  });

  it('persists presentation mode and opens the singleton through the Life endpoint', () => {
    const app = readPublic('app.js');

    expect(app).toContain("const MODE_KEY = 'piweb.mode'");
    expect(app).toContain('async function enterLifeMode({ preserveSwipePreview = false } = {})');
    expect(app).toContain('async function exitLifeMode()');
    expect(app).toContain("api('/api/life-session', { method: 'POST' })");
    expect(app).toContain('viewportWidth - LIFE_EDGE_ZONE_PX');
    expect(app).toContain('const LIFE_EDGE_ZONE_PX = 56');
    expect(app).toContain('const LIFE_VELOCITY_PROJECTION_MS = 180');
    expect(app).toContain('async function settleLifeDrag');
    expect(app).toContain("$('app').classList.toggle('life-mode'");
    expect(app).toContain('const destinationJid = state.activeJid');
    expect(app).toContain('encodeURIComponent(destinationJid)');
    expect(app).toContain("runQuickCommand('pi new')");
  });
});
