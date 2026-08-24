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

function createSvgIcon(doc, kind) {
  const namespace = 'http://www.w3.org/2000/svg';
  const create = (tag) =>
    typeof doc.createElementNS === 'function'
      ? doc.createElementNS(namespace, tag)
      : doc.createElement(tag);
  const svg = create('svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const paths =
    kind === 'download'
      ? ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3']
      : ['M6 6l12 12', 'M18 6L6 18'];
  for (const data of paths) {
    const path = create('path');
    path.setAttribute('d', data);
    svg.append(path);
  }
  return svg;
}

function safeSameOriginMediaUrl(value, doc) {
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

function bindIosViewerSave(button, getMedia, runtime) {
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

/**
 * Build the full-screen player used by Media gallery video/audio tiles.
 * The gallery remains underneath so closing the player returns to the same
 * scroll position instead of navigating away from Piweb.
 */
export function createMediaViewer(doc = document, runtime = globalThis) {
  const root = doc.createElement('div');
  root.className = 'media-player';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Media player');

  const bar = doc.createElement('header');
  bar.className = 'media-player-bar';
  const title = doc.createElement('span');
  title.className = 'media-player-title';

  const actions = doc.createElement('div');
  actions.className = 'media-player-actions';
  const iosHomeScreen = isIosHomeScreenApp(runtime);
  const download = doc.createElement(iosHomeScreen ? 'button' : 'a');
  download.className = 'icon-btn media-player-download';
  if (iosHomeScreen) download.type = 'button';
  download.append(createSvgIcon(doc, 'download'));

  const closeButton = doc.createElement('button');
  closeButton.className = 'icon-btn media-player-close';
  closeButton.type = 'button';
  closeButton.title = 'Close';
  closeButton.setAttribute('aria-label', 'Close media player');
  closeButton.append(createSvgIcon(doc, 'close'));
  actions.append(download, closeButton);
  bar.append(title, actions);

  const stage = doc.createElement('div');
  stage.className = 'media-player-stage';
  const video = doc.createElement('video');
  video.className = 'media-player-video';
  video.controls = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.hidden = true;
  const audio = doc.createElement('audio');
  audio.className = 'media-player-audio';
  audio.controls = true;
  audio.preload = 'metadata';
  audio.hidden = true;
  stage.append(video, audio);
  root.append(bar, stage);

  let activeMedia;
  let previousBodyOverflow = '';
  let previousFocus;

  function release(player) {
    player.pause();
    player.removeAttribute('src');
    player.load();
    player.hidden = true;
  }

  function close() {
    if (root.hidden) return;
    root.hidden = true;
    activeMedia = undefined;
    release(video);
    release(audio);
    doc.body.style.overflow = previousBodyOverflow;
    const focusTarget = previousFocus;
    previousFocus = undefined;
    if (focusTarget?.isConnected !== false) focusTarget?.focus?.({ preventScroll: true });
  }

  function open(item, opener = doc.activeElement) {
    if (item.type !== 'video' && item.type !== 'audio') return false;
    const url = safeSameOriginMediaUrl(item.url, doc);
    if (!url) return false;

    release(video);
    release(audio);

    const name = downloadNameFromMediaUrl(url);
    const player = item.type === 'video' ? video : audio;
    activeMedia = { type: item.type, url, name };
    title.textContent = name;
    if (!iosHomeScreen) {
      download.href = url;
      download.download = name;
    } else {
      download.removeAttribute('data-ready');
    }
    download.title = `Download ${item.type}`;
    download.setAttribute('aria-label', `Download ${item.type} ${name}`);
    player.src = url;
    player.hidden = false;

    if (root.hidden) {
      previousBodyOverflow = doc.body.style.overflow;
      previousFocus = opener;
    }
    root.hidden = false;
    doc.body.style.overflow = 'hidden';
    closeButton.focus({ preventScroll: true });
    return true;
  }

  if (iosHomeScreen) bindIosViewerSave(download, () => activeMedia, runtime);
  closeButton.addEventListener('click', close);
  root.addEventListener('click', (event) => {
    if (event.target === root || event.target === stage) close();
  });
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Tab' || !activeMedia) return;

    const activePlayer = activeMedia.type === 'video' ? video : audio;
    const focusables = [download, closeButton, activePlayer];
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && doc.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && doc.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  return { element: root, open, close };
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
