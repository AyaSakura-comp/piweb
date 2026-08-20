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
    db.setLiveOutput('web:a', 'Hel');
    expect(db.getLiveOutput('web:a')?.content).toBe('Hel');
  });

  // The UI ignores stale polls by comparing seq, so it must advance on update.
  it('advances seq on every write, updating in place', () => {
    const s1 = db.setLiveOutput('web:a', 'Hel');
    const s2 = db.setLiveOutput('web:a', 'Hello');
    expect(s2).toBeGreaterThan(s1);
    expect(db.getLiveOutput('web:a')).toEqual({ content: 'Hello', seq: s2 });
  });

  it('keeps channels independent', () => {
    db.setLiveOutput('web:a', 'A');
    db.setLiveOutput('web:b', 'B');
    expect(db.getLiveOutput('web:a')?.content).toBe('A');
    expect(db.getLiveOutput('web:b')?.content).toBe('B');
  });

  // Clearing is what stops the preview and the finished message both showing.
  it('clears, and clearing a channel with nothing in flight is harmless', () => {
    db.setLiveOutput('web:a', 'partial');
    db.clearLiveOutput('web:a');
    expect(db.getLiveOutput('web:a')).toBeNull();
    expect(() => db.clearLiveOutput('web:nope')).not.toThrow();
  });

  it('treats an empty string as nothing in flight', () => {
    db.setLiveOutput('web:a', '');
    expect(db.getLiveOutput('web:a')).toBeNull();
  });
});
