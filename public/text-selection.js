import { createSelectionBubble } from './selection-bubble.js';

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

/**
 * Hide the selection overlay (backdrop *and* handles) from hit testing while a
 * caret query runs. Dragging back over a handle otherwise resolves to the
 * handle element instead of the text underneath, freezing the selection.
 */
function withOverlayTransparent(document, fn) {
  const ids = ['custom-selection-overlay', 'sel-backdrop'];
  const restore = [];
  if (document?.getElementById) {
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el && el.style.pointerEvents !== 'none') {
        restore.push([el, el.style.pointerEvents]);
        el.style.pointerEvents = 'none';
      }
    }
  }
  try {
    return fn();
  } finally {
    for (const [el, prev] of restore) el.style.pointerEvents = prev;
  }
}

// Markdown renderers leave "\n" text nodes between blocks (`<ul>\n<li>`). They
// draw nothing, yet WebKit's caret lookup returns one for some points beside a
// list item, and its DOM position is before the whole list: a dragged end then
// lands above its anchor and the selection flips up the screen. Only text that
// is actually drawn may be a selection point (whitespace inside code is drawn).
function isLayoutWhitespace(node) {
  return !/\S/.test(node.textContent || '') && !node.parentElement?.closest?.('pre');
}

/** The drawn character boundary in `msgEl` nearest to (x, y), line first. */
function nearestTextPoint(document, msgEl, x, y) {
  const walker = document.createTreeWalker?.(msgEl, 4 /* NodeFilter.SHOW_TEXT */);
  const range = document.createRange?.();
  if (!walker || !range) return null;
  const distance = (rect) => {
    const dx = Math.max(rect.left - x, 0, x - rect.right);
    const dy = Math.max(rect.top - y, 0, y - rect.bottom);
    // Another line is a worse match than any distance along this one.
    return dy * 1000 + dx;
  };

  let best = null;
  let node;
  while ((node = walker.nextNode())) {
    if (isLayoutWhitespace(node)) continue;
    range.selectNodeContents(node);
    for (const rect of range.getClientRects?.() ?? []) {
      if (!rect.width && !rect.height) continue;
      const score = distance(rect);
      if (!best || score < best.score) best = { node, line: rect, score };
    }
  }
  if (!best) return null;

  // Walk the characters on that line; the boundary nearest x wins.
  const len = best.node.textContent?.length ?? 0;
  let point = { node: best.node, offset: 0 };
  let bestDx = Infinity;
  for (let i = 0; i < len && i < 4000; i++) {
    range.setStart(best.node, i);
    range.setEnd(best.node, i + 1);
    const rect = range.getBoundingClientRect();
    if (!rect.width || rect.bottom <= best.line.top || rect.top >= best.line.bottom) continue;
    for (const [edge, offset] of [[rect.left, i], [rect.right, i + 1]]) {
      const dx = Math.abs(x - edge);
      if (dx < bestDx) {
        bestDx = dx;
        point = { node: best.node, offset };
      }
    }
  }
  return point;
}

export function findTextPoint(document, x, y, rootContainer) {
  const probe = withOverlayTransparent(document, () => {
    let raw = null;
    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      if (pos?.offsetNode) raw = { node: pos.offsetNode, offset: pos.offset };
    } else if (document.caretRangeFromPoint) {
      const range = document.caretRangeFromPoint(x, y);
      if (range?.startContainer) raw = { node: range.startContainer, offset: range.startOffset };
    }
    const el = document.elementFromPoint ? document.elementFromPoint(x, y) : null;
    return { raw, el };
  });

  const raw = probe.raw;

  // 1. Direct text node match (fast path, <0.01ms)
  if (raw && raw.node && raw.node.nodeType === 3 && !isLayoutWhitespace(raw.node)) {
    if (!rootContainer || rootContainer.contains(raw.node.parentNode)) {
      const len = raw.node.textContent?.length ?? 0;
      return { node: raw.node, offset: Math.max(0, Math.min(len, raw.offset)) };
    }
  }

  // 2. Otherwise search the drawn text of the message under the point
  const elUnderPoint = probe.el;
  const rawEl = raw?.node?.nodeType === 3 ? raw.node.parentElement : raw?.node;

  const msgEl = elUnderPoint?.closest?.('.msg-text, .event-body') ||
                (rawEl?.nodeType === 1 ? rawEl.closest?.('.msg-text, .event-body') : null) ||
                (raw?.node?.nodeType === 1 ? raw.node : null);

  if (!msgEl || (rootContainer && !rootContainer.contains(msgEl))) return null;

  return nearestTextPoint(document, msgEl, x, y);
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
// The instance holding the selection: the overlay, handles and highlight are
// shared, so a selection starting in another root ends this one first.
let selectionOwner = null;

