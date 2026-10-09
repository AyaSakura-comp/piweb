import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

export interface SystemMetrics {
  cpuPercent?: number;
  gpuPercent?: number;
  npuPercent?: number;
  npuPowerWatts?: number;
  memoryUsedBytes?: number;
  memoryTotalBytes?: number;
  memoryPercent?: number;
  cpuTemperatureC?: number;
  gpuTemperatureC?: number;
  powerWatts?: number;
  powerSource?: 'Package' | 'GPU';
}

/** AMD gpu_metrics_v3_0: same average_ipu_power field used by power-monitor.
 * Known layout only: 264 bytes, uint16 little-endian at offset 116, milliwatts.
 * 0xffff means unavailable; zero is a valid measurement, never an error fallback.
 */
function npuPowerFromGpuMetrics(data: Buffer | undefined): number | undefined {
  if (!data || data.length < 264 || data.readUInt16LE(0) !== 264 || data[2] !== 3 || data[3] !== 0)
    return undefined;
  const milliwatts = data.readUInt16LE(116);
  return milliwatts === 0xffff ? undefined : milliwatts / 1000;
}

/** Read-only, best-effort Linux host telemetry. No commands, elevated access or client paths. */
export function createSystemMetricsSampler({ root = '/', now = () => performance.now() } = {}) {
  let previousCpu: { total: number; idle: number } | undefined;
  let previousEnergy: { path: string; energy: number; time: number } | undefined;
  let cached: SystemMetrics = {};
  let sampledAt = -Infinity;
  let pending: Promise<SystemMetrics> | undefined;
  const text = (path: string) => readFile(join(root, path), 'utf8').catch(() => '');
  const entries = (path: string) => readdir(join(root, path)).catch(() => [] as string[]);
  const number = async (path: string) => {
    const raw = (await text(path)).trim();
    if (!/^\d+(?:\.\d+)?$/.test(raw)) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };
  const bounded = (value: number | undefined, max: number): value is number =>
    value !== undefined && value >= 0 && value <= max;

  async function collect(): Promise<SystemMetrics> {
    const result: SystemMetrics = {};
    const time = now();
    const [stat, meminfo, hwmons, cards, accels, powercaps] = await Promise.all([
      text('proc/stat'),
      text('proc/meminfo'),
      entries('sys/class/hwmon'),
      entries('sys/class/drm'),
      entries('sys/class/accel'),
      entries('sys/class/powercap'),
    ]);
    const rawCpu = stat
      .match(/^cpu\s+(.+)$/m)?.[1]
      .trim()
      .split(/\s+/)
      .slice(0, 8)
      .map(Number);
    if (rawCpu && rawCpu.length >= 4 && rawCpu.every((n) => Number.isFinite(n) && n >= 0)) {
      const cpu = { total: rawCpu.reduce((a, b) => a + b, 0), idle: rawCpu[3] + (rawCpu[4] ?? 0) };
      if (previousCpu) {
        const delta = cpu.total - previousCpu.total;
        const idle = cpu.idle - previousCpu.idle;
        if (delta > 0 && idle >= 0 && idle <= delta)
          result.cpuPercent = (100 * (delta - idle)) / delta;
      }
      previousCpu = cpu;
    } else previousCpu = undefined;
    const total = Number(meminfo.match(/^MemTotal:\s+(\d+)\s+kB/m)?.[1]) * 1024;
    const available = Number(meminfo.match(/^MemAvailable:\s+(\d+)\s+kB/m)?.[1]) * 1024;
    if (total > 0 && bounded(available, total)) {
      result.memoryTotalBytes = total;
      result.memoryUsedBytes = total - available;
      result.memoryPercent = (100 * (total - available)) / total;
    }
    // Discover sensor indices on every sample: hot removal/permission changes naturally disappear.
    await Promise.all(
      hwmons
        .filter((n) => /^hwmon\d+$/.test(n))
        .map(async (name) => {
          const path = `sys/class/hwmon/${name}`;
          const driver = (await text(`${path}/name`)).trim();
          if (!['amdgpu', 'k10temp', 'coretemp'].includes(driver)) return;
          const temp = await number(`${path}/temp1_input`);
          if (bounded(temp, 150000)) {
            const key = driver === 'amdgpu' ? 'gpuTemperatureC' : 'cpuTemperatureC';
            result[key] = Math.max(result[key] ?? 0, temp / 1000);
          }
          if (driver === 'amdgpu') {
            const power =
              (await number(`${path}/power1_average`)) ?? (await number(`${path}/power1_input`));
            if (bounded(power, 2000000000)) {
              result.powerWatts = power / 1e6;
              result.powerSource = 'GPU';
            }
          }
        }),
    );
    await Promise.all(
      cards
        .filter((n) => /^card\d+$/.test(n))
        .map(async (name) => {
          const [busy, nativeMetrics] = await Promise.all([
            number(`sys/class/drm/${name}/device/gpu_busy_percent`),
            readFile(join(root, `sys/class/drm/${name}/device/gpu_metrics`)).catch(() => undefined),
          ]);
          if (bounded(busy, 100)) result.gpuPercent = Math.max(result.gpuPercent ?? 0, busy);
          const npuWatts = npuPowerFromGpuMetrics(nativeMetrics);
          if (npuWatts !== undefined)
            result.npuPowerWatts = Math.max(result.npuPowerWatts ?? 0, npuWatts);
        }),
    );
    await Promise.all(
      accels
        .filter((n) => /^accel\d+$/.test(n))
        .map(async (name) => {
          // Only a real utilization counter is accepted; runtime_status is NOT utilization.
          const busy = await number(`sys/class/accel/${name}/device/npu_busy_percent`);
          if (bounded(busy, 100)) result.npuPercent = Math.max(result.npuPercent ?? 0, busy);
        }),
    );
    const packageName = powercaps.sort().find((n) => /^(?:intel|amd)-rapl:\d+$/.test(n));
    if (packageName) {
      const path = `sys/class/powercap/${packageName}`;
      const energy = await number(`${path}/energy_uj`);
      const range = await number(`${path}/max_energy_range_uj`);
      if (energy !== undefined) {
        if (previousEnergy?.path === path && time > previousEnergy.time) {
          let delta = energy - previousEnergy.energy;
          if (delta < 0 && range !== undefined && range > previousEnergy.energy && energy < range)
            delta += range;
          const watts = delta / (time - previousEnergy.time) / 1000;
          if (bounded(watts, 2000)) {
            result.powerWatts = watts;
            result.powerSource = 'Package';
          }
        }
        previousEnergy = { path, energy, time };
      } else previousEnergy = undefined;
    } else previousEnergy = undefined;
    cached = result;
    sampledAt = time;
    return result;
  }
  return function sample(): Promise<SystemMetrics> {
    if (pending) return pending;
    if (now() - sampledAt < 500) return Promise.resolve(cached);
    pending = collect().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}

export const sampleSystemMetrics = createSystemMetricsSampler();
