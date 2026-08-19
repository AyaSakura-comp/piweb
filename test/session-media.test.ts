import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let db: typeof import('../src/db.js');

beforeEach(async () => {
  process.env.DB_PATH = ':memory:';
  const mod = await import('../src/db.js');
  db = mod;
  db.initDb();
  db.registerChannel({
    jid: 'web:m1',
    name: 'media',
    folder: 'web_m1',
    requiresTrigger: false,
    isMain: false,
    modelOverride: '',
    thinkingOverride: '',
    cwdOverride: '',
  } as any);
});

afterEach(() => {
  db.closeDb();
});

function add(files: string[] | null, jid = 'web:m1') {
  db.appendWebEvent({
    channelJid: jid,
    kind: 'message',
    role: 'assistant',
    content: 'x',
    ...(files ? { files } : {}),
  } as any);
}

describe('listSessionMedia', () => {
  it('returns images and videos newest first, classified by extension', () => {
    add(['/media/web_m1/a-chart.png']);
    add(['/media/web_m1/b-clip.mp4']);

    const items = db.listSessionMedia('web:m1');
    expect(items.map((i) => i.name)).toEqual(['b-clip.mp4', 'a-chart.png']);
    expect(items.map((i) => i.type)).toEqual(['video', 'image']);
    expect(items[1].url).toBe('/media/web_m1/a-chart.png');
  });

  // The gallery is for media; a session full of source files would otherwise
  // fill it with tiles that cannot be previewed.
  it('skips attachments that are not media', () => {
    add(['/media/web_m1/script.py', '/media/web_m1/data.csv', '/media/web_m1/ok.jpg']);
    expect(db.listSessionMedia('web:m1').map((i) => i.name)).toEqual(['ok.jpg']);
  });

  it('lists a repeated attachment once', () => {
    add(['/media/web_m1/same.png']);
    add(['/media/web_m1/same.png']);
    expect(db.listSessionMedia('web:m1')).toHaveLength(1);
  });

  it('ignores events with no attachments and never leaks another session', () => {
    add(null);
    db.registerChannel({
      jid: 'web:m2', name: 'other', folder: 'web_m2', requiresTrigger: false, isMain: false,
      modelOverride: '', thinkingOverride: '', cwdOverride: '',
    } as any);
    add(['/media/web_m2/theirs.png'], 'web:m2');
    add(['/media/web_m1/mine.png']);

    const items = db.listSessionMedia('web:m1');
    expect(items.map((i) => i.name)).toEqual(['mine.png']);
  });

  it('survives a malformed files blob', () => {
    add(['/media/web_m1/good.png']);
    expect(() => db.listSessionMedia('web:m1')).not.toThrow();
    expect(db.listSessionMedia('web:m1')).toHaveLength(1);
  });

  it('honours the limit', () => {
    for (let i = 0; i < 5; i++) add([`/media/web_m1/f${i}.png`]);
    expect(db.listSessionMedia('web:m1', 3)).toHaveLength(3);
  });
});
