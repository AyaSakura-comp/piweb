const DEFAULT_PREVIEW_LENGTH = 72;
const MAX_SELECTION_LENGTH = 12_000;
const LONG_PRESS_MS = 300;
const MOVE_TOLERANCE_PX = 10;

function defaultComparePoints(document, a, b) {
  if (a.node === b.node) {
    return a.offset - b.offset;
  }
  const left = document.createRange();
  left.setStart(a.node, Math.min(a.offset, a.node.textContent?.length ?? a.offset));
  left.collapse(true);
  const right = document.createRange();
  right.setStart(b.node, Math.min(b.offset, b.node.textContent?.length ?? b.offset));
  right.collapse(true);
  return left.compareBoundaryPoints(0, right);
}

/** Create a forward DOM Range regardless of which direction the points were provided. */
export function createRangeBetween(document, a, b, compare = defaultComparePoints) {
  const [start, end] = compare(document, a, b) <= 0 ? [a, b] : [b, a];
  const range = document.createRange();
  const startMax = start.node.nodeType === 3 ? (start.node.textContent?.length ?? 0) : 0;
  const endMax = end.node.nodeType === 3 ? (end.node.textContent?.length ?? 0) : 0;
  range.setStart(start.node, Math.max(0, Math.min(start.offset, startMax)));
  range.setEnd(end.node, Math.max(0, Math.min(end.offset, endMax)));
  return range;
}

function elementForNode(node) {
  return node?.nodeType === 3 ? node.parentNode : node;
}

/** Return selected transcript text, rejecting collapsed or out-of-transcript selections. */
export function selectedTranscriptText(selection, transcriptRoot) {
  if (!selection) return '';
  if (typeof selection === 'string') return selection.trim().slice(0, MAX_SELECTION_LENGTH);
  if (selection.rangeCount === 0 || selection.isCollapsed) return '';
  const range = selection.getRangeAt(0);
  if (!transcriptRoot.contains(elementForNode(range.commonAncestorContainer))) return '';
  return selection.toString().trim().slice(0, MAX_SELECTION_LENGTH);
}

/** Compact display text for the composer chip; the full selection is retained separately. */
export function quotePreview(text, maxLength = DEFAULT_PREVIEW_LENGTH) {
  const oneLine = String(text).replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLength) return oneLine;
  return `${oneLine.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function findOffsetInTextNode(document, textNode, x, y) {
  const len = textNode.textContent?.length ?? 0;
  if (len <= 0) return 0;
  if (!document.createRange) return 0;

  const range = document.createRange();
  let bestOffset = 0;
  let bestDist = Infinity;

  for (let i = 0; i <= len; i++) {
    try {
      range.setStart(textNode, i);
      range.collapse(true);
      const rects = range.getClientRects();
      if (rects && rects.length > 0) {
        const rect = rects[0];
        const dy = Math.max(0, Math.abs(y - (rect.top + rect.height / 2)) - rect.height / 2);
        const dx = Math.abs(x - rect.left);
        const dist = dy * 1000 + dx;
        if (dist < bestDist) {
          bestDist = dist;
          bestOffset = i;
        }
      }
    } catch {
      break;
    }
  }
  return bestOffset;
}

export function findTextPoint(document, x, y, rootContainer) {
  // Temporarily ignore backdrop/overlay elements so caret queries penetrate to the text
  const backdrop = document?.getElementById ? document.getElementById('sel-backdrop') : null;
  const prevBackdropPointer = backdrop ? backdrop.style.pointerEvents : null;
  if (backdrop && prevBackdropPointer !== 'none') {
    backdrop.style.pointerEvents = 'none';
  }

  let raw = null;
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (pos?.offsetNode) raw = { node: pos.offsetNode, offset: pos.offset };
  } else if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(x, y);
    if (range?.startContainer) raw = { node: range.startContainer, offset: range.startOffset };
  }

  // 1. Direct text node match (fast path, <0.01ms)
  if (raw && raw.node && raw.node.nodeType === 3) {
    if (backdrop && prevBackdropPointer !== 'none') {
      backdrop.style.pointerEvents = prevBackdropPointer;
    }
    if (!rootContainer || rootContainer.contains(raw.node.parentNode)) {
      const len = raw.node.textContent?.length ?? 0;
      return { node: raw.node, offset: Math.max(0, Math.min(len, raw.offset)) };
    }
  }

  // 2. Element node match: scope search strictly to the hovered message/element
  const elUnderPoint = document.elementFromPoint ? document.elementFromPoint(x, y) : null;
  if (backdrop && prevBackdropPointer !== 'none') {
    backdrop.style.pointerEvents = prevBackdropPointer;
  }

  const msgEl = elUnderPoint?.closest?.('.msg-text, .event-body') ||
                (raw?.node?.nodeType === 1 ? raw.node.closest?.('.msg-text, .event-body') : null) ||
                (raw?.node?.nodeType === 1 ? raw.node : null);

  if (!msgEl || (rootContainer && !rootContainer.contains(msgEl))) return null;

  const walker = document.createTreeWalker?.(msgEl, 4 /* NodeFilter.SHOW_TEXT */);
  if (!walker) return null;

  let bestTextNode = null;
  let bestDist = Infinity;
  let node;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent) continue;
    const rect = parent.getBoundingClientRect();
    const cx = Math.max(rect.left, Math.min(x, rect.right));
    const cy = Math.max(rect.top, Math.min(y, rect.bottom));
    const dist = Math.hypot(x - cx, y - cy);
    if (dist < bestDist) {
      bestDist = dist;
      bestTextNode = node;
    }
  }

  if (bestTextNode) {
    const len = bestTextNode.textContent?.length ?? 0;
    if (len <= 1) return { node: bestTextNode, offset: len };

    const parentRect = bestTextNode.parentElement?.getBoundingClientRect();
    let offset = 0;
    if (parentRect && parentRect.width > 0) {
      const ratio = Math.max(0, Math.min(1, (x - parentRect.left) / parentRect.width));
      offset = Math.round(ratio * len);
    }
    return { node: bestTextNode, offset: Math.max(0, Math.min(len, offset)) };
  }

  return null;
}

function isWordChar(ch) {
  if (!ch) return false;
  return !/[\s\r\n\t,.;:!?()[\]{}"'`~]/.test(ch);
}

