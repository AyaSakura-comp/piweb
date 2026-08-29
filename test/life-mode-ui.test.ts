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
    expect(html).toContain('id="btn-life-new-session"');
    expect(html).toContain('aria-label="New Life session"');
    expect(html).toContain('title="Archive current Life session and start new"');
    expect(html).toContain('id="life-edge-hint"');
    expect(html).toContain('aria-label="Open Life"');
    expect(html).toContain('class="life-edge-drop"');
    expect(html).toMatch(
      /<main class="main">[\s\S]*id="life-edge-hint"[\s\S]*<\/main>/,
    );
    expect(html).toContain('id="life-swipe-preview"');
    expect(css).toContain('.life-edge-drop');
    expect(css).toContain('.app.life-mode');
    expect(css).toContain('.life-swipe-preview');
  });

  it('persists presentation mode and opens the singleton through the Life endpoint', () => {
    const app = readPublic('app.js');

    expect(app).toContain("const MODE_KEY = 'piweb.mode'");
    expect(app).toContain('async function enterLifeMode({ preserveSwipePreview = false } = {})');
    expect(app).toContain('async function exitLifeMode({ preserveSwipePreview = false } = {})');
    expect(app).toContain("api('/api/life-session', { method: 'POST' })");
    expect(app).toContain('viewportWidth - LIFE_EDGE_ZONE_PX');
    expect(app).toContain('const LIFE_EDGE_ZONE_PX = 56');
    expect(app).toContain('const LIFE_VELOCITY_PROJECTION_MS = 180');
    expect(app).toContain('async function settleLifeDrag');
    expect(app).toContain('async function settleLifeBackDrag');
    expect(app).toContain('async function cancelLifeExit');
    expect(app).toContain('async function handoffLifePage');
    expect(app).toContain('cubic-bezier(0.4, 0, 0.2, 1)');
    expect(app).toContain('function setLifePageOffset');
    const pageOffsetImplementation = app.match(
      /function setLifePageOffset[\s\S]*?\n}\n/,
    )?.[0];
    const clearPageOffsetImplementation = app.match(
      /function clearLifePageOffset[\s\S]*?\n}\n/,
    )?.[0];
    expect(pageOffsetImplementation).toBeDefined();
    expect(pageOffsetImplementation).not.toContain("$('life-edge-hint')");
    expect(clearPageOffsetImplementation).toBeDefined();
    expect(clearPageOffsetImplementation).not.toContain("$('life-edge-hint')");
    expect(app).toContain('function openLifeFromEdgeHint()');
    expect(app).toContain('function openSessionsFromLife()');
    expect(app).toContain("$('life-edge-hint').addEventListener('click', openLifeFromEdgeHint)");
    expect(app).toContain("$('btn-life-back').addEventListener('click', openSessionsFromLife)");
    expect(app).toContain("$('app').classList.toggle('life-mode'");
    expect(app).toContain('const destinationJid = state.activeJid');
    expect(app).toContain('encodeURIComponent(destinationJid)');
    expect(app).toContain('async function newLifeSession()');
    expect(app).toContain("api('/api/life-session/new', {");
    expect(app).toContain('body: JSON.stringify({ generation })');
    expect(app).toContain('destinationLifeGeneration');
    expect(app).toContain('sessionMeta.generation === state.lifeSession?.generation');
    expect(app).toContain("source.addEventListener('generation'");
    expect(app).toContain('function withLifeGeneration(');
    for (const lifeRead of [
      '/events?limit=',
      '/events?before=',
      '/events?after=',
      '/events?around=',
      '/search?q=',
      '/media`, jid',
      '/stream?after=',
    ]) {
      expect(app).toContain(lifeRead);
    }
    expect(app.match(/withLifeGeneration\(/g)).toHaveLength(8);
    expect(app).toContain('selectSession(LIFE_JID, {');
    expect(app).toContain(
      "$('btn-life-new-session').addEventListener('click', () => void newLifeSession())",
    );
  });
});
