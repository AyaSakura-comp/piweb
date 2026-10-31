import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'piweb-metrics-'));
  roots.push(root);
  const put = async (path: string, value: string | Uint8Array) => {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, value);
  };
  const { createSystemMetricsSampler } = await import('../src/web/system-metrics.js');
  let now = 1000;
  return {
    put,
    sample: createSystemMetricsSampler({ root, now: () => now }),
    advance: () => {
      now += 1000;
    },
  };
}
it('omits unavailable sensors without failing', async () => {
  const f = await fixture();
  expect(await f.sample()).toEqual({});
});
it('samples memory and CPU deltas, excluding guest counters from totals', async () => {
  const f = await fixture();
  await f.put('proc/meminfo', 'MemTotal: 1000 kB\nMemAvailable: 400 kB\n');
  await f.put('proc/stat', 'cpu 100 0 100 800 0 0 0 0 50 0\n');
  expect(await f.sample()).toEqual({
    memoryUsedBytes: 614400,
    memoryTotalBytes: 1024000,
    memoryPercent: 60,
  });
  f.advance();
  await f.put('proc/stat', 'cpu 150 0 100 850 0 0 0 0 100 0\n');
  expect(await f.sample()).toMatchObject({ cpuPercent: 50 });
});
it('reports installed memory, counting what firmware and the kernel hold back as used', async () => {
  // This box: 64 online 2 GiB blocks = 128 GiB installed, MemTotal 122.8 GiB
  // (a 512 MiB VRAM carve-out and the crash kernel are not in it).
  const f = await fixture();
  const GiB = 2 ** 30;
  await f.put('proc/meminfo', `MemTotal: ${Math.round((122.84 * GiB) / 1024)} kB\nMemAvailable: ${(18 * GiB) / 1024} kB\n`);
  await f.put('sys/devices/system/memory/block_size_bytes', '80000000\n');
  for (let i = 0; i < 64; i++) await f.put(`sys/devices/system/memory/memory${i}/online`, '1\n');
  await f.put('sys/devices/system/memory/auto_online_blocks', 'online\n');
  const reading = await f.sample();
  expect(reading.memoryTotalBytes).toBe(128 * GiB);
  expect(reading.memoryUsedBytes).toBe(110 * GiB);
  expect(reading.memoryPercent).toBeCloseTo(85.94, 2);
});
it('leaves offline blocks out, and falls back to MemTotal when the blocks cannot hold it', async () => {
  const f = await fixture();
  await f.put('proc/meminfo', 'MemTotal: 3000000 kB\nMemAvailable: 1000000 kB\n');
  await f.put('sys/devices/system/memory/block_size_bytes', '40000000');
  for (let i = 0; i < 4; i++) await f.put(`sys/devices/system/memory/memory${i}/online`, i === 3 ? '0' : '1');
  // 3 online 1 GiB blocks = 3 GiB, above MemTotal (2.86 GiB): taken.
  expect((await f.sample()).memoryTotalBytes).toBe(3 * 2 ** 30);

  // Malformed block size, or fewer blocks than MemTotal: MemTotal, never less.
  for (const [size, count] of [['zz', 4], ['40000000', 2]] as const) {
    const g = await fixture();
    await g.put('proc/meminfo', 'MemTotal: 3000000 kB\nMemAvailable: 1000000 kB\n');
    await g.put('sys/devices/system/memory/block_size_bytes', size);
    for (let i = 0; i < count; i++) await g.put(`sys/devices/system/memory/memory${i}/online`, '1');
    expect(await g.sample()).toMatchObject({ memoryTotalBytes: 3072000000, memoryUsedBytes: 2048000000 });
  }
});
it('discovers GPU and CPU hwmon independently and preserves zero usage', async () => {
  const f = await fixture();
  await f.put('sys/class/hwmon/hwmon42/name', 'amdgpu\n');
  await f.put('sys/class/hwmon/hwmon42/temp1_input', '51000');
  await f.put('sys/class/hwmon/hwmon42/power1_average', '32000000');
  await f.put('sys/class/hwmon/hwmon3/name', 'k10temp');
  await f.put('sys/class/hwmon/hwmon3/temp1_input', '61000');
  await f.put('sys/class/drm/card7/device/gpu_busy_percent', '0');
  await f.put('sys/class/accel/accel2/device/npu_busy_percent', '25');
  expect(await f.sample()).toEqual({
    gpuTemperatureC: 51,
    cpuTemperatureC: 61,
    powerWatts: 32,
    powerSource: 'GPU',
    gpuPercent: 0,
    npuPercent: 25,
  });
});
it('rejects malformed/out-of-range sensors rather than displaying fabricated zeros', async () => {
  const f = await fixture();
  await f.put('sys/class/hwmon/hwmon1/name', 'amdgpu');
  await f.put('sys/class/hwmon/hwmon1/temp1_input', 'garbage');
  await f.put('sys/class/hwmon/hwmon1/power1_average', '');
  await f.put('sys/class/drm/card0/device/gpu_busy_percent', '101');
  await f.put('proc/meminfo', 'MemTotal: 10 kB\nMemAvailable: 20 kB');
  expect(await f.sample()).toEqual({});
});
it('uses package energy deltas with counter wrap, not GPU plus package double counting', async () => {
  const f = await fixture();
  await f.put('sys/class/powercap/intel-rapl:0/energy_uj', '90000000');
  await f.put('sys/class/powercap/intel-rapl:0/max_energy_range_uj', '100000000');
  await f.sample();
  f.advance();
  await f.put('sys/class/powercap/intel-rapl:0/energy_uj', '10000000');
  expect(await f.sample()).toMatchObject({ powerWatts: 20, powerSource: 'Package' });
});
function nativeGpuMetrics(powerMilliwatts: number) {
  const data = Buffer.alloc(264);
  data.writeUInt16LE(264, 0);
  data[2] = 3;
  data[3] = 0;
  data.writeUInt32LE(42500, 112); // socket power is adjacent, NOT NPU power
  data.writeUInt16LE(powerMilliwatts, 116);
  return data;
}

