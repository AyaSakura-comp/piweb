/**
 * DOM helpers for transcript media attachments.
 *
 * Kept outside app.js so the player/download behavior is testable without
 * booting the whole application shell.
 */

/** Recover a friendly original name from piweb's `<uuid>-<name>` media path. */
export function downloadNameFromMediaUrl(url) {
  let path;
  try {
    path = new URL(String(url), 'https://piweb.local').pathname;
  } catch {
    path = String(url).split(/[?#]/, 1)[0];
  }

  const encoded = path.slice(path.lastIndexOf('/') + 1);
  let name;
  try {
    name = decodeURIComponent(encoded);
  } catch {
    name = encoded;
  }

  // Stored outputs and uploads receive an eight-character random prefix.
  return name.replace(/^[0-9a-f]{8}-/i, '') || 'video';
}

function isIosHomeScreenApp(runtime) {
  return runtime.navigator?.standalone === true;
}

function bindIosVideoSave(button, url, name, runtime) {
  let file;

  button.addEventListener('click', async () => {
    if (file) {
      try {
        // This must run directly in the second tap. WebKit can expire user
        // activation while the first tap waits for the video to download.
        await runtime.navigator.share({ files: [file], title: name });
      } catch (error) {
        if (error?.name !== 'AbortError') runtime.alert?.('無法開啟 iPhone 儲存選單，請稍後再試。');
      }
      return;
    }

    button.disabled = true;
    button.textContent = 'Preparing video…';
    button.setAttribute('aria-label', `Preparing video ${name}`);
    button.setAttribute('aria-busy', 'true');
    try {
      const response = await runtime.fetch(url);
      if (!response.ok) throw new Error('video fetch failed');
      const blob = await response.blob();
      const candidate = new runtime.File([blob], name, {
        type: blob.type || 'application/octet-stream',
      });
      const shareData = { files: [candidate] };
      if (
        typeof runtime.navigator.canShare !== 'function' ||
        typeof runtime.navigator.share !== 'function' ||
        !runtime.navigator.canShare(shareData)
      ) {
        runtime.alert?.('此 iPhone 無法在主畫面模式安全下載；請改用 Safari 開啟 piweb。');
        button.textContent = '↓ Save video';
        button.setAttribute('aria-label', `Save video ${name}`);
        return;
      }
      file = candidate;
      button.textContent = '↓ Tap again to save';
      button.setAttribute('aria-label', `Tap again to save ${name}`);
    } catch {
      runtime.alert?.('無法準備影片下載，請稍後再試。');
      button.textContent = '↓ Save video';
      button.setAttribute('aria-label', `Save video ${name}`);
    } finally {
      button.disabled = false;
      button.setAttribute('aria-busy', 'false');
    }
  });
}

/** Build a native inline player with an explicit, mobile-friendly download. */
export function createVideoAttachment(url, doc = document, runtime = globalThis) {
  const name = downloadNameFromMediaUrl(url);
  const card = doc.createElement('div');
  card.className = 'video-file';

  const video = doc.createElement('video');
  video.src = url;
  video.controls = true;
  video.playsInline = true;

  let download;
  if (isIosHomeScreenApp(runtime)) {
    // A normal <a download> strands installed iOS PWAs in an uncloseable
    // Quick Look screen (WebKit bug 236943), so use native file sharing.
    download = doc.createElement('button');
    download.type = 'button';
    download.textContent = '↓ Save video';
    download.setAttribute('aria-label', `Save video ${name}`);
    bindIosVideoSave(download, url, name, runtime);
  } else {
    download = doc.createElement('a');
    download.href = url;
    download.download = name;
    download.textContent = '↓ Download video';
    download.setAttribute('aria-label', `Download video ${name}`);
  }
  download.className = 'video-download';

  card.append(video, download);
  return card;
}
