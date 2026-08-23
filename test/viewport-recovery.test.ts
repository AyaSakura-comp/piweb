import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { needsViewportRecovery, recoverViewportShell } from '../public/session-ui.js';

describe('iOS standalone viewport recovery', () => {
  it('cancels delayed recovery on refocus and resets its baseline after rotation', () => {
    const app = readFileSync(resolve(import.meta.dirname, '../public/app.js'), 'utf8');

    expect(app).toContain("input.addEventListener('pointerdown', cancelStandaloneViewportRecovery)");
    expect(app).toContain("input.addEventListener('focus', cancelStandaloneViewportRecovery)");
    expect(app).toContain("input.addEventListener('blur', scheduleStandaloneViewportRecovery)");
    expect(app).toMatch(
      /viewportRecoveryTimer = setTimeout\([\s\S]*?document\.activeElement === input/,
    );
    expect(app).toContain("window.addEventListener('orientationchange', handleOrientationChange)");
    expect(app).toMatch(
      /function cancelStandaloneViewportRecovery\(\)[\s\S]*?clearTimeout\(viewportRecoveryTimer\)/,
    );
    expect(app).toMatch(
      /function handleOrientationChange\(\)[\s\S]*?maximumViewportHeight = window\.innerHeight/,
    );
  });

  it('only recovers when the viewport remains meaningfully shorter than its known maximum', () => {
    expect(needsViewportRecovery(932, 873)).toBe(true);
    expect(needsViewportRecovery(932, 930)).toBe(false);
    expect(needsViewportRecovery(932, 932)).toBe(false);
  });

  it('forces a shell reflow and keeps a reader at the transcript tail', () => {
    const style = { display: '' };
    let reflows = 0;
    const shell = {
      style,
      get offsetHeight() {
        reflows += 1;
        return 0;
      },
    };
    const scroller = { scrollTop: 800, scrollHeight: 1_000 };

    recoverViewportShell(shell, scroller, true);

    expect(reflows).toBe(1);
    expect(style.display).toBe('');
    expect(scroller.scrollTop).toBe(1_000);
  });

  it('preserves the scroll position of a reader away from the tail', () => {
    const shell = { style: { display: '' }, offsetHeight: 0 };
    const scroller = { scrollTop: 420, scrollHeight: 1_000 };

    recoverViewportShell(shell, scroller, false);

    expect(scroller.scrollTop).toBe(420);
  });
});
