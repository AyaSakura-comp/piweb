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

## Upload deadline

Attachment requests have an explicit **5-minute (300,000ms)** browser deadline, exceeding the required two-minute minimum. It begins at XHR Send and covers transmission plus the server acknowledgement; local image preparation/base64 conversion occurs beforehand and is not included. Node's incoming-request receive budget is also explicitly five minutes. This is not a socket-idle or SSE-stream timeout and does not limit agent inference.

On expiry the request rejects with `Upload timed out after 5 minutes`, allowing the composer to leave its busy state. The best-effort diagnostic is recorded once as `outcome: error`; no automatic retry is made. Check the transcript before retrying, since a lost acknowledgement does not prove the server rejected the message. Network loss, browser suspension and external proxy limits can still interrupt a transfer earlier.

Regression tests use fake clocks to verify a response after 121 seconds remains accepted, five-minute expiry rejects without hanging, and failure telemetry is not duplicated. The API test checks the real Node server's receive budget. These are not physical-phone or real two-minute throttled-network measurements.

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

Tests cover timings, decoded sizes, slow-upload acceptance, deadline rejection,
failure reporting, metric field validation, authentication, cross-origin rejection,
the server receive budget and exclusion of private payload fields.
Both frontend assets and the web endpoint must be deployed; this feature does
not require restarting the agent worker. If telemetry delivery fails, the upload
still completes normally, but no diagnostic record is guaranteed.
