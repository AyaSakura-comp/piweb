const INTERVAL_KEY = 'piweb.metricsIntervalSeconds';

export function normalizeMetricsInterval(value) {
  const seconds = Number(value);
  return Number.isInteger(seconds) && seconds >= 1 && seconds <= 60 ? seconds : 1;
}

export function metricsRows(data = {}) {
  const rows = [];
  const valid = (value, max) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
  if (valid(data.powerWatts, 2000))
    rows.push([
      'Power',
      `${data.powerWatts.toFixed(1)} W`,
      `${data.powerSource === 'Package' ? 'Package' : 'GPU'} power, not wall power`,
    ]);
  if (valid(data.npuPowerWatts, 65.534))
    rows.push([
      'NPU power',
      `${data.npuPowerWatts.toFixed(2)} W`,
      'NPU power from AMD gpu_metrics',
    ]);
  for (const [key, label] of [
    ['cpuTemperatureC', 'CPU temp'],
    ['gpuTemperatureC', 'GPU temp'],
  ]) {
    if (valid(data[key], 150)) rows.push([label, `${data[key].toFixed(0)}°C`, `${label}erature`]);
  }
  if (
    valid(data.memoryTotalBytes, Number.MAX_SAFE_INTEGER) &&
    data.memoryTotalBytes > 0 &&
    valid(data.memoryUsedBytes, data.memoryTotalBytes) &&
    valid(data.memoryPercent, 100)
  ) {
    rows.push([
      'RAM',
      `${(data.memoryUsedBytes / 2 ** 30).toFixed(1)} / ${(data.memoryTotalBytes / 2 ** 30).toFixed(1)} GiB`,
      `${data.memoryPercent.toFixed(0)}% used`,
    ]);
  }
  for (const [key, label] of [
    ['cpuPercent', 'CPU'],
    ['gpuPercent', 'GPU'],
    ['npuPercent', 'NPU'],
  ]) {
    if (valid(data[key], 100))
      rows.push([label, `${data[key].toFixed(0)}%`, `${label} utilization`]);
  }
  return rows;
}

/** Single-flight polling. Hidden tabs/logged-out clients stop; stale responses cannot repaint. */
export function createSystemMetricsMonitor({ fetchMetrics, render, storage, isVisible }) {
  let interval = 1;
  try {
    interval = normalizeMetricsInterval(storage?.getItem(INTERVAL_KEY));
  } catch {
    /* optional storage */
  }
  let enabled = false;
  let generation = 0;
  let timer;
  let controller;
  let pending = false;
  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    clearTimer();
    if (enabled && isVisible() && !pending) timer = setTimeout(() => void poll(), interval * 1000);
  };
  async function poll() {
    if (!enabled || !isVisible() || pending) return;
    pending = true;
    const version = generation;
    controller = new AbortController();
    try {
      const data = await fetchMetrics(controller.signal);
      if (version === generation && enabled && isVisible()) render(data);
    } catch {
      if (version === generation && enabled) render({});
    } finally {
      pending = false;
      controller = undefined;
      // A resumed tab / new login gets a fresh sample, not the aborted old request.
      if (version !== generation && enabled && isVisible()) void poll();
      else schedule();
    }
  }
  function invalidate() {
    generation++;
    clearTimer();
    controller?.abort();
    render({});
  }
  return {
    get interval() {
      return interval;
    },
    start() {
      if (enabled) return;
      enabled = true;
      void poll();
    },
    stop() {
      enabled = false;
      invalidate();
    },
    setInterval(value) {
      interval = normalizeMetricsInterval(value);
      try {
        storage?.setItem(INTERVAL_KEY, String(interval));
      } catch {
        /* optional storage */
      }
      schedule();
      return interval;
    },
    visibilityChanged() {
      invalidate();
      if (enabled && isVisible()) void poll();
    },
  };
}

export function mountSystemMetrics({ panel, input, document, storage, fetch = globalThis.fetch }) {
  const render = (data) => {
    const rows = metricsRows(data);
    panel.replaceChildren(
      ...rows.map(([label, value, title]) => {
        const row = document.createElement('span');
        row.className = 'host-metric';
        row.title = title;
        const name = document.createElement('span');
        name.textContent = label;
        const number = document.createElement('strong');
        number.textContent = value;
        row.append(name, number);
        return row;
      }),
    );
    panel.hidden = rows.length === 0;
  };
  const monitor = createSystemMetricsMonitor({
    storage,
    render,
    isVisible: () => !document.hidden,
    fetchMetrics: async (signal) => {
      const timeout = new AbortController();
      const abort = () => timeout.abort();
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, 5000);
      try {
        const response = await fetch('/api/system-metrics', {
          signal: timeout.signal,
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('Telemetry unavailable');
        return await response.json();
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      }
    },
  });
  input.value = String(monitor.interval);
  input.addEventListener('change', () => {
    input.value = String(monitor.setInterval(input.value));
  });
  document.addEventListener('visibilitychange', () => monitor.visibilityChanged());
  return monitor;
}