function expandToWord(point) {
  if (!point || !point.node || point.node.nodeType !== 3) {
    return { start: point, end: point };
  }
  const text = point.node.textContent || '';
  const len = text.length;
  if (len === 0) return { start: point, end: point };

  let start = Math.max(0, Math.min(len - 1, point.offset));
  let end = start;

  if (isWordChar(text[start])) {
    while (start > 0 && isWordChar(text[start - 1])) start--;
    while (end < len && isWordChar(text[end])) end++;
  } else {
    end = Math.min(len, start + 1);
  }

  return {
    start: { node: point.node, offset: start },
    end: { node: point.node, offset: Math.max(start + 1, end) },
  };
}

/**
 * Custom Touch Selection Controller with Draggable Handles and Prominent Highlight.
 * Locks initial anchor during swipe, moves trailing pivot across multiple lines,
 * and maintains locked opposite anchor during handle dragging.
 */
export function bindCustomSelection(root, overlayEl, { onSelection, onClear = () => {} }) {
  const document = root.ownerDocument;
  const window = document.defaultView;
  const highlights = window?.CSS?.highlights;
  const Highlight = window?.Highlight;

  const startHandle = overlayEl?.querySelector('#sel-handle-start');
  const endHandle = overlayEl?.querySelector('#sel-handle-end');
  const boxesContainer = overlayEl?.querySelector('#sel-highlight-boxes');
  const backdrop = overlayEl?.querySelector('#sel-backdrop');

  let currentRange = null;
  let startPoint = null;
  let endPoint = null;
  let pendingGesture = null;
  let isDragging = false;

  function clearSelection() {
    if (highlights) highlights.delete('piweb-selection');
    currentRange = null;
    startPoint = null;
    endPoint = null;
    isDragging = false;
    if (boxesContainer) boxesContainer.innerHTML = '';
    if (overlayEl) {
      overlayEl.hidden = true;
      overlayEl.classList.remove('active');
    }
    onClear();
  }

  function renderHighlightBoxes(rects) {
    if (!boxesContainer) return;
    boxesContainer.innerHTML = '';
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      if (r.width <= 0 || r.height <= 0) continue;
      const box = document.createElement('div');
      box.className = 'sel-highlight-rect';
      box.style.left = `${r.left}px`;
      box.style.top = `${r.top}px`;
      box.style.width = `${r.width}px`;
      box.style.height = `${r.height}px`;
      boxesContainer.appendChild(box);
    }
  }

  function updateHandlesAndHighlight() {
    if (!currentRange || currentRange.collapsed) {
      clearSelection();
      return;
    }

    if (highlights && Highlight) {
      highlights.set('piweb-selection', new Highlight(currentRange));
    }

    const rects = currentRange.getClientRects();
    if (rects.length === 0 || !overlayEl || !startHandle || !endHandle) return;

    renderHighlightBoxes(rects);

    const firstRect = rects[0];
    const lastRect = rects[rects.length - 1];

    startHandle.style.left = `${firstRect.left}px`;
    startHandle.style.top = `${firstRect.top}px`;

    endHandle.style.left = `${lastRect.right}px`;
    endHandle.style.top = `${lastRect.bottom}px`;

    overlayEl.hidden = false;
    overlayEl.classList.add('active');

    const text = currentRange.toString().trim().slice(0, MAX_SELECTION_LENGTH);
    if (text) {
      onSelection(text, currentRange.getBoundingClientRect());
    } else {
      clearSelection();
    }
  }

  function setRangePoints(p1, p2) {
    if (!p1 || !p2) return;
    const isForward = defaultComparePoints(document, p1, p2) <= 0;
    const [s, e] = isForward ? [p1, p2] : [p2, p1];
    startPoint = s;
    endPoint = e;
    currentRange = createRangeBetween(document, s, e);
    updateHandlesAndHighlight();
  }

  // ── Dismiss on backdrop tap ──────────────────────────────────────────────
  backdrop?.addEventListener('touchstart', (e) => {
    e.stopPropagation();
    if (e.cancelable) e.preventDefault();
    clearSelection();
  }, { passive: false });

  backdrop?.addEventListener('click', (e) => {
    e.stopPropagation();
    clearSelection();
  });

  // ── Touch on text messages (long press to trigger) ────────────────────────
  function onTouchStart(event) {
    if (event.touches.length !== 1) return;
    const target = event.target;

    if (target.closest('.sel-handle, #selection-actions, .selection-actions')) return;

    if (currentRange) {
      clearSelection();
    }

    if (!target.closest('.msg-text, .event-body')) return;

    const touch = event.touches[0];
    const point = findTextPoint(document, touch.clientX, touch.clientY, root);
    if (!point) return;

    const pending = {
      id: touch.identifier,
      startX: touch.clientX,
      startY: touch.clientY,
      point,
      anchor: null,
      timer: null,
      active: false,
    };

    pending.timer = window.setTimeout(() => {
      if (pendingGesture !== pending) return;
      pending.active = true;
      isDragging = false;
      const word = expandToWord(point);
      window.navigator?.vibrate?.(12);
      pending.anchor = word.start;
      setRangePoints(word.start, word.end);
    }, LONG_PRESS_MS);

    pendingGesture = pending;
  }

  function onTouchMove(event) {
    if (!pendingGesture) return;
    const touch = [...event.touches].find((t) => t.identifier === pendingGesture.id);
    if (!touch) return;

    if (!pendingGesture.active) {
      if (Math.hypot(touch.clientX - pendingGesture.startX, touch.clientY - pendingGesture.startY) > MOVE_TOLERANCE_PX) {
        if (pendingGesture.timer) window.clearTimeout(pendingGesture.timer);
        pendingGesture = null;
      }
      return;
    }

    if (event.cancelable) event.preventDefault();
    if (!isDragging) {
      isDragging = true;
      overlayEl?.classList.add('dragging');
      onClear(); // Hide floating action bar while actively dragging
    }
    const current = findTextPoint(document, touch.clientX, touch.clientY, root);
    if (current && pendingGesture.anchor) {
      setRangePoints(pendingGesture.anchor, current);
    }
  }

  function onTouchEnd(event) {
    if (!pendingGesture) return;
    if (pendingGesture.timer) window.clearTimeout(pendingGesture.timer);
    if (pendingGesture.active) {
      isDragging = false;
      overlayEl?.classList.remove('dragging');
      if (currentRange && !currentRange.collapsed) {
        const text = currentRange.toString().trim().slice(0, MAX_SELECTION_LENGTH);
        if (text) onSelection(text, currentRange.getBoundingClientRect());
      }
    }
    pendingGesture = null;
  }

  // ── Dragging Handles ─────────────────────────────────────────────────────
  function bindHandle(handleEl, isStart) {
    if (!handleEl) return;

    let touchId = null;
    let dragAnchor = null;

    handleEl.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      e.stopPropagation();
      if (e.cancelable) e.preventDefault();
      touchId = e.touches[0].identifier;
      dragAnchor = isStart ? endPoint : startPoint;
      isDragging = true;
      overlayEl?.classList.add('dragging');
      handleEl.classList.add('dragging');
      window.navigator?.vibrate?.(8);
    }, { passive: false });

    const targetWindow = window || document.defaultView || document;
    targetWindow?.addEventListener?.('touchmove', (e) => {
      if (touchId === null || !dragAnchor) return;
      const touch = [...e.touches].find((t) => t.identifier === touchId);
      if (!touch) return;
      if (e.cancelable) e.preventDefault();

      const yOffset = isStart ? -14 : 14;
      const newPoint = findTextPoint(document, touch.clientX, touch.clientY + yOffset, root);
      if (newPoint) {
        setRangePoints(dragAnchor, newPoint);
      }
    }, { passive: false });

    function endDrag() {
      if (touchId === null) return;
      touchId = null;
      dragAnchor = null;
      isDragging = false;
      overlayEl?.classList.remove('dragging');
      handleEl.classList.remove('dragging');
      if (currentRange && !currentRange.collapsed) {
        const text = currentRange.toString().trim().slice(0, MAX_SELECTION_LENGTH);
        if (text) onSelection(text, currentRange.getBoundingClientRect());
      }
    }

    targetWindow?.addEventListener?.('touchend', endDrag, { passive: true });
    targetWindow?.addEventListener?.('touchcancel', endDrag, { passive: true });
  }

  bindHandle(startHandle, true);
  bindHandle(endHandle, false);

  root.addEventListener('touchstart', onTouchStart, { passive: true });
  const globalTarget = window || document.defaultView || document;
  globalTarget?.addEventListener?.('touchmove', onTouchMove, { passive: false });
  globalTarget?.addEventListener?.('touchend', onTouchEnd, { passive: true });
  globalTarget?.addEventListener?.('touchcancel', onTouchEnd, { passive: true });

  root.addEventListener('scroll', () => {
    if (currentRange) updateHandlesAndHighlight();
  }, { passive: true });

  return clearSelection;
}