it.each([0, 1234, 60000])('reads native NPU power %i mW from gpu_metrics v3.0', async (raw) => {
  const f = await fixture();
  await f.put('sys/class/drm/card9/device/gpu_metrics', nativeGpuMetrics(raw));
  expect(await f.sample()).toEqual({ npuPowerWatts: raw / 1000 });
});

it.each(['truncated', 'format', 'revision', 'size', 'sentinel'])(
  'omits %s gpu_metrics without losing GPU usage',
  async (kind) => {
    const f = await fixture();
    let data = nativeGpuMetrics(1000);
    if (kind === 'truncated') data = data.subarray(0, 118);
    if (kind === 'format') data[2] = 2;
    if (kind === 'revision') data[3] = 1;
    if (kind === 'size') data.writeUInt16LE(136, 0);
    if (kind === 'sentinel') data.writeUInt16LE(0xffff, 116);
    await f.put('sys/class/drm/card1/device/gpu_metrics', data);
    await f.put('sys/class/drm/card1/device/gpu_busy_percent', '0');
    expect(await f.sample()).toEqual({ gpuPercent: 0 });
  },
);

it('hides a previously valid NPU reading when the sensor becomes invalid', async () => {
  const f = await fixture();
  await f.put('sys/class/drm/card1/device/gpu_metrics', nativeGpuMetrics(500));
  expect(await f.sample()).toMatchObject({ npuPowerWatts: 0.5 });
  f.advance();
  await f.put('sys/class/drm/card1/device/gpu_metrics', '');
  expect(await f.sample()).not.toHaveProperty('npuPowerWatts');
});

it('shares cached and in-flight samples across clients', async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([f.sample(), f.sample()]);
  expect(a).toBe(b);
  await f.put('sys/class/drm/card0/device/gpu_busy_percent', '50');
  expect(await f.sample()).toBe(a);
  f.advance();
  expect(await f.sample()).toMatchObject({ gpuPercent: 50 });
});
