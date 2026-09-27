# Upload diagnostics

The composer records browser-reported metrics via authenticated, same-origin
`POST /api/upload-metrics`. Records appear in the web container's structured log
with message `Upload metrics`. No filenames, attachment bodies, message text,
authentication credentials or session identifiers are included.

Fields: `fileBytes` (decoded attachments), `fileCount`, `bodyBytes` (UTF-8 JSON,
including base64 overhead), `uploadMs` (XHR upload load event minus send time;
null if not observed), `totalMs` (send to response/error/abort), HTTP `status`,
`outcome`, and server-observed telemetry `route` (`funnel`, `tailscale`, `unknown`).
The logger supplies the receipt timestamp. Durations exclude file selection,
base64 conversion and JSON serialization. Upload completion is the browser's
observation, not proof of disk durability; total time includes response handling
latency, not model inference. Telemetry request routing does not prove the upload
used the same path or distinguish Tailscale direct connections from DERP.

Reports are best effort, never block a message, and can be lost when offline,
closing the tab, or when authentication expires. No retroactive measurement is
possible. Records follow Docker logging retention and are not a durable database.
Validation allowlists fields and bounds numeric values; client reports are not
trusted accounting data.

Inspect on the host: `docker logs --since 1h piweb-app 2>&1 | grep 'Upload metrics'`.
Refresh PiWeb after deployment to load the instrumented client. Timings currently
appear in logs only, not in the composer or message card.

## Reading a result

A recorded single-image upload had `fileBytes: 2349505`, `bodyBytes: 3132755`,
`uploadMs: 1542`, `totalMs: 1840`, `status: 200`, `route: tailscale`.
That means 2.35 MB of image data, 3.13 MB of JSON request data, 1.54 seconds to
the browser's upload-complete event and 1.84 seconds until the response. It is
one observation, not a guaranteed throughput or proof of a direct WireGuard path.
The larger request is expected from base64 encoding. A Tailscale-connected client
can reach the same `*.ts.net` hostname privately; the hostname alone does not prove
Funnel usage.

## Tests and deployment

```bash
npx vitest run test/upload-progress.test.ts test/upload-metrics.test.ts \
  test/upload-metrics-api.test.ts
```

Tests cover timings, decoded sizes, failure reporting, metric field validation,
authentication, cross-origin rejection and exclusion of private payload fields.
Both frontend assets and the web endpoint must be deployed; this feature does
not require restarting the agent worker. If telemetry delivery fails, the upload
still completes normally, but no diagnostic record is guaranteed.
