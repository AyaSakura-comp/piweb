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
Refresh PiWeb after deployment to load the instrumented client.
