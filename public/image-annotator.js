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
  let view = { scale: 1, x: 0, y: 0 };
  let fittedWidth = 1;
  let fittedHeight = 1;

  function sync() {
    confirm.disabled = !image || saving;
    undo.disabled = !strokes.length || saving || Boolean(active);
    clear.disabled = !strokes.length || saving;
  }

  function fit() {
    if (!image || !dialog.open) return;
    const ratio = Math.min(
      (stage.clientWidth - 24) / canvas.width,
      (stage.clientHeight - 24) / canvas.height,
    );
    fittedWidth = Math.max(1, canvas.width * ratio);
    fittedHeight = Math.max(1, canvas.height * ratio);
    canvas.style.width = `${fittedWidth}px`;
    canvas.style.height = `${fittedHeight}px`;
    applyView();
    if (navigating && touches.size >= 2) beginGesture();
  }
  new ResizeObserver(fit).observe(stage);

  function applyView() {
    const limitX = Math.max(0, (fittedWidth * view.scale - stage.clientWidth) / 2);
    const limitY = Math.max(0, (fittedHeight * view.scale - stage.clientHeight) / 2);
    view.x = Math.max(-limitX, Math.min(limitX, view.x));
    view.y = Math.max(-limitY, Math.min(limitY, view.y));
    canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
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
    view.x = p.x - (r.left + r.width / 2) - gesture.anchorX * view.scale;
    view.y = p.y - (r.top + r.height / 2) - gesture.anchorY * view.scale;
    applyView();
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

  function point(event) {
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(canvas.width, ((event.clientX - r.left) * canvas.width) / r.width)),
      y: Math.max(0, Math.min(canvas.height, ((event.clientY - r.top) * canvas.height) / r.height)),
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
    const stroke = {
      colour,
      width: (Number(widthSelect.value) * canvas.width) / canvas.getBoundingClientRect().width,
      points: [point(event)],
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
    const p = point(event);
    const previous = active.stroke.points.at(-1);
    active.stroke.points.push(p);
    paintStroke({ ...active.stroke, points: [previous, p] });
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
      if (!touches.size) navigating = false;
    }
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
  }
  stage.addEventListener('pointerup', (event) => finishPointer(event));
  stage.addEventListener('pointercancel', (event) => finishPointer(event, true));
  stage.addEventListener('lostpointercapture', (event) => finishPointer(event, true));

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
    controller?.abort();
    controller = undefined;
    active = null;
    touches.clear();
    navigating = false;
    gesture = null;
    view = { scale: 1, x: 0, y: 0 };
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
