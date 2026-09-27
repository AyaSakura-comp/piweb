// Browser-reported diagnostics, not trusted billing or network-route evidence.
export function parseUploadMetrics(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const bounded = (n: unknown, max: number): n is number =>
    typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= max;
  if (
    !bounded(v.fileBytes, 1e9) ||
    !bounded(v.bodyBytes, 2e9) ||
    !bounded(v.fileCount, 1000) ||
    !Number.isInteger(v.fileCount) ||
    !bounded(v.totalMs, 86400000) ||
    !(v.uploadMs === null || bounded(v.uploadMs, v.totalMs)) ||
    !bounded(v.status, 599) ||
    !Number.isInteger(v.status) ||
    typeof v.outcome !== 'string' ||
    !['response', 'error', 'abort'].includes(v.outcome)
  )
    return null;
  return {
    fileBytes: v.fileBytes,
    fileCount: v.fileCount,
    bodyBytes: v.bodyBytes,
    uploadMs: v.uploadMs,
    totalMs: v.totalMs,
    status: v.status,
    outcome: v.outcome,
  };
}
