/** Clamp upload percentages to a value suitable for CSS and ARIA. */
function normalizedPercent(value) {
  const numeric = Number.isFinite(value) ? value : 0;
  return Math.round(Math.max(0, Math.min(100, numeric)));
}

/** Show and update the composer's accessible upload progress bar. */
export function showUploadProgress({ container, bar, percent }, value) {
  const next = normalizedPercent(value);
  container.hidden = false;
  container.setAttribute('aria-valuenow', String(next));
  bar.style.width = `${next}%`;
  percent.textContent = `${next}%`;
}

/** Hide and reset progress so the next upload always starts from zero. */
export function hideUploadProgress({ container, bar, percent }) {
  container.hidden = true;
  container.setAttribute('aria-valuenow', '0');
  bar.style.width = '0%';
  percent.textContent = '0%';
}

/**
 * POST JSON with XMLHttpRequest so browsers expose upload byte progress.
 * Fetch intentionally has no request-body progress API.
 */
export function sendJsonWithUploadProgress(path, payload, options = {}) {
  const createRequest = options.createRequest ?? (() => new XMLHttpRequest());
  const onProgress = options.onProgress ?? (() => {});
  const request = createRequest();
  const now = options.now ?? (() => performance.now());
  const report =
    options.report ??
    ((record) =>
      fetch('/api/upload-metrics', {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(record),
      }).catch(() => {}));
  const serialized = JSON.stringify(payload);
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  const fileBytes = attachments.reduce((sum, item) => {
    const data = typeof item.dataBase64 === 'string' ? item.dataBase64 : '';
    return (
      sum +
      Math.max(
        0,
        Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0),
      )
    );
  }, 0);
  let started = 0;
  let uploadMs = null;
  let reported = false;
  const finish = (outcome) => {
    if (reported) return;
    reported = true;
    try {
      Promise.resolve(
        report({
          fileBytes,
          fileCount: attachments.length,
          bodyBytes: new TextEncoder().encode(serialized).length,
          uploadMs,
          totalMs: Math.max(0, now() - started),
          status: request.status,
          outcome,
        }),
      ).catch(() => {});
    } catch {
      /* Telemetry must never affect sending a message. */
    }
  };
  request.upload.addEventListener('load', () => {
    uploadMs = Math.max(0, now() - started);
  });

  return new Promise((resolve, reject) => {
    request.open('POST', path, true);
    request.withCredentials = true;
    // Includes body transmission and the acknowledgement, but not local file preparation.
    request.timeout = 5 * 60 * 1000;
    request.setRequestHeader('content-type', 'application/json');

    request.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable || event.total <= 0) return;
      onProgress(Math.round((event.loaded / event.total) * 100));
    });

    request.addEventListener('load', () => {
      finish('response');
      const succeeded = request.status >= 200 && request.status < 300;
      let body = null;
      if (request.responseText) {
        try {
          body = JSON.parse(request.responseText);
        } catch {
          if (succeeded) {
            reject(new Error('Invalid response from server'));
            return;
          }
        }
      }

      if (!succeeded) {
        const error = new Error(body?.error || `Request failed (${request.status})`);
        error.status = request.status;
        reject(error);
        return;
      }

      onProgress(100);
      resolve(body);
    });

    request.addEventListener('error', () => {
      finish('error');
      reject(new Error('Upload failed. Check your connection.'));
    });
    request.addEventListener('abort', () => {
      finish('abort');
      reject(new Error('Upload cancelled'));
    });
    request.addEventListener('timeout', () => {
      finish('error');
      reject(new Error('Upload timed out after 5 minutes. Check your connection before retrying.'));
    });

    onProgress(0);
    started = now();
    request.send(serialized);
  });
}
