import { describe, expect, it } from 'vitest';
import { iconSetTarget } from '../src/web/icon-set.js';

describe('iconSetTarget', () => {
  it('leaves every path to the default icons when no set is configured', () => {
    expect(iconSetTarget('/manifest.webmanifest', '')).toBeUndefined();
    expect(iconSetTarget('/apple-touch-icon.png', '')).toBeUndefined();
  });

  it('answers the manifest and every apple-touch-icon URL from the configured set', () => {
    expect(iconSetTarget('/manifest.webmanifest', 'piweb-mini')).toBe(
      'manifest.piweb-mini.webmanifest',
    );
    expect(iconSetTarget('/apple-touch-icon.png', 'piweb-mini')).toBe(
      'icons/piweb-mini/apple-180.png',
    );
    expect(iconSetTarget('/apple-touch-icon-precomposed.png', 'piweb-mini')).toBe(
      'icons/piweb-mini/apple-180.png',
    );
    for (const size of ['180', '167', '152', '120']) {
      expect(iconSetTarget(`/apple-touch-icon-${size}x${size}.png`, 'piweb-mini')).toBe(
        `icons/piweb-mini/apple-${size}.png`,
      );
    }
  });

  it('ignores other paths, non-square sizes and unsafe set names', () => {
    expect(iconSetTarget('/index.html', 'piweb-mini')).toBeUndefined();
    expect(iconSetTarget('/icons/piweb/icon-180.png', 'piweb-mini')).toBeUndefined();
    expect(iconSetTarget('/apple-touch-icon-180x167.png', 'piweb-mini')).toBeUndefined();
    expect(iconSetTarget('/manifest.webmanifest', '../secrets')).toBeUndefined();
    expect(iconSetTarget('/apple-touch-icon.png', 'a/b')).toBeUndefined();
  });
});
