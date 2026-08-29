import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as markdown from '../public/markdown.js';

type GetYouTubeVideoId = (url: string) => string | null;

const getYouTubeVideoId = (
  markdown as unknown as { getYouTubeVideoId?: GetYouTubeVideoId }
).getYouTubeVideoId;

describe('YouTube markdown links', () => {
  it('extracts video IDs from supported YouTube URL forms', () => {
    expect(getYouTubeVideoId).toBeTypeOf('function');
    if (!getYouTubeVideoId) return;

    expect(getYouTubeVideoId('https://www.youtube.com/watch?v=3CzZO7JujJU')).toBe(
      '3CzZO7JujJU',
    );
    expect(getYouTubeVideoId('https://youtu.be/3eCNZafONJo?t=42')).toBe('3eCNZafONJo');
    expect(getYouTubeVideoId('https://m.youtube.com/shorts/aqz-KE-bpKQ')).toBe(
      'aqz-KE-bpKQ',
    );
  });

  it('keeps the delegated copy-link handler away from playable YouTube links', () => {
    const app = readFileSync(resolve(import.meta.dirname, '../public/app.js'), 'utf8');

    expect(app).toContain(
      "if (!link || link.classList.contains('youtube-inline-link')) return;",
    );
  });

  it('rejects channels, malformed IDs, and lookalike hosts', () => {
    expect(getYouTubeVideoId).toBeTypeOf('function');
    if (!getYouTubeVideoId) return;

    expect(
      getYouTubeVideoId('https://www.youtube.com/channel/UCRdOI3XNQFJiCtMoalKpivQ'),
    ).toBeNull();
    expect(getYouTubeVideoId('https://youtube.com.evil.test/watch?v=3CzZO7JujJU')).toBeNull();
    expect(getYouTubeVideoId('https://www.youtube.com/watch?v=too-short')).toBeNull();
    expect(getYouTubeVideoId('https://www.bilibili.com/video/BV1Ye4y1Z7Et/')).toBeNull();
  });
});
