import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { remarkOutboxMedia } from '../client/outbox-media.js';
import { tokenizePublishedOutbox } from '../public/outbox-stream.js';

function parse(source: string, media?: unknown[]) {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkOutboxMedia, { media });
  return processor.runSync(processor.parse(source));
}
function nodes(tree: any, type: string): any[] {
  return [
    ...(tree.type === type ? [tree] : []),
    ...(tree.children ?? []).flatMap((n: any) => nodes(n, type)),
  ];
}

describe('published outbox Markdown extension', () => {
  // History replies are tokenized before Markdown (renderLobehubStatic). Raw,
  // two files named *-__.png made bold across both markers and showed as text.
  it('shows images whose names would otherwise turn into emphasis', () => {
    const raw =
      '本機 main 現在是 `c738c3f1`。\n\n[[file: /media/web_e4936da6/2e1b52f3-light-__.png]]\n[[file: /media/web_e4936da6/99549cf0-dark-__.png]]';
    const broken = parse(raw);
    expect(nodes(broken, 'image')).toHaveLength(0);
    const { source, media } = tokenizePublishedOutbox(raw);
    const tree = parse(source, media);
    expect(nodes(tree, 'image').map((n) => n.url)).toEqual([
      '/media/web_e4936da6/2e1b52f3-light-__.png',
      '/media/web_e4936da6/99549cf0-dark-__.png',
    ]);
    expect(nodes(tree, 'strong')).toHaveLength(0);
    expect(nodes(tree, 'text').some((n) => n.value.includes('[['))).toBe(false);
  });
  it('a marker quoted in code reads as written, not as a token', () => {
    const marker = '[[file: /media/lobe.svg]]';
    const { source, media } = tokenizePublishedOutbox(`\`${marker}\`\n\n\`\`\`text\n${marker}\n\`\`\``);
    const tree = parse(source, media);
    expect(nodes(tree, 'inlineCode').map((n) => n.value)).toEqual([marker]);
    expect(nodes(tree, 'code').map((n) => n.value)).toEqual([marker]);
    expect(nodes(tree, 'image')).toHaveLength(0);
  });

  it('recognizes file images with published paths at their inline and nested positions', () => {
    const tree = parse(
      'Before [[file: /media/web_example/mem-used.png]] after.\n\n- **[[IMAGE: /media/chart.svg]]**\n\n[[file: /media/chart.PNG?download=1]]',
    );
    expect(nodes(tree, 'image').map((n) => n.url)).toEqual([
      '/media/web_example/mem-used.png',
      '/media/chart.svg',
      '/media/chart.PNG?download=1',
    ]);
    expect(nodes(tree, 'text').map((n) => n.value)).toContain('Before ');
    expect(nodes(tree, 'text').map((n) => n.value)).toContain(' after.');
  });
  it('repairs adjacent GFM auto-links inside markers without changing ordinary links', () => {
    const tree = parse(
      '[[image: https://example.test/a.png]] [[file: https://example.test/b.png]] https://example.test/reference [explicit](https://example.test/explicit)',
    );
    expect(nodes(tree, 'image').map((n) => n.url)).toEqual([
      'https://example.test/a.png',
      'https://example.test/b.png',
    ]);
    expect(nodes(tree, 'link').map((n) => n.url)).toEqual([
      'https://example.test/reference',
      'https://example.test/explicit',
    ]);
  });
  it('makes non-image files friendly download links without throwing on malformed encoding', () => {
    const tree = parse(
      '[[file: /media/12345678-report.pdf]]\n\n[[file: /media/12345678-%E5%A0%B1%E5%91%8A.pdf?download=1]]\n\n[[file: /media/12345678-bad%ZZ.pdf]]',
    );
    const links = nodes(tree, 'link');
    expect(links.map((n) => n.children[0].value)).toEqual(['report.pdf', '報告.pdf', 'bad%ZZ.pdf']);
    expect(links.every((n) => n.data.hProperties.className.includes('file-link'))).toBe(true);
  });
  it('turns our own audio files into stream-player tracks, remote audio stays a link', () => {
    const tree = parse(
      '[[file: /media/web_x/c81a0c90-venus-news-reply.mp3]]\n\n[[file: /media/voice.WAV?download=1]]\n\n[[file: https://example.test/song.mp3]]',
    );
    const images = nodes(tree, 'image');
    expect(images.map((n) => [n.url, n.data.hProperties['data-piweb-media']])).toEqual([
      ['/media/web_x/c81a0c90-venus-news-reply.mp3', 'audio'],
      ['/media/voice.WAV?download=1', 'audio'],
    ]);
    expect(images[0].alt).toBe('venus-news-reply.mp3');
    expect(nodes(tree, 'link').map((n) => n.url)).toEqual(['https://example.test/song.mp3']);
  });
  it('retains explicit video kinds and recognizes video file extensions', () => {
    const tree = parse('[[video: /media/clip]]\n\n[[file: /media/clip.mp4?download=1]]');
    expect(nodes(tree, 'image').map((n) => n.data.hProperties['data-piweb-media'])).toEqual([
      'video',
      'video',
    ]);
  });
  it('never interprets markers inside code math HTML or an explicit link label', () => {
    const marker = '[[file: /media/chart.png]]';
    const tree = parse(
      `\`${marker}\`\n\n\`\`\`text\n${marker}\n\`\`\`\n\n$${marker}$\n\n<div>\n${marker}\n</div>\n\n[${marker}](https://example.test)`,
    );
    expect(nodes(tree, 'image')).toEqual([]);
    expect(nodes(tree, 'inlineCode')[0].value).toBe(marker);
    expect(nodes(tree, 'code')[0].value).toBe(marker);
  });
  it('leaves incomplete local and unsafe markers inert while rendering later safe markers', () => {
    const tree = parse(
      '[[image: javascript:alert(1)]] [[image: data:text/html,x]] [[file: /home/private/chart.png]] [[file: /media/good.png]] [[file: /media/incomplete.png',
    );
    expect(nodes(tree, 'image').map((n) => n.url)).toEqual(['/media/good.png']);
    expect(nodes(tree, 'link')).toEqual([]);
    expect(
      nodes(tree, 'text')
        .map((n) => n.value)
        .join(''),
    ).toContain('[[file: /media/incomplete.png');
  });
});
