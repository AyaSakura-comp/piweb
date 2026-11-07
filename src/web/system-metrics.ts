import { execFile } from 'node:child_process';
import { readFile, readdir, statfs } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { config } from '../config.js';

export interface SystemMetrics {
  cpuPercent?: number;
  gpuPercent?: number;
  npuPercent?: number;
  npuPowerWatts?: number;
  memoryUsedBytes?: number;
  memoryTotalBytes?: number;
  memoryPercent?: number;
  diskUsedBytes?: number;
  diskTotalBytes?: number;
  diskFreeBytes?: number;
  diskPercent?: number;
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

type DiskStats = { bsize: number; blocks: number; bfree: number; bavail: number };
type CpuTimes = { user: number; nice: number; sys: number; idle: number; irq: number };

/** Runs a fixed system binary (no shell), resolving its stdout or '' on any failure. */
export function runReadOnly(file: string, args: string[]): Promise<string> {
  return new Promise((resolveOutput) => {
    execFile(file, args, { timeout: 2000, maxBuffer: 1 << 20 }, (error, stdout) =>
      resolveOutput(error ? '' : String(stdout)),
    );
  });
}

/**
 * macOS memory as Activity Monitor's "Memory Used" counts it: app memory
 * (anonymous pages minus purgeable) + wired + what the compressor occupies.
 * `vm_stat` prints counts in pages of the size given in its header line.
 */
export function macMemoryFromVmStat(
  vmStat: string,
  totalBytes: number,
): { used: number; total: number } | undefined {
  const pageSize = Number(vmStat.match(/page size of (\d+) bytes/)?.[1]);
  const pages = (label: string) => {
    const match = new RegExp(`^${label}:\\s+(\\d+)\\.?$`, 'm').exec(vmStat);
    return match ? Number(match[1]) : undefined;
  };
  const anonymous = pages('Anonymous pages');
  const purgeable = pages('Pages purgeable');
  const wired = pages('Pages wired down');
  const compressed = pages('Pages occupied by compressor');
  if (!(pageSize > 0) || !(totalBytes > 0)) return undefined;
  if ([anonymous, purgeable, wired, compressed].some((n) => n === undefined)) return undefined;
  const used = (Math.max(0, anonymous! - purgeable!) + wired! + compressed!) * pageSize;
  return used <= totalBytes ? { used, total: totalBytes } : undefined;
}

/**
 * Apple GPU utilization from the IOAccelerator's PerformanceStatistics
 * ("Device Utilization %"), readable without root. The highest across GPUs.
 */
export function macGpuPercentFromIoreg(ioreg: string): number | undefined {
  let best: number | undefined;
  for (const match of ioreg.matchAll(/"Device Utilization %"=(\d+)/g)) {
    const value = Number(match[1]);
    if (value >= 0 && value <= 100) best = Math.max(best ?? 0, value);
  }
  return best;
}

/**
 * Read-only, best-effort host telemetry; never elevated access or client paths.
 * Linux reads /proc and /sys with no commands. macOS has neither, so it reads
 * CPU times from the kernel (os.cpus) and runs two fixed read-only binaries,
 * `vm_stat` (memory) and `ioreg` (GPU); temperatures and power need root there
 * (powermetrics) and are not shown.
 * `diskPath` is a server-chosen directory whose filesystem the Disk reading describes.
 */
export function createSystemMetricsSampler({
  root = '/',
  now = () => performance.now(),
  diskPath,
  statDisk = (path: string): Promise<DiskStats> => statfs(path),
  platform = 'linux',
  run = runReadOnly,
  cpuTimes = () => cpus().map((cpu) => cpu.times),
  totalMemory = totalmem,
}: {
  root?: string;
  now?: () => number;
  diskPath?: string;
  statDisk?: (path: string) => Promise<DiskStats>;
  platform?: NodeJS.Platform;
  run?: (file: string, args: string[]) => Promise<string>;
  cpuTimes?: () => CpuTimes[];
  totalMemory?: () => number;
} = {}) {
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

  // Installed memory as lsmem counts it: online memory blocks × block size.
  // MemTotal leaves out what firmware and the kernel hold back (an APU's VRAM
  // carve-out, the crash kernel), so this 128 GiB box read 122.8. Read again
  // only when MemTotal moves (hotplug), not on every sample.
  let installed: { memTotal: number; bytes: number | undefined } | undefined;
  async function installedMemory(memTotal: number): Promise<number | undefined> {
    if (installed?.memTotal === memTotal) return installed.bytes;
    const dir = 'sys/devices/system/memory';
    const raw = (await text(`${dir}/block_size_bytes`)).trim();
    const size = /^[0-9a-f]+$/i.test(raw) ? parseInt(raw, 16) : NaN;
    let bytes: number | undefined;
    if (Number.isSafeInteger(size) && size > 0) {
      const blocks = (await entries(dir)).filter((n) => /^memory\d+$/.test(n));
      const online = await Promise.all(
        blocks.map(async (n) => (await text(`${dir}/${n}/online`)).trim() === '1'),
      );
      bytes = online.filter(Boolean).length * size;
    }
    installed = { memTotal, bytes };
    return bytes;
  }

  function applyDisk(result: SystemMetrics, disk: DiskStats | undefined): void {
    if (disk) {
      // As df counts it: used = blocks − free; the percent is of what users can
      // fill (used + available), so root's reserved blocks are not counted as room.
      const { bsize, blocks, bfree, bavail } = disk;
      const valid = [bsize, blocks, bfree, bavail].every((n) => Number.isSafeInteger(n) && n >= 0);
      if (valid && bsize > 0 && blocks > 0 && bfree <= blocks && bavail <= bfree) {
        const used = (blocks - bfree) * bsize;
        const free = bavail * bsize;
        result.diskTotalBytes = blocks * bsize;
        result.diskUsedBytes = used;
        result.diskFreeBytes = free;
        result.diskPercent = used + free > 0 ? (100 * used) / (used + free) : 0;
      }
    }
  }

  async function collectMac(): Promise<SystemMetrics> {
    const result: SystemMetrics = {};
    const time = now();
    const [vmStat, ioreg, disk] = await Promise.all([
      run('/usr/bin/vm_stat', []),
      run('/usr/sbin/ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator']),
      diskPath ? statDisk(diskPath).catch(() => undefined) : undefined,
    ]);
    // Aggregate CPU time across cores, as /proc/stat's first line is on Linux.
    const times = cpuTimes();
    if (times.length > 0) {
      const sum = (pick: (t: CpuTimes) => number) => times.reduce((a, t) => a + pick(t), 0);
      const cpu = {
        total: sum((t) => t.user + t.nice + t.sys + t.idle + t.irq),
        idle: sum((t) => t.idle),
      };
      if (previousCpu) {
        const delta = cpu.total - previousCpu.total;
        const idle = cpu.idle - previousCpu.idle;
        if (delta > 0 && idle >= 0 && idle <= delta)
          result.cpuPercent = (100 * (delta - idle)) / delta;
      }
      previousCpu = cpu;
    } else previousCpu = undefined;
    const memory = macMemoryFromVmStat(vmStat, totalMemory());
    if (memory) {
      result.memoryTotalBytes = memory.total;
      result.memoryUsedBytes = memory.used;
      result.memoryPercent = (100 * memory.used) / memory.total;
    }
    applyDisk(result, disk);
    const gpu = macGpuPercentFromIoreg(ioreg);
    if (gpu !== undefined) result.gpuPercent = gpu;
    cached = result;
    sampledAt = time;
    return result;
  }

