import { afterEach, expect, it, vi } from 'vitest';
import {
  normalizeMetricsInterval,
  metricsRows,
  createSystemMetricsMonitor,
  fittingCount,
  STRIP_ORDER,
} from '../public/system-metrics.js';

afterEach(() => vi.useRealTimers());
it('defaults to one second and accepts only whole seconds from 1 to 60', () => {
  for (const value of [null, '', 'oops', 0, -1, 61, 1.5, Infinity])
    expect(normalizeMetricsInterval(value)).toBe(1);
  expect(normalizeMetricsInterval('5')).toBe(5);
  expect(normalizeMetricsInterval(60)).toBe(60);
});
it('formats supported values, preserves zero and omits missing/invalid metrics', () => {
  expect(
    metricsRows({
      gpuPercent: 0,
      cpuPercent: null,
      npuPercent: NaN,
      powerWatts: 40,
      powerSource: 'Package',
      memoryUsedBytes: 8 * 2 ** 30,
      memoryTotalBytes: 16 * 2 ** 30,
      memoryPercent: 50,
    }),
  ).toEqual([
    ['Power', '40.0 W', 'Package power, not wall power'],
    ['RAM', '8.0 / 16 GiB', '50% used'],
    ['GPU', '0%', 'GPU utilization'],
  ]);
  expect(metricsRows({})).toEqual([]);
});
it('shows independently labelled NPU watts, including a valid zero, but hides invalid readings', () => {
  expect(metricsRows({ npuPowerWatts: 1.234 })).toEqual([
    ['NPU power', '1.23 W', 'NPU power from AMD gpu_metrics'],
  ]);
  expect(metricsRows({ npuPowerWatts: 0 })).toEqual([
    ['NPU power', '0.00 W', 'NPU power from AMD gpu_metrics'],
  ]);
  for (const value of [undefined, null, NaN, -1, Infinity, 65.535])
    expect(metricsRows({ npuPowerWatts: value })).toEqual([]);
});

function harness(fetchMetrics = vi.fn().mockResolvedValue({ cpuPercent: 10 })) {
  let visible = true;
  const render = vi.fn();
  const storage = { getItem: vi.fn(() => '2'), setItem: vi.fn() };
  const monitor = createSystemMetricsMonitor({
    fetchMetrics,
    render,
    storage,
    isVisible: () => visible,
  });
  return {
    monitor,
    render,
    storage,
    fetchMetrics,
    hide: () => {
      visible = false;
      monitor.visibilityChanged();
    },
    show: () => {
      visible = true;
      monitor.visibilityChanged();
    },
  };
}
it('polls immediately and uses persisted interval; stopping clears values and timers', async () => {
  vi.useFakeTimers();
  const h = harness();
  h.monitor.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.fetchMetrics).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1999);
  expect(h.fetchMetrics).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.fetchMetrics).toHaveBeenCalledTimes(2);
  h.monitor.stop();
  expect(h.render).toHaveBeenLastCalledWith({});
  await vi.advanceTimersByTimeAsync(10000);
  expect(h.fetchMetrics).toHaveBeenCalledTimes(2);
});
it('does not overlap requests and hides failures before retrying', async () => {
  vi.useFakeTimers();
  let reject!: (error: Error) => void;
  const request = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    )
    .mockResolvedValue({ gpuPercent: 0 });
  const h = harness(request);
  h.monitor.start();
  await vi.advanceTimersByTimeAsync(10000);
  expect(request).toHaveBeenCalledTimes(1);
  reject(new Error('offline'));
  await vi.advanceTimersByTimeAsync(0);
  expect(h.render).toHaveBeenLastCalledWith({});
  await vi.advanceTimersByTimeAsync(2000);
  expect(h.render).toHaveBeenLastCalledWith({ gpuPercent: 0 });
  h.monitor.stop();
});
it('saves interval and pauses when hidden, ignoring late responses after logout', async () => {
  vi.useFakeTimers();
  const h = harness();
  h.monitor.start();
  await vi.advanceTimersByTimeAsync(0);
  h.monitor.setInterval(5);
  expect(h.storage.setItem).toHaveBeenCalledWith('piweb.metricsIntervalSeconds', '5');
  h.hide();
  await vi.advanceTimersByTimeAsync(10000);
  expect(h.fetchMetrics).toHaveBeenCalledTimes(1);
  h.show();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.fetchMetrics).toHaveBeenCalledTimes(2);
  h.monitor.stop();
  let resolve!: (data: object) => void;
  const late = harness(
    vi.fn(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    ),
  );
  late.monitor.start();
  late.monitor.stop();
  resolve({ cpuPercent: 99 });
  await vi.advanceTimersByTimeAsync(0);
  expect(late.render).toHaveBeenLastCalledWith({});
});
it('survives unavailable localStorage', () => {
  const storage = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  const monitor = createSystemMetricsMonitor({
    fetchMetrics: vi.fn(),
    render: vi.fn(),
    storage,
    isVisible: () => true,
  });
  expect(monitor.interval).toBe(1);
  expect(() => monitor.setInterval(3)).not.toThrow();
  expect(monitor.interval).toBe(3);
});

