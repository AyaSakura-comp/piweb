/** Draw onto a copy of an image; confirmed PNG Files use the normal composer upload path. */
export function createImageAnnotator({ onConfirm, onError }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'image-annotator';
  dialog.setAttribute('aria-labelledby', 'annotation-title');
  dialog.innerHTML = `
    <header class="annotation-header">
      <button type="button" class="icon-btn" data-action="cancel" aria-label="取消" title="取消標註">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
      <h2 id="annotation-title">圖片標註</h2>
      <button type="button" data-action="confirm" class="icon-btn annotation-confirm" aria-label="確定加入附件" title="確定加入附件" disabled>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>
      </button>
    </header>
    <div class="annotation-stage">
      <p class="annotation-loading" role="status">載入圖片…</p>
      <canvas id="annotation-canvas" aria-label="圖片畫布，單指、滑鼠或觸控筆畫畫，雙指縮放與移動" hidden></canvas>
    </div>
    <footer class="annotation-tools">
      <div class="annotation-colours" role="group" aria-label="畫筆顏色">
        <button type="button" aria-label="紅色" data-colour="#ef4444" style="--pen-colour:#ef4444" aria-pressed="true"></button>
        <button type="button" aria-label="藍色" data-colour="#3b82f6" style="--pen-colour:#3b82f6" aria-pressed="false"></button>
        <button type="button" aria-label="黃色" data-colour="#facc15" style="--pen-colour:#facc15" aria-pressed="false"></button>
        <button type="button" aria-label="黑色" data-colour="#111111" style="--pen-colour:#111111" aria-pressed="false"></button>
        <button type="button" aria-label="白色" data-colour="#ffffff" style="--pen-colour:#ffffff" aria-pressed="false"></button>
      </div>
      <div class="annotation-edit-tools">
        <label>粗細 <select aria-label="筆畫粗細"><option value="3">細</option><option value="5" selected>中</option><option value="8">粗</option></select></label>
        <button type="button" class="icon-btn" data-action="undo" aria-label="復原" title="復原上一筆" disabled>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 5-5 5 5 5"/><path d="M4 10h10a6 6 0 0 1 0 12"/></svg>
        </button>
        <button type="button" class="icon-btn" data-action="clear" aria-label="清除" title="清除所有筆畫" disabled>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg>
        </button>
      </div>
      <p class="annotation-note">單指畫畫，雙指縮放／移動。按 ✓ 加入附件，不會自動送出。</p>
    </footer>`;
  document.body.append(dialog);
  const canvas = dialog.querySelector('canvas');
  const stage = dialog.querySelector('.annotation-stage');
  const loading = dialog.querySelector('.annotation-loading');
  const confirm = dialog.querySelector('[data-action="confirm"]');
  const undo = dialog.querySelector('[data-action="undo"]');
  const clear = dialog.querySelector('[data-action="clear"]');
  const widthSelect = dialog.querySelector('select');
  const ctx = canvas.getContext('2d');
  let generation = 0;
  let controller;
  let image;
  let context;
  let filename;
  let strokes = [];
  let active = null;
  let colour = '#ef4444';
  let saving = false;
  const touches = new Map();
  let navigating = false;
  let gesture = null;
  let view = { scale: 1, x: 0, y: 0, committed: 1 };
  let commitTimer = null;
  let fittedWidth = 1;
  let fittedHeight = 1;

  function sync() {
    confirm.disabled = !image || saving;
    undo.disabled = !strokes.length || saving || Boolean(active);
    clear.disabled = !strokes.length || saving;
  }

  function nativeScale() {
    return (canvas.width || fittedWidth) / (fittedWidth * Math.max(1, window.devicePixelRatio || 1));
  }

  function setCommitted(target) {
    if (!image || !dialog.open) return;
    view.committed = target;
    canvas.classList.toggle('zoomed', target > 1.01);
    canvas.style.width = `${fittedWidth * target}px`;
    canvas.style.height = `${fittedHeight * target}px`;
    canvas.style.transition = 'none';
    canvas.style.transform = `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale / view.committed})`;
    void canvas.offsetWidth;
  }

  function scheduleCommit(delay = 140) {
    clearTimeout(commitTimer);
    commitTimer = setTimeout(() => {
      if (navigating || !image || !dialog.open) return;
      const target = view.scale > 1.01 ? Math.min(view.scale, Math.max(1, nativeScale(), view.scale)) : 1;
      if (Math.abs(target - view.committed) > 0.01) setCommitted(target);
    }, delay);
  }

  function fit() {
    if (!image || !dialog.open) return;
    const ratio = Math.min(
      (stage.clientWidth - 24) / canvas.width,
      (stage.clientHeight - 24) / canvas.height,
    );
    fittedWidth = Math.max(1, canvas.width * ratio);
    fittedHeight = Math.max(1, canvas.height * ratio);
    canvas.style.width = `${fittedWidth * view.committed}px`;
    canvas.style.height = `${fittedHeight * view.committed}px`;
    applyView(false);
    if (navigating && touches.size >= 2) beginGesture();
  }
  new ResizeObserver(fit).observe(stage);

  function panLimits(scale = view.scale) {
    return {
      x: Math.max(0, (fittedWidth * scale - stage.clientWidth) / 2),
      y: Math.max(0, (fittedHeight * scale - stage.clientHeight) / 2),
    };
  }

  function rubberBand(value, limit) {
    if (value > limit) return limit + (value - limit) / 3;
    if (value < -limit) return -limit + (value + limit) / 3;
    return value;
  }

  function clampView() {
    const limit = panLimits();
    view.x = Math.max(-limit.x, Math.min(limit.x, view.x));
    view.y = Math.max(-limit.y, Math.min(limit.y, view.y));
  }

  function applyView(animate = false, clamp = true) {
    if (clamp) clampView();
    canvas.style.transition = animate ? 'transform 0.2s cubic-bezier(0.16, 1, 0.3, 1)' : 'none';
    canvas.style.transform = `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale / view.committed})`;
  }

  function gesturePoints() {
    const [a, b] = [...touches.values()];
    return {
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
    };
  }

  function beginGesture() {
    clearTimeout(commitTimer);
    const p = gesturePoints();
    const r = stage.getBoundingClientRect();
    gesture = {
      distance: p.distance,
      scale: view.scale,
      anchorX: (p.x - (r.left + r.width / 2) - view.x) / view.scale,
      anchorY: (p.y - (r.top + r.height / 2) - view.y) / view.scale,
    };
  }

  function moveGesture() {
    if (!gesture || touches.size < 2) return;
    const p = gesturePoints();
    const r = stage.getBoundingClientRect();
    view.scale = Math.max(1, Math.min(8, (gesture.scale * p.distance) / gesture.distance));
    const rawX = p.x - (r.left + r.width / 2) - gesture.anchorX * view.scale;
    const rawY = p.y - (r.top + r.height / 2) - gesture.anchorY * view.scale;
    const limit = panLimits(view.scale);
    view.x = rubberBand(rawX, limit.x);
    view.y = rubberBand(rawY, limit.y);
    applyView(false, false);
  }

  function paintStroke(stroke) {
    ctx.strokeStyle = stroke.colour;
    ctx.fillStyle = stroke.colour;
    ctx.lineWidth = stroke.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const first = stroke.points[0];
    if (stroke.points.length === 1) {
      ctx.arc(first.x, first.y, stroke.width / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.moveTo(first.x, first.y);
      for (const p of stroke.points.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
  }

  function redraw() {
    if (!image) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const stroke of strokes) paintStroke(stroke);
    sync();
  }

  function point(event, rect = canvas.getBoundingClientRect()) {
    return {
      x: Math.max(0, Math.min(canvas.width, ((event.clientX - rect.left) * canvas.width) / rect.width)),
      y: Math.max(0, Math.min(canvas.height, ((event.clientY - rect.top) * canvas.height) / rect.height)),
    };
  }
  stage.addEventListener('pointerdown', (event) => {
    if (!image || saving) return;
    if (event.pointerType === 'touch') {
      event.preventDefault();
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      stage.setPointerCapture(event.pointerId);
      if (touches.size >= 2) {
        // The initial finger belongs to the pinch, not to an accidental mark.
        if (active) {
          strokes = strokes.filter((stroke) => stroke !== active.stroke);
          active = null;
          redraw();
        }
        navigating = true;
        beginGesture();
        return;
      }
    }
    if (navigating || active || event.target !== canvas || !event.isPrimary || event.button !== 0)
      return;
    event.preventDefault();
    stage.setPointerCapture(event.pointerId);
    const rect = canvas.getBoundingClientRect();
    const stroke = {
      colour,
      width: (Number(widthSelect.value) * canvas.width) / rect.width,
      points: [point(event, rect)],
    };
    strokes.push(stroke);
    active = { pointerId: event.pointerId, stroke };
    paintStroke(stroke);
    sync();
  });
  stage.addEventListener('pointermove', (event) => {
    if (touches.has(event.pointerId)) {
      event.preventDefault();
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (navigating) {
        moveGesture();
        return;
      }
    }
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const samples = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
    const events = samples.length ? samples : [event];
    const segment = [active.stroke.points.at(-1)];
    for (const sample of events) {
      const p = point(sample, rect);
      active.stroke.points.push(p);
      segment.push(p);
    }
    paintStroke({ ...active.stroke, points: segment });
  });
  function finishPointer(event, cancelled = false) {
    touches.delete(event.pointerId);
    if (active?.pointerId === event.pointerId) {
      if (cancelled) strokes = strokes.filter((stroke) => stroke !== active.stroke);
      active = null;
      redraw();
    }
    if (navigating) {
      gesture = null;
      if (touches.size >= 2) beginGesture();
      // Never turn the remaining pinch finger into a drawing pointer.
      if (!touches.size) {
        navigating = false;
        if (view.scale <= 1.02) {
          view.scale = 1;
          view.x = 0;
          view.y = 0;
          setCommitted(1);
        } else {
          applyView(true, true);
          scheduleCommit(160);
        }
      }
    }
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
  }
  stage.addEventListener('pointerup', (event) => finishPointer(event));
  stage.addEventListener('pointercancel', (event) => finishPointer(event, true));
  stage.addEventListener('lostpointercapture', (event) => finishPointer(event, true));
  stage.addEventListener(
    'wheel',
    (event) => {
      if (!image || saving || !dialog.open) return;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const r = stage.getBoundingClientRect();
        const dx = event.clientX - (r.left + r.width / 2);
        const dy = event.clientY - (r.top + r.height / 2);
        const nextScale = Math.max(1, Math.min(8, view.scale * Math.exp(-event.deltaY * 0.01)));
        const k = nextScale / view.scale;
        view.x = dx - (dx - view.x) * k;
        view.y = dy - (dy - view.y) * k;
        view.scale = nextScale;
        if (view.scale <= 1.01) {
          view.scale = 1;
          view.x = 0;
          view.y = 0;
          setCommitted(1);
        } else {
          applyView(false, true);
          scheduleCommit(140);
        }
      } else if (view.scale > 1.01) {
        event.preventDefault();
        view.x -= event.deltaX;
        view.y -= event.deltaY;
        applyView(false, true);
      }
    },
    { passive: false },
  );

  for (const button of dialog.querySelectorAll('[data-colour]')) {
    button.addEventListener('click', () => {
      colour = button.dataset.colour;
      for (const item of dialog.querySelectorAll('[data-colour]'))
        item.setAttribute('aria-pressed', String(item === button));
    });
  }
  undo.addEventListener('click', () => {
    if (!saving && !active) {
      strokes.pop();
      redraw();
    }
  });
  clear.addEventListener('click', () => {
    if (!saving) {
      strokes = [];
      active = null;
      redraw();
    }
  });

  function close() {
    generation++;
    clearTimeout(commitTimer);
    controller?.abort();
    controller = undefined;
    active = null;
    touches.clear();
    navigating = false;
    gesture = null;
    view = { scale: 1, x: 0, y: 0, committed: 1 };
    canvas.classList.remove('zoomed');
    canvas.style.transition = '';
    canvas.style.transform = '';
    image = null;
    context = null;
    strokes = [];
    saving = false;
    canvas.width = canvas.height = 1; // release large bitmap storage
    if (dialog.open) dialog.close();
  }
  dialog.querySelector('[data-action="cancel"]').addEventListener('click', close);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener('keydown', (event) => {
    // Escape belongs to this editor, not the image viewer underneath it.
    event.stopPropagation();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (!undo.disabled) undo.click();
    }
  });

  confirm.addEventListener('click', async () => {
    if (!image || saving) return;
    active = null;
    redraw();
    saving = true;
    sync();
    const token = generation;
    const destination = context;
    try {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (token !== generation || !dialog.open) return;
      if (!blob) throw new Error('圖片匯出失敗，請再試一次。');
      const file = new File([blob], filename, { type: 'image/png' });
      if (onConfirm(file, destination) === false)
        throw new Error('對話狀態已變更，請重新開啟圖片標註。');
      close();
    } catch (error) {
      if (token !== generation) return;
      saving = false;
      sync();
      onError(error.message || '無法匯出標註圖片。');
    }
  });

  async function open(url, destination) {
    close();
    const token = generation;
    context = destination;
    filename = 'annotated-image.png';
    try {
      const base = decodeURIComponent(
        new URL(url, location.href).pathname.split('/').pop() || 'image',
      )
        .replace(/\.[^.]+$/, '')
        .replace(/[^\p{L}\p{N}_-]/gu, '-')
        .slice(0, 80);
      filename = `annotated-${base || 'image'}.png`;
    } catch {
      /* retain a safe default name */
    }
    canvas.hidden = true;
    loading.hidden = false;
    sync();
    dialog.showModal();
    controller = new AbortController();
    let objectUrl;
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error('無法載入圖片。');
      const blob = await response.blob();
      if (token !== generation) return;
      objectUrl = URL.createObjectURL(blob);
      const decoded = new Image();
      decoded.src = objectUrl;
      await decoded.decode();
      if (token !== generation || !dialog.open) return;
      // Bound memory for phone cameras; normal images keep their original size.
      const scale = Math.min(1, 4096 / Math.max(decoded.naturalWidth, decoded.naturalHeight));
      canvas.width = Math.max(1, Math.round(decoded.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(decoded.naturalHeight * scale));
      image = decoded;
      canvas.hidden = false;
      loading.hidden = true;
      redraw();
      fit();
    } catch (error) {
      if (token !== generation) return;
      close();
      onError(error.message || '無法載入圖片；外部圖片可能不允許跨來源存取。');
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  }
  return {
    open,
    close,
    get active() {
      return dialog.open;
    },
  };
}
