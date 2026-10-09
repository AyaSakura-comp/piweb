import { afterEach, expect, it, vi } from 'vitest';
import {
  normalizeMetricsInterval,
  metricsRows,
  createSystemMetricsMonitor,
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
    ['RAM', '8.0 / 16.0 GiB', '50% used'],
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
