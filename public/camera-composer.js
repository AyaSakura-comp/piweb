import { createCameraEffects, classifyLens } from './camera-effects.js';

// Local-only preview. Frames leave the device only through the normal send flow.
export function createCameraComposer({ send, anchor, canOpen, onCapture }) {
  const pane = document.createElement('section');
  pane.id = 'camera-pane';
  pane.hidden = true;
  pane.setAttribute('aria-label', '相機預覽');
  pane.innerHTML = `<div class="camera-view"><div class="camera-frame"><video id="camera-preview" autoplay muted playsinline></video></div>
    <span class="camera-badge">LIVE · 僅本機預覽</span>
    <div class="camera-actions"><button type="button" id="camera-flip" aria-label="切換前後鏡頭">⇄</button><button type="button" id="camera-close" aria-label="關閉相機">✕</button></div>
    <p id="camera-status" role="status"></p></div>
    <div class="camera-controls"><div class="camera-zoom-row"><label for="camera-zoom">變焦</label><input id="camera-zoom" type="range" min="1" max="4" step="0.1" value="1"><output id="camera-zoom-value">1.0× 數位</output></div><div class="camera-shutter-row"><span id="camera-batch-count" role="status">待送 0 張</span><button type="button" id="camera-shutter" aria-label="拍照加入待送照片" disabled><span></span></button><button type="button" id="camera-send" aria-label="送出待送照片" disabled>送出 ↑</button></div></div>`;
  const divider = document.createElement('div');
  divider.id = 'camera-divider';
  divider.hidden = true;
  divider.tabIndex = 0;
  divider.setAttribute('role', 'separator');
  divider.setAttribute('aria-label', '調整相機與對話高度');
  divider.setAttribute('aria-orientation', 'horizontal');
  divider.setAttribute('aria-valuemin', '0');
  anchor.parentElement.querySelector('.composer-wrap').after(divider, pane);
  const video = pane.querySelector('video');
  const shutter = pane.querySelector('#camera-shutter');
  const batchSend = pane.querySelector('#camera-send');
  const input = document.getElementById('input');
  let pendingCount = 0,
    busy = false;
  const syncSend = () => {
    batchSend.disabled = busy || (!pendingCount && !input.value.trim());
  };
  input.addEventListener('input', syncSend);
  batchSend.addEventListener('click', () => {
    if (batchSend.disabled || !canOpen()) return;
    send.form.requestSubmit(send);
  });
  let captureNumber = 0;
  const view = pane.querySelector('.camera-view');
  const effects = createCameraEffects({ view, controls: pane.querySelector('.camera-controls') });
  const lenses = document.createElement('select');
  lenses.id = 'camera-lenses';
  lenses.setAttribute('aria-label', '選擇相機鏡頭');
  lenses.hidden = true;
  pane.querySelector('.camera-actions').prepend(lenses);
  // Cover fills the pane; capture below uses the identical center crop.
  const zoom = pane.querySelector('input');
  const output = pane.querySelector('output');
  const status = pane.querySelector('#camera-status');
  send.querySelector('svg')?.classList.add('send-arrow-glyph');
  const cameraGlyph = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  cameraGlyph.setAttribute('viewBox', '0 0 24 24');
  cameraGlyph.setAttribute('aria-hidden', 'true');
  cameraGlyph.classList.add('camera-send-glyph');
  cameraGlyph.innerHTML = '<path d="M4 6h4l2-3h4l2 3h4v14H4z"/><circle cx="12" cy="12" r="4"/>';
  send.append(cameraGlyph);
  const setGlyph = (progress) => {
    send.style.setProperty('--camera-gesture', String(progress));
    send.classList.toggle('camera-armed', progress >= 1);
  };
  send.title = '送出；往上拖後放開以開啟相機（鍵盤 ↑）';
  let stream = null,
    epoch = 0,
    facing = 'environment',
    height = 0,
    digital = 1;
  let hardware = false,
    suppressUntil = 0,
    gesture = null;
  const pointers = new Map();
  let pinch = null,
    pinched = false;
  const pinchDistance = () => {
    const [a, b] = [...pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  let motion = null,
    motionVersion = 0;
  const cancelMotion = () => {
    motionVersion++;
    motion?.cancel();
    motion = null;
  };
  const message = (text) => {
    status.textContent = text;
  };
  const stop = () => {
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    video.srcObject = null;
    effects.detach();
    shutter.disabled = true;
  };
  const maxHeight = () => {
    const main = anchor.parentElement;
    return Math.max(
      0,
      main.clientHeight -
        (main.querySelector('.topbar')?.offsetHeight || 0) -
        (main.querySelector('.composer-wrap')?.offsetHeight || 0) -
        80,
    );
  };
  const layout = () => {
    if (pane.hidden) return;
    const total = Math.min(height, maxHeight());
    pane.style.height = `${Math.max(0, total - divider.offsetHeight)}px`;
    divider.setAttribute('aria-valuemax', String(Math.round(maxHeight())));
    divider.setAttribute('aria-valuenow', String(Math.round(total)));
  };
  const resize = (value) => {
    height = Math.max(0, Math.min(maxHeight(), value));
    layout();
  };
  const settleHeight = (target, dismiss = false) => {
    if (dismiss) epoch++; // A late permission result cannot reopen a closing pane.
    const previous = pane.getBoundingClientRect().height;
    cancelMotion();
    const version = motionVersion;
    resize(target);
    const destination = parseFloat(pane.style.height);
    const limit = Math.max(0, maxHeight() - divider.offsetHeight);
    const direction = Math.sign(destination - previous);
    const bounce = Math.min(18, Math.abs(destination - previous) * 0.08);
    const bound = (value) => Math.max(0, Math.min(limit, value));
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    // A bounded overshoot and smaller return creates a soft impact, without
    // delaying pointer tracking or letting the panel escape the viewport.
    motion = pane.animate(
      [
        { height: `${previous}px`, offset: 0 },
        { height: `${bound(destination + direction * bounce)}px`, offset: 0.65 },
        { height: `${bound(destination - direction * bounce * 0.3)}px`, offset: 0.84 },
        { height: `${destination}px`, offset: 1 },
      ],
      {
        duration: reduced ? 0 : 460,
        easing: 'ease-out',
      },
    );
    motion.finished
      .then(() => {
        if (version !== motionVersion) return;
        motion = null;
        if (dismiss) close();
      })
      .catch(() => {});
  };
  const defaultHeight = () => (view.clientWidth * 3) / 2 + divider.offsetHeight;
  const close = () => {
    cancelMotion();
    epoch++;
    gesture = null;
    pointers.clear();
    pinch = null;
    pinched = false;
    setGlyph(0);
    stop();
    pane.hidden = true;
    divider.hidden = true;
    height = 0;
    anchor.parentElement.classList.remove('camera-open');
    send.hidden = false;
    send.setAttribute('aria-label', 'Send');
    send.title = '送出；往上拖後放開以開啟相機（鍵盤 ↑）';
  };
  const updateTransform = () => {
    const transform = `scale(${digital}) scaleX(${facing === 'user' ? -1 : 1})`;
    video.style.transform = transform;
    effects.transform(transform);
  };
  const start = async (deviceId) => {
    const ticket = ++epoch;
    stop();
    digital = 1;
    hardware = false;
    zoom.value = '1';
    zoom.min = '1';
    zoom.max = '4';
    zoom.step = '0.1';
    updateTransform();
    output.textContent = '1.0× 數位';
    message('正在開啟相機…');
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported');
      const acquired = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: facing } }),
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });
      if (ticket !== epoch || pane.hidden) {
        acquired.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = acquired;
      video.srcObject = acquired;
      await video.play();
      if (ticket !== epoch) return;
      shutter.disabled = false;
      void effects.attach(acquired);
      const actualFacing = acquired.getVideoTracks()[0].getSettings().facingMode;
      if (actualFacing === 'user' || actualFacing === 'environment') facing = actualFacing;
      updateTransform();
      void navigator.mediaDevices
        .enumerateDevices()
        .then((devices) => {
          if (ticket !== epoch) return;
          const cameras = devices.filter((d) => d.kind === 'videoinput');
          lenses.replaceChildren(
            ...cameras.map((device, i) => {
              const option = document.createElement('option');
              option.value = device.deviceId;
              option.textContent = `${classifyLens(device.label)} ${i + 1}`;
              return option;
            }),
          );
          lenses.value = acquired.getVideoTracks()[0].getSettings().deviceId || '';
          lenses.hidden = cameras.length < 2;
        })
        .catch(() => {});
      const caps = stream.getVideoTracks()[0].getCapabilities?.() || {};
      if (caps.zoom) {
        hardware = true;
        zoom.min = caps.zoom.min;
        zoom.max = caps.zoom.max;
        zoom.step = caps.zoom.step || 0.1;
        zoom.value = stream.getVideoTracks()[0].getSettings().zoom || caps.zoom.min;
      }
      output.textContent = `${Number(zoom.value).toFixed(1)}× ${hardware ? '鏡頭' : '數位'}`;
      message('');
    } catch {
      if (ticket !== epoch) return;
      stop();
      message('無法開啟相機。請允許相機權限，或用 ＋ 選擇拍照／照片。');
    }
  };
  const reveal = () => {
    if (!pane.hidden) return;
    pane.hidden = false;
    divider.hidden = false;
    anchor.parentElement.classList.add('camera-open');
    setGlyph(0);
    send.setAttribute('aria-label', 'Send');
    send.title = '送出待送照片與文字；上下拖曳調整相機';
    message('放開以啟動相機');
  };
  const open = () => {
    if (!canOpen() || !pane.hidden) return;
    reveal();
    // Default preview is 2:3 portrait (width:height), bounded by available viewport space.
    send.hidden = true;
    syncSend();
    settleHeight(defaultHeight());
    void start();
  };
  send.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' && pane.hidden) {
      e.preventDefault();
      open();
    }
  });
  pane.querySelector('#camera-close').addEventListener('click', () => settleHeight(0, true));
  pane.querySelector('#camera-flip').addEventListener('click', () => {
    facing = facing === 'environment' ? 'user' : 'environment';
    void start();
  });
  lenses.addEventListener('change', () => {
    facing = lenses.selectedOptions[0]?.textContent.includes('前鏡頭') ? 'user' : 'environment';
    void start(lenses.value);
  });
  let pendingZoom = null,
    zoomBusy = false;
  const applyZoom = async (requested) => {
    const value = Math.max(Number(zoom.min), Math.min(Number(zoom.max), requested));
    zoom.value = String(value);
    if (hardware) {
      pendingZoom = { track: stream?.getVideoTracks()[0], value, epoch };
      if (zoomBusy) return;
      zoomBusy = true;
      try {
        while (pendingZoom) {
          const request = pendingZoom;
          pendingZoom = null;
          if (request.epoch !== epoch) continue;
          try {
            await request.track?.applyConstraints({ advanced: [{ zoom: request.value }] });
            if (request.epoch === epoch) output.textContent = `${request.value.toFixed(1)}× 鏡頭`;
          } catch {
            if (request.epoch === epoch) message('此鏡頭無法套用這個倍率。');
          }
        }
      } finally {
        zoomBusy = false;
      }
      return;
    } else {
      digital = value;
      updateTransform();
    }
    output.textContent = `${value.toFixed(1)}× ${hardware ? '鏡頭' : '數位'}`;
  };
  zoom.addEventListener('input', () => {
    void applyZoom(Number(zoom.value));
  });
  divider.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      resize(height + (e.key === 'ArrowUp' ? 32 : -32));
      if (height < 80) settleHeight(0, true);
    }
  });
  const releaseGesture = (cancelled) => {
    if (!gesture) return;
    const saved = gesture;
    gesture = null;
    setGlyph(0);
    if (saved.dragged || cancelled) suppressUntil = performance.now() + 750;
    if (!saved.dragged) {
      if (!cancelled && saved.target === view && performance.now() - saved.started < 350)
        effects.focusAt(saved.x, saved.y);
      return;
    }
    const now = performance.now();
    const recent = saved.samples.filter((point) => now - point.time <= 120);
    const first = recent[0],
      last = recent.at(-1);
    const flickDown =
      saved.target === divider &&
      saved.wasOpen &&
      saved.distance < -18 &&
      recent.length >= 2 &&
      now - last.time < 90 &&
      (last.y - first.y) / Math.max(8, last.time - first.time) > 0.55;
    if (cancelled) {
      if (!saved.wasOpen) close();
      else resize(saved.height);
    } else if (
      height < 80 ||
      flickDown ||
      (saved.wasOpen && saved.target !== divider && saved.distance < -40)
    ) {
      settleHeight(0, true);
    } else if (!saved.wasOpen) {
      settleHeight(defaultHeight());
      void start();
    }
    if (!pane.hidden) {
      send.hidden = true;
      syncSend();
    }
  };
  // One pointer lifecycle for opening, resizing and pulling down to dismiss.
  // Client coordinates stay stable even though the pressed control moves.
  for (const target of [send, divider, view]) {
    target.addEventListener('pointerdown', (e) => {
      if (
        !canOpen() ||
        e.button !== 0 ||
        (target === view && e.target.closest('button, select, input'))
      )
        return;
      if (target === view) {
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        target.setPointerCapture(e.pointerId);
        if (pointers.size >= 2) {
          if (gesture?.wasOpen && gesture.dragged) resize(gesture.height);
          gesture = null;
          pinched = true;
          pinch = { distance: Math.max(1, pinchDistance()), zoom: Number(zoom.value) };
          e.preventDefault();
          return;
        }
      }
      if (!e.isPrimary || pinched) return;
      if (target === send) suppressUntil = 0; // A new tap is intentional, not the drag's trailing click.
      if (motion && !pane.hidden) {
        const current = pane.getBoundingClientRect().height + divider.offsetHeight;
        cancelMotion();
        resize(current);
      }
      gesture = {
        target,
        pointerId: e.pointerId,
        x: e.clientX,
        started: performance.now(),
        samples: [{ y: e.clientY, time: performance.now() }],
        distance: 0,
        y: e.clientY,
        height: pane.hidden ? 0 : pane.offsetHeight + divider.offsetHeight,
        wasOpen: !pane.hidden,
        dragged: false,
      };
      target.setPointerCapture(e.pointerId);
    });
    target.addEventListener('pointermove', (e) => {
      if (target === view && pointers.has(e.pointerId)) {
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinched) {
          if (pinch && pointers.size >= 2)
            void applyZoom((pinch.zoom * pinchDistance()) / pinch.distance);
          e.preventDefault();
          return;
        }
      }
      if (!gesture || gesture.pointerId !== e.pointerId) return;
      const distance = gesture.y - e.clientY;
      gesture.distance = distance;
      const now = performance.now();
      gesture.samples = gesture.samples.filter((point) => now - point.time <= 120);
      gesture.samples.push({ y: e.clientY, time: now });
      if (Math.abs(distance) > 8) gesture.dragged = true;
      if (!gesture.dragged) return;
      e.preventDefault();
      if (pane.hidden && distance > 8) reveal();
      if (!pane.hidden) resize(gesture.height + distance);
      setGlyph(pane.hidden ? 0 : Math.min(1, height / 45));
    });
    const end = (e, cancelled) => {
      if (target === view) {
        pointers.delete(e.pointerId);
        if (pinched) {
          gesture = null;
          if (pointers.size < 2) pinch = null;
          if (!pointers.size) pinched = false;
          return;
        }
      }
      if (gesture?.pointerId === e.pointerId) releaseGesture(cancelled);
    };
    target.addEventListener('pointerup', (e) => end(e, false));
    target.addEventListener('pointercancel', (e) => end(e, true));
    target.addEventListener('lostpointercapture', (e) => end(e, true));
  }
  send.addEventListener(
    'click',
    (e) => {
      if (performance.now() < suppressUntil) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) close();
  });
  window.addEventListener('pagehide', close);
  const layoutObserver = new ResizeObserver(layout);
  layoutObserver.observe(anchor.parentElement);
  layoutObserver.observe(anchor.parentElement.querySelector('.composer-wrap'));
  window.visualViewport?.addEventListener('resize', layout);
  const controller = {
    close,
    setCount(count, total = count) {
      pendingCount = total;
      pane.querySelector('#camera-batch-count').textContent = `待送 ${count} 張`;
      syncSend();
    },
    setBusy(value) {
      busy = value;
      shutter.disabled = busy || !stream || video.readyState < 2;
      syncSend();
    },
    dismiss() {
      if (!pane.hidden) settleHeight(0, true);
    },
    get active() {
      return !pane.hidden;
    },
    capture() {
      if (
        !stream ||
        video.readyState < 2 ||
        !video.videoWidth ||
        !view.clientWidth ||
        !view.clientHeight
      ) {
        message('相機還沒準備好，請稍後再送出。');
        return null;
      }
      const sourceAspect = video.videoWidth / video.videoHeight;
      const targetAspect = view.clientWidth / view.clientHeight;
      const sw =
        (sourceAspect > targetAspect ? video.videoHeight * targetAspect : video.videoWidth) /
        digital;
      const sh =
        (sourceAspect > targetAspect ? video.videoHeight : video.videoWidth / targetAspect) /
        digital;
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 1920 / Math.max(sw, sh));
      canvas.width = Math.round(sw * scale);
      canvas.height = Math.round(sh * scale);
      const context = canvas.getContext('2d');
      if (facing === 'user') {
        context.translate(canvas.width, 0);
        context.scale(-1, 1);
      }
      context.drawImage(
        video,
        (video.videoWidth - sw) / 2,
        (video.videoHeight - sh) / 2,
        sw,
        sh,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      context.setTransform(1, 0, 0, 1, 0, 0);
      effects.composite(canvas);
      const bytes = Uint8Array.from(atob(canvas.toDataURL('image/jpeg', 0.88).split(',')[1]), (c) =>
        c.charCodeAt(0),
      );
      return new File([bytes], `camera-${Date.now()}-${++captureNumber}.jpg`, {
        type: 'image/jpeg',
      });
    },
  };
  shutter.addEventListener('click', () => {
    if (!canOpen() || pane.hidden) return;
    shutter.disabled = true;
    try {
      const file = controller.capture();
      if (file) {
        onCapture?.(file);
        message('');
      }
    } catch {
      message('拍照失敗，請再試一次。');
    } finally {
      controller.setBusy(false);
    }
  });
  return controller;
}
