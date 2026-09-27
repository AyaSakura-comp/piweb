import { expect, it } from 'vitest';
import { parseUploadMetrics } from '../src/web/upload-metrics.js';

it('allowlists finite bounded metrics and drops private fields', () => {
  const metrics = {
    fileBytes: 2e6,
    fileCount: 1,
    bodyBytes: 2666700,
    uploadMs: 1400,
    totalMs: 1500,
    status: 200,
    outcome: 'response',
  };
  expect(parseUploadMetrics({ ...metrics, filename: 'secret', text: 'private' })).toEqual(metrics);
  expect(parseUploadMetrics({ ...metrics, totalMs: Infinity })).toBeNull();
  expect(parseUploadMetrics({ ...metrics, uploadMs: 1600 })).toBeNull();
  expect(parseUploadMetrics({ ...metrics, outcome: 'private' })).toBeNull();
  expect(parseUploadMetrics({ ...metrics, outcome: ['response'] })).toBeNull();
  expect(parseUploadMetrics({ ...metrics, outcome: { toString: 'response' } })).toBeNull();
  expect(parseUploadMetrics(null)).toBeNull();
  expect(
    parseUploadMetrics({ ...metrics, uploadMs: null, status: 0, outcome: 'error' }),
  ).not.toBeNull();
});
