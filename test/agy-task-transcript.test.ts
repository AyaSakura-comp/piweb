import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const fake = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  homedir: () => fake.home,
}));
import { readAgyTaskTranscript } from '../src/agent/agy-task-transcript.js';
afterEach(() => {
  if (fake.home) rmSync(fake.home, { recursive: true, force: true });
});
it('reads only a bounded regular transcript and rejects links and invalid ids', () => {
  fake.home = mkdtempSync(join(tmpdir(), 'agy-source-'));
  const id = '12345678-1234-1234-1234-123456789012';
  const folder = join(fake.home, '.gemini/antigravity-cli/brain', id, '.system_generated/logs');
  mkdirSync(folder, { recursive: true });
  const file = join(folder, 'transcript.jsonl');
  writeFileSync(file, '{"step_index":1}\n{"partial":');
  expect(readAgyTaskTranscript(id)).toEqual([{ step_index: 1 }]);
  expect(readAgyTaskTranscript('../../etc/passwd')).toEqual([]);
  rmSync(file);
  const foreign = join(fake.home, 'foreign');
  writeFileSync(foreign, '{"foreign":true}\n');
  symlinkSync(foreign, file);
  expect(readAgyTaskTranscript(id)).toEqual([]);
});