it('the Dashboard header shows a leading run of readings that fits, never one after a dropped one', () => {
  // GPU 40, CPU 30, Power 50, RAM 100 px wide; 14px between.
  const widths = [40, 30, 50, 100];
  expect(fittingCount(widths, 0, 14)).toBe(0);
  expect(fittingCount(widths, 39, 14)).toBe(0);
  expect(fittingCount(widths, 40, 14)).toBe(1);
  expect(fittingCount(widths, 40 + 14 + 30, 14)).toBe(2);
  expect(fittingCount(widths, 40 + 14 + 30 + 14 + 50 + 13, 14)).toBe(3);
  // RAM does not fit, so nothing after it shows even if it is narrow.
  expect(fittingCount([...widths, 5], 200, 14)).toBe(3);
  expect(fittingCount(widths, 1e4, 14)).toBe(4);
  // The drawer's three summary readings lead, then the NPU (it was last, and the
  // iPad's header had no room for it).
  expect(STRIP_ORDER.slice(0, 4)).toEqual(['GPU', 'CPU', 'Power', 'NPU power']);
  // A total that is not whole (MemTotal, when the memory blocks are unreadable) keeps its decimal.
  expect(metricsRows({ memoryUsedBytes: 2 ** 30, memoryTotalBytes: 122.8 * 2 ** 30, memoryPercent: 1 }).at(0)?.[1]).toBe(
    '1.0 / 122.8 GiB',
  );
  const labels = metricsRows({
    powerWatts: 1, npuPowerWatts: 1, cpuTemperatureC: 1, gpuTemperatureC: 1,
    memoryUsedBytes: 1, memoryTotalBytes: 2, memoryPercent: 50, cpuPercent: 1, gpuPercent: 1, npuPercent: 1,
    diskUsedBytes: 1, diskTotalBytes: 2, diskFreeBytes: 1, diskPercent: 50,
  }).map(([label]) => label);
  expect(labels).toContain('Disk');
  for (const label of labels) expect(STRIP_ORDER).toContain(label);
  // Disk changes slowest: the first reading to go when room runs out.
  expect(STRIP_ORDER.at(-1)).toBe('Disk');
});

it('shows the disk after RAM, in TiB from a terabyte up, and leaves out an impossible reading', () => {
  const TiB = 2 ** 40;
  const GiB = 2 ** 30;
  // This box: 3.58 TiB, 1.37 used, 2.20 free to users (df: 3.6T 1.4T 2.2T).
  const box = {
    memoryUsedBytes: 87 * GiB,
    memoryTotalBytes: 128 * GiB,
    memoryPercent: 68,
    diskTotalBytes: 961092611 * 4096,
    diskUsedBytes: 366543227 * 4096,
    diskFreeBytes: 589713414 * 4096,
    diskPercent: 38.33,
  };
  expect(metricsRows(box)).toEqual([
    ['RAM', '87.0 / 128 GiB', '68% used'],
    ['Disk', '1.4 / 3.6 TiB', '38% used, 2.2 TiB free'],
  ]);
  expect(
    metricsRows({ diskTotalBytes: 500 * GiB, diskUsedBytes: 120 * GiB, diskFreeBytes: 355 * GiB, diskPercent: 25.3 }),
  ).toEqual([['Disk', '120.0 / 500.0 GiB', '25% used, 355.0 GiB free']]);
  expect(metricsRows({ ...box, diskUsedBytes: 4 * TiB })).toHaveLength(1);
  expect(metricsRows({ ...box, diskTotalBytes: 0 })).toHaveLength(1);
  expect(metricsRows({ ...box, diskPercent: NaN })).toHaveLength(1);
  expect(metricsRows({ ...box, diskFreeBytes: undefined })).toHaveLength(1);
});
