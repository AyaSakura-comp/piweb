import { describe, expect, it } from 'vitest';
import { formatMediaTime, playableQueue } from '../public/stream-player.js';

const doc = { baseURI: 'https://piweb.local/' } as Document;

describe('stream player helpers', () => {
  it('formats media time, including hours and unknown durations', () => {
    expect(formatMediaTime(0)).toBe('0:00');
    expect(formatMediaTime(75.9)).toBe('1:15');
    expect(formatMediaTime(3725)).toBe('1:02:05');
    expect(formatMediaTime(NaN)).toBe('--:--');
    expect(formatMediaTime(Infinity)).toBe('--:--');
  });

  it('keeps only same-origin video/audio, de-duplicated, in order, with friendly names', () => {
    expect(
      playableQueue(
        [
          { type: 'audio', url: '/media/s/1a2b3c4d-song.mp3' },
          { type: 'image', url: '/media/s/pic.png' },
          { type: 'video', url: '/media/s/clip.mp4', name: 'Clip' },
          { type: 'audio', url: '/media/s/1a2b3c4d-song.mp3' },
          { type: 'audio', url: 'https://evil.example/x.mp3' },
          { type: 'video', url: 'javascript:alert(1)' },
        ],
        doc,
      ),
    ).toEqual([
      { type: 'audio', url: '/media/s/1a2b3c4d-song.mp3', name: 'song.mp3' },
      { type: 'video', url: '/media/s/clip.mp4', name: 'Clip' },
    ]);
  });
});
