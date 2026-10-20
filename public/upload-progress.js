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

// What the server accepted before it reported its own limits in /api/me:
// 25 MB per file and a 64 MB JSON body (files travel base64-encoded, +33%).
export const DEFAULT_UPLOAD_LIMITS = Object.freeze({
  file: 25 * 1024 * 1024,
  body: 64 * 1024 * 1024,
});

const base64Length = (bytes) => Math.ceil(bytes / 3) * 4;

function formatMegabytes(bytes) {
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

/**
 * Explain why these attachments cannot be sent, before anything is uploaded,
 * or return '' when they fit. Images that will be recompressed are skipped:
 * their final size is not known yet and is far below either limit.
 */
export function attachmentLimitProblem(
  attachments,
  limits = DEFAULT_UPLOAD_LIMITS,
  { compressImages = false } = {},
) {
  const sized = attachments.filter((a) => !(compressImages && a.isImage));
  const tooBig = sized.find((a) => limits.file > 0 && a.file.size > limits.file);
  if (tooBig) {
    return `${tooBig.name} 有 ${formatMegabytes(tooBig.file.size)}，超過單檔上限 ${formatMegabytes(limits.file)}。請先壓縮或剪短再傳。`;
  }
  const encoded = sized.reduce((sum, a) => sum + base64Length(a.file.size), 0);
  // Leave 1 MB of the body for the JSON envelope and message text.
  if (limits.body > 0 && encoded > limits.body - 1024 * 1024) {
    const total = sized.reduce((sum, a) => sum + a.file.size, 0);
    const room = Math.floor(((limits.body - 1024 * 1024) / 4) * 3);
    return `這次附件合計 ${formatMegabytes(total)}，超過一次可傳的 ${formatMegabytes(room)}。請分成幾則訊息傳送。`;
  }
  return '';
}

/** Server limits from /api/me, falling back to the old fixed ones. */
export function uploadLimitsFrom(me) {
  const file = Number(me?.maxAttachmentBytes);
  const body = Number(me?.maxUploadBodyBytes);
  return {
    file: Number.isFinite(file) && file >= 0 ? file : DEFAULT_UPLOAD_LIMITS.file,
    body: Number.isFinite(body) && body > 0 ? body : DEFAULT_UPLOAD_LIMITS.body,
  };
}
