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

  return new Promise((resolve, reject) => {
    request.open('POST', path, true);
    request.withCredentials = true;
    request.setRequestHeader('content-type', 'application/json');

    request.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable || event.total <= 0) return;
      onProgress(Math.round((event.loaded / event.total) * 100));
    });

    request.addEventListener('load', () => {
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

    request.addEventListener('error', () =>
      reject(new Error('Upload failed. Check your connection.')),
    );
    request.addEventListener('abort', () => reject(new Error('Upload cancelled')));

    onProgress(0);
    request.send(JSON.stringify(payload));
  });
}
