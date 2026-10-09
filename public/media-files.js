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

/** `value` if it is an http(s) URL on this page's origin, else ''. */
export function safeSameOriginMediaUrl(value, doc) {
  if (typeof value !== 'string' || value.length === 0) return '';
  try {
    const base = new URL(doc.baseURI || globalThis.location?.href || 'https://piweb.local/');
    const target = new URL(value, base);
    if (!['http:', 'https:'].includes(target.protocol) || target.origin !== base.origin) return '';
    return value;
  } catch {
    return '';
  }
}

/**
 * iOS home-screen save: a normal <a download> strands installed PWAs in an
 * uncloseable Quick Look screen (WebKit bug 236943), so fetch the file on the
 * first tap and hand it to the native share sheet on the second.
 */
export function bindMediaSave(button, getMedia, runtime) {
  let file;
  let preparedUrl = '';

  button.addEventListener('click', async () => {
    const media = getMedia();
    if (!media) return;

    if (file && preparedUrl === media.url) {
      try {
        // WebKit can expire user activation while the first tap fetches the
        // file, so sharing must happen synchronously from this second tap.
        await runtime.navigator.share({ files: [file], title: media.name });
      } catch (error) {
        if (error?.name !== 'AbortError') runtime.alert?.('無法開啟 iPhone 儲存選單，請稍後再試。');
      }
      return;
    }

    file = undefined;
    preparedUrl = '';
    button.disabled = true;
    button.removeAttribute('data-ready');
    button.setAttribute('aria-label', `Preparing ${media.type} ${media.name}`);
    button.setAttribute('aria-busy', 'true');
    try {
      const response = await runtime.fetch(media.url);
      if (!response.ok) throw new Error('media fetch failed');
      const blob = await response.blob();
      const candidate = new runtime.File([blob], media.name, {
        type: blob.type || 'application/octet-stream',
      });
      const shareData = { files: [candidate] };
      if (
        typeof runtime.navigator.canShare !== 'function' ||
        typeof runtime.navigator.share !== 'function' ||
        !runtime.navigator.canShare(shareData)
      ) {
        runtime.alert?.('此 iPhone 無法在主畫面模式安全下載；請改用 Safari 開啟 piweb。');
        button.setAttribute('aria-label', `Save ${media.type} ${media.name}`);
        return;
      }
      file = candidate;
      preparedUrl = media.url;
      button.setAttribute('data-ready', 'true');
      button.setAttribute('aria-label', `Tap again to save ${media.name}`);
      button.title = 'Tap again to save';
    } catch {
      runtime.alert?.('無法準備媒體下載，請稍後再試。');
      button.setAttribute('aria-label', `Save ${media.type} ${media.name}`);
    } finally {
      button.disabled = false;
      button.setAttribute('aria-busy', 'false');
    }
  });
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

/**
 * Build an inline video card with an explicit, mobile-friendly download.
 * With `onOpen`, the card is a poster that starts the video in the stream
 * player dock instead of a native inline player.
 */
export function createVideoAttachment(url, doc = document, runtime = globalThis, onOpen) {
  const name = downloadNameFromMediaUrl(url);
  const card = doc.createElement('div');
  card.className = 'video-file';

  const video = doc.createElement('video');
  video.src = url;
  video.playsInline = true;
  let open;
  if (onOpen) {
    // Poster only: metadata gives the first frame without buffering the file.
    // iOS paints nothing for an unplayed video unless a start time is given.
    video.src = `${url}#t=0.1`;
    video.preload = 'metadata';
    video.muted = true;
    open = doc.createElement('button');
    open.type = 'button';
    open.className = 'video-open';
    open.setAttribute('aria-label', `Play video ${name}`);
    open.addEventListener('click', () => onOpen(url));
  } else {
    video.controls = true;
  }

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

  if (open) card.append(video, open, download);
  else card.append(video, download);
  return card;
}