/**
 * Long-press selection inside `root`. With `scope` (a selector), `root` holds
 * several transcripts (the Dashboard's panes): the one long-pressed becomes
 * the scroller, and the selection stays inside it. onSelection gets
 * (text, rect, scroller).
 */
export function bindCustomSelection(root, overlayEl, { onSelection, onClear = () => {}, scope = null }) {
  const document = root.ownerDocument;
  const window = document.defaultView;
  const highlights = window?.CSS?.highlights;
  const Highlight = window?.Highlight;

  const startHandle = overlayEl?.querySelector('#sel-handle-start');
  const endHandle = overlayEl?.querySelector('#sel-handle-end');
  // The bubble layer sits beside the overlay, not in it, so it can still
  // shrink away after the overlay is hidden.
  const boxesContainer =
    overlayEl?.querySelector('#sel-highlight-boxes') ?? document.getElementById?.('sel-highlight-boxes');
  const backdrop = overlayEl?.querySelector('#sel-backdrop');
  let scroller = root;
  const bubble = createSelectionBubble(boxesContainer, {
    window,
    scroller: { get scrollTop() { return scroller.scrollTop; } },
  });
  const self = { clear: () => clearSelection() };

  let currentRange = null;
  let startPoint = null;
  let endPoint = null;
  let pendingGesture = null;
  let isDragging = false;

  function clearNativeSelection() {
    window?.getSelection?.()?.removeAllRanges();
  }

  function clearSelection() {
    if (highlights) highlights.delete('piweb-selection');
    clearNativeSelection();
    currentRange = null;
    startPoint = null;
    endPoint = null;
    isDragging = false;
    bubble.clear();
    if (selectionOwner === self) selectionOwner = null;
    if (overlayEl) {
      overlayEl.hidden = true;
      overlayEl.classList.remove('active');
    }
    onClear();
  }

  /**
   * Rects of the selected text alone. A range's own client rects also carry
   * boxes for the gaps between blocks (Chrome reports one per paragraph
   * break), which drew stray tabs between paragraphs.
   */
  function textRects(range) {
    const common = range.commonAncestorContainer;
    if (!common || !document.createTreeWalker) return Array.from(range.getClientRects());
    if (common.nodeType === 3) return Array.from(range.getClientRects());
    const walker = document.createTreeWalker(common, 4 /* NodeFilter.SHOW_TEXT */);
    const part = document.createRange();
    const rects = [];
    let node;
    while ((node = walker.nextNode())) {
      if (!range.intersectsNode(node)) continue;
      part.selectNodeContents(node);
      if (node === range.startContainer) part.setStart(node, range.startOffset);
      if (node === range.endContainer) part.setEnd(node, range.endOffset);
      rects.push(...part.getClientRects());
    }
    return rects;
  }

  function getFilteredLineRects(range) {
    const raw = textRects(range).filter((r) => r.width > 0 && r.height > 0);
    if (raw.length <= 1) return raw;

    // Discard any container bounding box that completely wraps multiple smaller line boxes
    const filtered = [];
    for (let i = 0; i < raw.length; i++) {
      const a = raw[i];
      let isContainer = false;
      for (let j = 0; j < raw.length; j++) {
        if (i === j) continue;
        const b = raw[j];
        if (a.top <= b.top - 1 && a.bottom >= b.bottom + 1 && a.height > b.height * 1.3) {
          isContainer = true;
          break;
        }
      }
      if (!isContainer) filtered.push(a);
    }
    return filtered.length > 0 ? filtered : raw;
  }

  function getHandlePointRect(doc, point, isStart) {
    if (!point || !point.node) return null;
    const node = point.node;
    const offset = point.offset;
    const docObj = doc || node.ownerDocument || document;
    if (!docObj.createRange) return null;

    try {
      const r = docObj.createRange();
      if (node.nodeType === 3) {
        const len = node.nodeValue?.length || 0;
        if (isStart) {
          if (offset < len) {
            r.setStart(node, offset);
            r.setEnd(node, offset + 1);
          } else if (offset > 0) {
            r.setStart(node, offset - 1);
            r.setEnd(node, offset);
          } else {
            r.selectNodeContents(node);
          }
        } else {
          if (offset > 0) {
            r.setStart(node, offset - 1);
            r.setEnd(node, offset);
          } else if (offset < len) {
            r.setStart(node, offset);
            r.setEnd(node, offset + 1);
          } else {
            r.selectNodeContents(node);
          }
        }
        const rect = r.getBoundingClientRect();
        if (rect.width > 0 || rect.height > 0) return rect;
      }
    } catch {}

    const el = node.nodeType === 1 ? node : node.parentElement;
    return el ? el.getBoundingClientRect() : null;
  }

  function updateHandlesAndHighlight() {
    if (!currentRange || currentRange.collapsed) {
      clearSelection();
      return;
    }

    if (highlights && Highlight) {
      highlights.set('piweb-selection', new Highlight(currentRange));
    }

    const lineRects = getFilteredLineRects(currentRange);
    if (lineRects.length === 0 || !overlayEl || !startHandle || !endHandle) return;

    bubble.set(lineRects);

    const startRect = getHandlePointRect(document, startPoint, true) || lineRects[0];
    const endRect = getHandlePointRect(document, endPoint, false) || lineRects[lineRects.length - 1];

    startHandle.style.left = `${startRect.left}px`;
    startHandle.style.top = `${startRect.top}px`;

    endHandle.style.left = `${endRect.right}px`;
    endHandle.style.top = `${endRect.bottom}px`;

    overlayEl.hidden = false;
    overlayEl.classList.add('active');

    const text = currentRange.toString().trim().slice(0, MAX_SELECTION_LENGTH);
    if (text) {
      onSelection(text, currentRange.getBoundingClientRect(), scroller);
    } else {
      clearSelection();
    }
  }

  /**
   * Extend the swipe selection from the long-pressed word. The word stays
   * selected whichever way the finger travels, so dragging forward and then
   * back past the anchor keeps growing the selection backwards instead of
   * collapsing onto the anchor edge.
   */
  function extendFromAnchorWord(word, current) {
    if (!word?.start || !word?.end) return;
    if (defaultComparePoints(document, current, word.start) < 0) {
      setRangePoints(current, word.end);
    } else if (defaultComparePoints(document, current, word.end) > 0) {
      setRangePoints(word.start, current);
    } else {
      setRangePoints(word.start, word.end);
    }
  }

  function setRangePoints(p1, p2) {
    if (!p1 || !p2) return;
    const isForward = defaultComparePoints(document, p1, p2) <= 0;
    const [s, e] = isForward ? [p1, p2] : [p2, p1];
    if (selectionOwner !== self) {
      selectionOwner?.clear();
      selectionOwner = self;
    }
    startPoint = s;
    endPoint = e;
    currentRange = createRangeBetween(document, s, e);
    updateHandlesAndHighlight();
  }

  // ── Dismiss on backdrop tap ──────────────────────────────────────────────
  // A tap on a composer card under the backdrop also reaches the card: a
  // selection quotes itself into that card, and its × (remove the quote), Send
  // and the box must not first cost a tap that only dismisses the selection.
  // The chat's card stacks above the backdrop anyway; a Dashboard pane's card
  // cannot rise out of its pane, so the backdrop covered it (iPhone, 2026-10-26:
  // × on a pane's quote opened the keyboard and kept the quote).
  function composerCardTarget(x, y) {
    const hit = withOverlayTransparent(document, () => document.elementFromPoint(x, y));
    return hit?.closest?.('.composer-wrap') ? hit : null;
  }

  // The press began on the backdrop, so the browser's own click would not reach
  // the card (a click goes to what press and release have in common): the
  // backdrop passes it on itself. Focus runs inside touchend so iOS still raises
  // the keyboard for the box.
  function passToCard(card) {
    const control = card.closest('button, [role="button"], a, label');
    if (control) control.click();
    else if (card.matches('textarea, input')) card.focus({ preventScroll: true });
  }
  let cardTap = null; // { card, x, y } while a finger that landed on a card is down

  backdrop?.addEventListener('touchstart', (e) => {
    e.stopPropagation();
    if (e.cancelable) e.preventDefault();
    const touch = e.touches[0];
    const card = touch && composerCardTarget(touch.clientX, touch.clientY);
    cardTap = card ? { card, x: touch.clientX, y: touch.clientY } : null;
    clearSelection();
  }, { passive: false });

  // Still delivered here after clearSelection() hid it: a touch keeps its target.
  backdrop?.addEventListener('touchend', (e) => {
    const tap = cardTap;
    cardTap = null;
    const touch = e.changedTouches[0];
    if (!tap || !touch || Math.hypot(touch.clientX - tap.x, touch.clientY - tap.y) > 10) return;
    if (e.cancelable) e.preventDefault();
    if (tap.card.isConnected) passToCard(tap.card);
  }, { passive: false });

  backdrop?.addEventListener('click', (e) => {
    e.stopPropagation();
    const card = composerCardTarget(e.clientX, e.clientY);
    clearSelection();
    if (card) passToCard(card);
  });

  // ── Touch on text messages (long press to trigger) ────────────────────────
  function onTouchStart(event) {
    if (event.touches.length !== 1) {
      // A second finger makes it a pinch or a two-finger drag, not a long press.
      if (pendingGesture && !pendingGesture.active) {
        if (pendingGesture.timer) window.clearTimeout(pendingGesture.timer);
        pendingGesture = null;
      }
      return;
    }
    const target = event.target;

    if (target.closest('.sel-handle, #selection-actions, .selection-actions')) return;

    if (currentRange) {
      clearSelection();
    }

    if (!target.closest('.msg-text, .event-body')) return;
    const transcript = scope ? target.closest(scope) : root;
    if (!transcript || !root.contains(transcript)) return;
    scroller = transcript;

    const touch = event.touches[0];
    const point = findTextPoint(document, touch.clientX, touch.clientY, scroller);
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
      clearNativeSelection();
      const word = expandToWord(point);
      window.navigator?.vibrate?.(12);
      pending.anchor = word;
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
    const current = findTextPoint(document, touch.clientX, touch.clientY, scroller);
    if (current && pendingGesture.anchor) {
      extendFromAnchorWord(pendingGesture.anchor, current);
    }
  }

  function onTouchEnd(event) {
    if (!pendingGesture) return;
    if (pendingGesture.timer) window.clearTimeout(pendingGesture.timer);
    if (pendingGesture.active) {
      // Lifting a long press is not a tap. Left alone, the browser clicks what
      // is under the finger, and that can be the quote/copy pill that just
      // appeared there: the selection would quote itself and vanish.
      if (event?.cancelable) event.preventDefault();
      isDragging = false;
      overlayEl?.classList.remove('dragging');
      if (currentRange && !currentRange.collapsed) {
        const text = currentRange.toString().trim().slice(0, MAX_SELECTION_LENGTH);
        if (text) onSelection(text, currentRange.getBoundingClientRect(), scroller);
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
      // Every root binds the shared handles; only the one holding the selection drags them.
      if (e.touches.length !== 1 || selectionOwner !== self) return;
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
      const newPoint = findTextPoint(document, touch.clientX, touch.clientY + yOffset, scroller);
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
        if (text) onSelection(text, currentRange.getBoundingClientRect(), scroller);
      }
    }

    targetWindow?.addEventListener?.('touchend', endDrag, { passive: true });
    targetWindow?.addEventListener?.('touchcancel', endDrag, { passive: true });
  }

  bindHandle(startHandle, true);
  bindHandle(endHandle, false);

  root.addEventListener('touchstart', onTouchStart, { passive: true });

  function gestureActive() {
    return Boolean(pendingGesture || currentRange || isDragging);
  }

  function isEditableTarget(node) {
    const el = node?.nodeType === 3 ? node.parentElement : node;
    return Boolean(el?.closest?.('input, textarea, [contenteditable=""], [contenteditable="true"]'));
  }

  // iOS may start its own document-wide selection while our long-press timer is
  // active or while a handle is being dragged. Because the transcript is
  // user-select:none, that native selection escapes to the whole page. Listen on
  // the document in the capture phase so selections that begin *outside* the
  // transcript root are cancelled too; cancelling touchstart instead would also
  // disable normal transcript scrolling.
  document.addEventListener?.(
    'selectstart',
    (event) => {
      if (!gestureActive() || isEditableTarget(event.target)) return;
      if (event.cancelable) event.preventDefault();
    },
    true,
  );

  // Last line of defence: if a native selection still slips through (iOS marks
  // the gesture non-cancelable once its own selection drag has begun), drop it
  // as soon as it appears so only our highlight is ever visible.
  document.addEventListener?.('selectionchange', () => {
    if (!gestureActive()) return;
    const selection = window?.getSelection?.();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
    if (isEditableTarget(selection.anchorNode)) return;
    selection.removeAllRanges();
  });
  const globalTarget = window || document.defaultView || document;
  globalTarget?.addEventListener?.('touchmove', onTouchMove, { passive: false });
  globalTarget?.addEventListener?.('touchend', onTouchEnd, { passive: false });
  globalTarget?.addEventListener?.('touchcancel', onTouchEnd, { passive: true });

  // Captured: a pane's transcript scrolls inside `root`, and scroll does not bubble.
  root.addEventListener('scroll', (event) => {
    if (currentRange && event.target === scroller) updateHandlesAndHighlight();
  }, { passive: true, capture: true });

  return clearSelection;
}



