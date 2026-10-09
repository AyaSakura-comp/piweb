# Host system metrics

The Sessions drawer displays a compact live host-telemetry panel beneath its header. Settings → 主機監控 → 數字更新間隔（秒） accepts whole seconds from 1–60, defaults to 1, and persists in this browser's localStorage. Invalid input resets to 1. Polling starts after authentication, pauses in hidden tabs, resumes immediately on return, and stops/clears on logout. Requests have a five-second timeout and cannot overlap.

## Data and fault handling

Authenticated `GET /api/system-metrics` returns a no-store JSON snapshot. Reads are best-effort and cached for 500 ms across concurrent clients. Unreadable, absent, empty, malformed or out-of-range metrics are omitted; a failed API request hides the panel until a later successful request. Zero utilization is a valid reading, not a missing value. No subprocesses, elevated permissions or user-supplied filesystem paths are used.

- CPU utilization: deltas of the aggregate `/proc/stat` CPU counters (guest counters excluded). The first sample has no CPU percentage.
- RAM: `(MemTotal - MemAvailable) / MemTotal` from `/proc/meminfo`; displayed as used / total GiB.
- CPU temperature: `k10temp` or `coretemp` hwmon `temp1_input`.
- GPU temperature/power: discovered `amdgpu` hwmon `temp1_input`, `power1_average` (fallback `power1_input`).
- Package power: RAPL package `energy_uj` deltas with wrap handling when readable; takes precedence over GPU power rather than adding overlapping power domains. Tooltip identifies the source; this is not wall/socket power.
- GPU utilization: discovered DRM `gpu_busy_percent` counters (maximum on multi-GPU hosts).
- NPU power: discovered DRM `card*/device/gpu_metrics`, using the same `average_ipu_power` field as power-monitor. Accepts only the known `gpu_metrics_v3_0` layout (header format 3, content revision 0, structure size 264 bytes); reads uint16 LE at byte offset 116, in milliwatts. `0xffff` is unavailable and omitted; an actual zero is displayed as `NPU power 0.00 W`. Unknown/truncated layouts or unreadable files are omitted, not estimated or replaced by zero. Multiple valid tables use the highest reading, not a sum that might double-count the same integrated NPU.
- NPU utilization: `accel*/device/npu_busy_percent` only if provided by the driver. Device presence or runtime active status is never shown as utilization. The current XDNA driver on this host does not provide this counter, so its utilization percentage is hidden independently of NPU watts. `average_ipu_activity` is not exposed by this change.

The current Docker runtime exposes the host `/proc/stat`, `/proc/meminfo` and relevant `/sys/class` sensors. No additional mounts or privileged container mode are required on this host. Other platforms without these Linux files simply show no telemetry. For multiple CPU/GPU temperature sensors, the highest temperature is shown; telemetry is a host overview, not a per-device inventory.

## Verification

- Unit/API/lifecycle: `npx vitest run test/system-metrics*.ts`
- Maintained mobile E2E: `npx playwright test test/e2e/system-metrics.spec.ts`
- No special credentials required: E2E uses loopback fixture server and API interception, not live account data.
- Evidence: `artifacts/playwright/test-results/system-metrics-*/` (screenshots and one continuous walkthrough video).
- Covered: native NPU milliwatt conversion and correct field offset, malformed/unsupported/truncated binary layouts, sentinel omission, disappearance after a valid reading becomes invalid; drawer numbers and overflow, default interval, reachable 44px input, saving/reloading preference, invalid input reset, disappearing unavailable metrics, recovery preserving GPU 0% and NPU 0.00 W.
- Typecheck: `npx tsc --noEmit`
- Deployment is separate: rebuild/restart through the restart-service hub after deciding whether the other pre-existing dirty changes should also be deployed.
