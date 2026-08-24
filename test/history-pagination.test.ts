import { describe, expect, it } from 'vitest';
import { shouldLoadOlderHistory } from '../public/session-ui.js';

describe('history pagination', () => {
  it('prefetches older messages before a phone viewport can hit the hard top', () => {
    const scroller = { scrollTop: 1_200, clientHeight: 800 };

    expect(shouldLoadOlderHistory(scroller)).toBe(true);

    scroller.scrollTop = 1_700;
    expect(shouldLoadOlderHistory(scroller)).toBe(false);
  });
});
