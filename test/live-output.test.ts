import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let db: typeof import('../src/db.js');

beforeEach(async () => {
  process.env.DB_PATH = ':memory:';
  db = await import('../src/db.js');
  db.initDb();
});

afterEach(() => db.closeDb());

describe('live_output', () => {
  it('starts empty and round-trips the in-flight text', () => {
    expect(db.getLiveOutput('web:a')).toBeNull();
    db.setLiveOutput('web:a', { content: 'Hel' });
    expect(db.getLiveOutput('web:a')?.content).toBe('Hel');
  });

  // The UI ignores stale polls by comparing seq, so it must advance on update.
  it('advances seq on every write, updating in place', () => {
    const s1 = db.setLiveOutput('web:a', { content: 'Hel' });
    const s2 = db.setLiveOutput('web:a', { content: 'Hello' });
    expect(s2).toBeGreaterThan(s1);
    expect(db.getLiveOutput('web:a')).toEqual({ content: 'Hello', thinking: '', seq: s2 });
  });

  it('keeps channels independent', () => {
    db.setLiveOutput('web:a', { content: 'A' });
    db.setLiveOutput('web:b', { content: 'B' });
    expect(db.getLiveOutput('web:a')?.content).toBe('A');
    expect(db.getLiveOutput('web:b')?.content).toBe('B');
  });

  // Clearing is what stops the preview and the finished message both showing.
  it('clears, and clearing a channel with nothing in flight is harmless', () => {
    db.setLiveOutput('web:a', { content: 'partial' });
    db.clearLiveOutput('web:a');
    expect(db.getLiveOutput('web:a')).toBeNull();
    expect(() => db.clearLiveOutput('web:nope')).not.toThrow();
  });

  it('treats both lanes empty as nothing in flight', () => {
    db.setLiveOutput('web:a', { content: '', thinking: '' });
    expect(db.getLiveOutput('web:a')).toBeNull();
  });

  // Reasoning streams before any answer exists, so a thinking-only row must
  // still count as in flight or the preview never appears.
  it('carries reasoning on its own lane, independently of the answer', () => {
    db.setLiveOutput('web:a', { thinking: '正在想…' });
    expect(db.getLiveOutput('web:a')).toMatchObject({ content: '', thinking: '正在想…' });

    db.setLiveOutput('web:a', { content: '答案', thinking: '' });
    expect(db.getLiveOutput('web:a')).toMatchObject({ content: '答案', thinking: '' });
  });
});