  async function collect(): Promise<SystemMetrics> {
    const result: SystemMetrics = {};
    const time = now();
    const [stat, meminfo, hwmons, cards, accels, powercaps, disk] = await Promise.all([
      text('proc/stat'),
      text('proc/meminfo'),
      entries('sys/class/hwmon'),
      entries('sys/class/drm'),
      entries('sys/class/accel'),
      entries('sys/class/powercap'),
      diskPath ? statDisk(diskPath).catch(() => undefined) : undefined,
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
      // What firmware and the kernel hold back is in use too: used + available = installed.
      const blocks = await installedMemory(total);
      const capacity = blocks !== undefined && blocks >= total ? blocks : total;
      result.memoryTotalBytes = capacity;
      result.memoryUsedBytes = capacity - available;
      result.memoryPercent = (100 * (capacity - available)) / capacity;
    }
    applyDisk(result, disk);
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
    pending = (platform === 'darwin' ? collectMac() : collect()).finally(() => {
      pending = undefined;
    });
    return pending;
  };
}

// The disk that holds piweb's data: in the container it is the host's disk,
// bind-mounted (the container's own `/` is an overlay).
export const sampleSystemMetrics = createSystemMetricsSampler({
  diskPath: dirname(config.dbPath),
  platform: process.platform,
});
