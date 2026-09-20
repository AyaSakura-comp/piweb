import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('requires Docker Web to use the explicitly configured host worker cwd', () => {
  const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  expect(compose).toMatch(/PI_CWD:\s*\$\{PI_CWD:\?[^}]+\}/);
  const sample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  expect(sample).toMatch(/^PI_CWD=\/home\/chihmin$/m);
});
