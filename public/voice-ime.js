/**
 * Komorebi voice input for the composers (main chat and Dashboard panes).
 *
 * One mic button per composer turns voice input on for the whole app; it stays
 * on until the button turns it off again, across sends and reloads. While on:
 * - what is said streams into the visible composer (the draft so far plus the
 *   sentence being spoken), and the clean-up model rewrites the whole draft
 *   after each sentence, as in the Komorebi IME;
 * - the composers ask for no on-screen keyboard (`inputmode="none"`);
 * - the composer glows with the microphone level: a box-shadow, so it takes no
 *   space;
 * - the clean-up shows, as in the Komorebi IME page: a sentence still being
 *   heard is grey and underlined (a caret while it is spoken, breathing while
 *   it waits for the rewrite), and when the rewritten draft lands, the
 *   characters the clean-up put in are highlighted and fade out. A textarea
 *   cannot style parts of its text, so while there is something to show the
 *   same text is drawn in a layer over it (`.voice-mirror`) and the box's own
 *   text goes transparent, keeping its caret.
 * Send waits for the last sentence (take()) and sends the cleaned-up text.
 *
 * A finger stroked sideways across the box's text circles those words (as on
 * the Komorebi IME page, in the quote selection's bubble): the next sentence
 * spoken replaces them, or 刪除 takes them out. Up and down still scrolls.
 *
 * The SDK is the third_party/komorebi-voice submodule, copied to
 * public/komorebi/ by `npm run build:client`, and loaded on first use.
 */

import { createSelectionBubble } from './selection-bubble.js';

const MODE_KEY = 'piweb.voiceIme';
const SETTINGS_KEY = 'piweb.voiceIme.settings';
// Send waits this long for the sentence just spoken and its clean-up; what
// is not back by then goes as heard. The clean-up model can be slow when the
// host is busy (13s for a sentence on 2026-10-26 with the CPU saturated), and a
// send must not wait on it.
const TAKE_TIMEOUT_MS = 1200;
const IDLE_CLOSE_MS = 8000;
// The highlight on what the clean-up changed fades over 1.2s (app.css), then goes.
const FRESH_MS = 1400;
// Character diffs beyond this many cells highlight the whole changed middle.
const DIFF_CELLS = 250_000;
// What the layer over the box copies from it, so the text lands on the same pixels.
const MIRROR_STYLE = [
  'boxSizing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing',
  'wordSpacing', 'textIndent', 'textTransform', 'tabSize', 'direction',
];

export const DEFAULT_VOICE_SETTINGS = Object.freeze({
  url: 'wss://komorebi.crayfish-monitor.ts.net/v1/realtime',
  // Clean the draft up after each sentence; off, sentences go in as heard
  // (the SDK's refine: false, the Komorebi IME page's 整理全文 switch).
  tidy: true,
  // The browser's echo cancellation, noise suppression and gain control
  // (getUserMedia). On an iPhone they record like a phone call; off, the mic
  // records as is and Komorebi's own denoiser does the cleaning.
  callAudio: true,
  // Empty: Komorebi's own Gemma 4 E2B on the CPU cleans the draft up.
  refineUrl: '',
  refineModel: '',
  refineKey: '',
});

const MIC_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>';

export function readVoiceSettings(storage = globalThis.localStorage) {
  try {
    const saved = JSON.parse(storage.getItem(SETTINGS_KEY) || '{}');
    const settings = { ...DEFAULT_VOICE_SETTINGS };
    for (const key of Object.keys(settings)) {
      if (typeof settings[key] === 'boolean') {
        if (typeof saved[key] === 'boolean') settings[key] = saved[key];
      } else if (typeof saved[key] === 'string') settings[key] = saved[key].trim();
    }
    return settings;
  } catch {
    return { ...DEFAULT_VOICE_SETTINGS };
  }
}

export function saveVoiceSettings(settings, storage = globalThis.localStorage) {
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Not persisted; this page keeps using them.
  }
}

/** The Dictation model and refine options for these settings. */
export function dictationOptions(settings) {
  const url = settings.url || DEFAULT_VOICE_SETTINGS.url;
  const processing = settings.callAudio !== false;
  if (settings.tidy === false) {
    return { url, processing, model: settings.refineUrl ? 'komorebi-smart' : 'komorebi-smart-cpu-e2b', refine: false };
  }
  if (!settings.refineUrl) return { url, processing, model: 'komorebi-smart-cpu-e2b', refine: 'cpu-e2b' };
  return {
    url,
    processing,
    model: 'komorebi-smart',
    refine: {
      provider: 'openai',
      base_url: settings.refineUrl,
      model: settings.refineModel || 'default',
      ...(settings.refineKey ? { api_key: settings.refineKey } : {}),
    },
  };
}

/**
 * The box shows `text + live`; what the user typed is that minus the live tail
 * (the sentence still being heard, which the server will fold in itself).
 */
export function typedText(value, live) {
  return live && value.endsWith(live) ? value.slice(0, -live.length) : value;
}

/**
 * Someone else wrote the box since we last did (a send restoring its draft, an
 * autocomplete pick). Keep their text, and keep a sentence the server only
 * appended; a rewrite of text that is no longer there is dropped.
 */
export function mergeOutsideEdit(boxText, previousText, nextText) {
  return nextText.startsWith(previousText) ? boxText + nextText.slice(previousText.length) : boxText;
}

/**
 * How `before` became `after`, as [op, text] runs: '=' kept, '+' put in, '-'
 * taken out. Common prefix and suffix first, then a character LCS over the
 * middle (or the whole middle replaced, when it is too large to diff).
 */
export function diffRuns(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  )
    end++;
  const a = before.slice(start, before.length - end);
  const b = after.slice(start, after.length - end);
  const runs = [];
  const push = (op, text) => {
    if (!text) return;
    const last = runs.at(-1);
    if (last?.[0] === op) last[1] += text;
    else runs.push([op, text]);
  };
  push('=', before.slice(0, start));
  if (a.length * b.length > DIFF_CELLS) {
    push('-', a);
    push('+', b);
  } else {
    const n = a.length;
    const m = b.length;
    const table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) {
        push('=', a[i]);
        i++;
        j++;
      } else if (j >= m || (i < n && table[i + 1][j] >= table[i][j + 1])) {
        push('-', a[i++]);
      } else {
        push('+', b[j++]);
      }
    }
  }
  push('=', before.slice(before.length - end));
  return runs;
}

/** The [start, end) ranges of `after` that are not in `before`. */
export function freshRanges(before, after) {
  const ranges = [];
  let at = 0;
  for (const [op, text] of diffRuns(before, after)) {
    if (op === '-') continue;
    if (op === '+') ranges.push([at, at + text.length]);
    at += text.length;
  }
  return ranges;
}

/** Microphone RMS (0–1) → glow strength (0–1): room noise stays dark. */
export function glowLevel(rms) {
  return Math.max(0, Math.min(1, (rms - 0.012) / 0.12));
}

export function createVoiceIme({
  resolveTarget,
  storage = globalThis.localStorage,
  loadSdk = () => import('./komorebi/index.js'),
  doc = globalThis.document,
} = {}) {
  const composers = new Map(); // textarea → { frame, button, mirror, onRender, placeholder }
  const stages = new Map(); // item_id → 'listening' | 'refining'
  // Sentences still being rewritten when the user typed: their rewrite was made
  // from the draft before the typing, so when it lands the typed text wins.
  const staleItems = new Set();
  // Sentences already sent as heard because their clean-up was late: their
  // events no longer belong to the box, and their rewrite is of a sent draft.
  const sentItems = new Set();
  let keepTyped = false;
  let fresh = { text: '', runs: [], timer: 0 }; // how the last rewrite changed the text, while it shows
  let on = false;
  let dictation = null;
  let target = null;
  let shown = { text: '', live: '', value: '' }; // what render() last wrote into target
  let starting = null;
  let error = '';
  let retried = false; // the tap after an error retried; the next one turns voice off
  let closeTimer = 0;
  let armed = false;
  // The lasso over the box's text: { start, end, text, item } in shown.text;
  // `item` is the sentence that is replacing it.
  let lasso = null;
  let stroke = null; // a finger on the box that may become a lasso
  let lassoUi = null; // the bubble and the 刪除/取消 pill, made on first use
  const segmenter = globalThis.Intl?.Segmenter ? new Intl.Segmenter('zh-Hant', { granularity: 'word' }) : null;

  try {
    on = storage.getItem(MODE_KEY) === 'on';
  } catch {
    on = false;
  }

  function persist() {
    try {
      storage.setItem(MODE_KEY, on ? 'on' : 'off');
    } catch {
      // In-memory only.
    }
  }

  function setLevel(rms) {
    const entry = target && composers.get(target);
    entry?.frame.style.setProperty('--voice-level', glowLevel(rms).toFixed(3));
  }

  function sync() {
    const listening = Boolean(dictation?.listening);
    for (const [textarea, entry] of composers) {
      const mine = textarea === target;
      entry.button.setAttribute('aria-pressed', String(on));
      entry.button.classList.toggle('voice-on', on);
      entry.button.classList.toggle('voice-error', on && Boolean(error));
      entry.button.title = !on
        ? '語音輸入'
        : error
          ? `語音輸入：${error}（點一下重試，再點一下關閉）`
          : listening
            ? '語音輸入中（點一下關閉）'
            : '語音輸入（點畫面任何地方開始收音）';
      entry.button.setAttribute('aria-label', on ? '關閉語音輸入' : '開啟語音輸入');
      // No on-screen keyboard while voice input is on; the box still takes a
      // hardware keyboard, paste and the caret.
      if (on) textarea.setAttribute('inputmode', 'none');
      else textarea.removeAttribute('inputmode');
      // The box says what voice input is doing; its own placeholder (which the
      // Dashboard rewrites for renames and BTW) comes back afterwards.
      const status =
        on && mine ? (error ? `語音輸入：${error}` : listening ? '說話即可輸入…' : '點一下畫面開始收音…') : null;
      const before = textarea.placeholder;
      if (status) {
        if (!entry.overridden) entry.placeholder = textarea.placeholder;
        entry.overridden = true;
        textarea.placeholder = status;
      } else if (entry.overridden) {
        entry.overridden = false;
        textarea.placeholder = entry.placeholder;
      }
      // An empty box is as tall as its placeholder: measure it again, or the
      // height a long status gave it stays after the status goes.
      if (textarea.placeholder !== before && !textarea.value) entry.onRender?.(textarea);
      entry.frame.classList.toggle('voice-listening', on && mine && listening);
      entry.frame.classList.toggle('voice-hearing', on && mine && listening && Boolean(shown.live));
      if (!(on && mine && listening)) entry.frame.style.removeProperty('--voice-level');
    }
  }

  function render({ text, live }) {
    if (!target) return;
    const entry = composers.get(target);
    if (keepTyped && target.value === shown.value) {
      // A rewrite of the draft from before the user typed: keep the typing.
      keepTyped = false;
      if (text !== shown.text) {
        dictation.setText(shown.text);
        dictation.syncDraft();
      }
      shown = { text: shown.text, live, value: shown.text + live };
    } else if (target.value !== shown.value) {
      // Written behind our back: keep that text as the draft.
      const merged = mergeOutsideEdit(typedText(target.value, shown.live), shown.text, text);
      shown = { text: merged, live, value: merged + live };
      dictation.setText(merged);
    } else {
      // The draft was rewritten: what it says now against what was on screen
      // (the old draft and the sentences as heard) is what the clean-up did.
      if (text !== shown.text && text) showFresh(text, diffRuns(shown.text + shown.live, text));
      shown = { text, live, value: text + live };
    }
    target.value = shown.value;
    if (lasso && shown.text.slice(lasso.start, lasso.end) !== lasso.text) {
      lasso = null;
      if (dictation?.selection) dictation.select(null);
      lassoUi?.bubble.clear();
      if (lassoUi) lassoUi.actions.hidden = true;
    }
    entry?.onRender?.(target);
    sync();
    decorate();
  }

  function showFresh(text, runs) {
    clearTimeout(fresh.timer);
    fresh = {
      text,
      runs: runs.some(([op]) => op !== '=') ? runs : [],
      timer: setTimeout(() => {
        fresh = { text: '', runs: [], timer: 0 };
        decorate();
      }, FRESH_MS),
    };
  }

  function trackStage(event) {
    const id = event.item_id;
    if (!id) return;
    if (event.type === 'input_audio_buffer.speech_started') stages.set(id, 'listening');
    else if (
      event.type === 'input_audio_buffer.speech_stopped' ||
      event.type === 'input_audio_buffer.committed' ||
      event.type === 'conversation.item.input_audio_transcription.completed' ||
      (event.type === 'komorebi.input_audio_transcription.partial' && event.stage === 'asr_final')
    )
      stages.set(id, 'refining');
    else if (event.type === 'komorebi.draft.updated') {
      for (const item of event.item_ids || [id]) stages.delete(item);
    }
  }

  /** Draw the box's text over it with the sentences being heard and what the
   *  clean-up changed marked, or hand the box back its own text. */
  function decorate() {
    for (const [textarea, entry] of composers) {
      const pending = textarea === target && dictation ? [...dictation.pending] : [];
      // While circling, the layer holds the text as one node to measure.
      const runs = textarea === target && fresh.text === shown.text && !lasso ? fresh.runs : [];
      const live = pending.some(([, heard]) => heard);
      const show =
        textarea === target && on && (live || runs.length > 0 || Boolean(lasso)) && textarea.value === shown.value;
      textarea.classList.toggle('voice-mirrored', show);
      entry.mirror.hidden = !show;
      if (!show) {
        entry.mirror.replaceChildren();
        continue;
      }
      const style = getComputedStyle(textarea);
      for (const key of MIRROR_STYLE) entry.mirror.style[key] = style[key];
      Object.assign(entry.mirror.style, {
        left: `${textarea.offsetLeft}px`,
        top: `${textarea.offsetTop}px`,
        width: `${textarea.offsetWidth}px`,
        height: `${textarea.offsetHeight}px`,
      });
      // What the rewrite put in is highlighted; what it took out stays a
      // moment, struck through, and shrinks away (app.css).
      const nodes = [];
      for (const [op, text] of runs.length ? runs : [['=', shown.text]]) {
        if (op === '=') {
          nodes.push(doc.createTextNode(text));
          continue;
        }
        const run = doc.createElement(op === '+' ? 'mark' : 'del');
        run.className = op === '+' ? 'voice-fresh' : 'voice-gone';
        run.textContent = text;
        nodes.push(run);
      }
      for (const [id, heard] of pending) {
        if (!heard) continue;
        const span = doc.createElement('span');
        span.className = `voice-preedit ${stages.get(id) || 'refining'}`;
        span.textContent = heard;
        nodes.push(span);
      }
      // A trailing newline only takes a line in the layer with something after it.
      nodes.push(doc.createTextNode('\u200b'));
      entry.mirror.replaceChildren(...nodes);
      entry.mirror.scrollTop = textarea.scrollTop;
      entry.text = nodes[0]?.nodeType === 3 ? nodes[0] : null;
      if (runs.length) {
        // Painted as changed first, then eased out (the transitions in app.css).
        const marks = entry.mirror.querySelectorAll('.voice-fresh:not(.settled), .voice-gone:not(.settled)');
        requestAnimationFrame(() =>
          requestAnimationFrame(() => marks.forEach((mark) => mark.classList.add('settled'))),
        );
      }
    }
    if (lasso) renderLasso();
  }

  // ---- lasso: stroke across words to circle them, then say what they become ----

  function lassoParts() {
    if (lassoUi || !doc?.body) return lassoUi;
    const layer = doc.createElement('div');
    layer.className = 'voice-lasso-layer';
    layer.setAttribute('aria-hidden', 'true');
    const actions = doc.createElement('div');
    actions.className = 'selection-actions voice-lasso-actions';
    actions.setAttribute('role', 'toolbar');
    actions.setAttribute('aria-label', '圈選的字：說話就換掉');
    actions.hidden = true;
    actions.innerHTML =
      '<button type="button" data-act="delete">刪除</button><button type="button" data-act="cancel">取消</button>';
    // Keep the box's focus (no keyboard) and the circle while a button is pressed.
    actions.addEventListener('pointerdown', (event) => event.preventDefault());
    actions.addEventListener('click', (event) => {
      const act = event.target.closest?.('[data-act]')?.dataset.act;
      if (act === 'delete') deleteLasso();
      else if (act === 'cancel') dropLasso();
    });
    doc.body.append(layer, actions);
    const bubble = createSelectionBubble(layer, {
      window: doc.defaultView,
      scroller: { get scrollTop() { return target?.scrollTop ?? 0; } },
    });
    lassoUi = { layer, actions, bubble };
    return lassoUi;
  }

  /** The text node the layer draws shown.text in, while circling. */
  function lassoText() {
    const node = target && composers.get(target)?.text;
    return node?.isConnected && node.data === shown.text ? node : null;
  }

  /** The character of shown.text under (x, y): on the line under the finger,
   *  the nearest one; null without text. */
  function charAtPoint(x, y) {
    const node = lassoText();
    if (!node) return null;
    const range = doc.createRange();
    let best = null;
    let bestScore = Infinity;
    for (let i = 0; i < node.data.length; i++) {
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const rect = range.getBoundingClientRect();
      if (!rect.width) continue;
      const dy = Math.max(rect.top - y, y - rect.bottom, 0);
      const dx = Math.max(rect.left - x, x - rect.right, 0);
      const score = dy * 1000 + dx;
      if (score < bestScore) {
        bestScore = score;
        best = i;
        if (!score) break;
      }
    }
    return best;
  }

  /** Whole words, so a quick stroke does not have to land on character edges. */
  function wordAt(text, index) {
    const segment = segmenter?.segment(text).containing(index);
    return segment ? [segment.index, segment.index + segment.segment.length] : [index, index + 1];
  }

  function setLasso(anchor, focus) {
    const [a0, a1] = wordAt(shown.text, anchor);
    const [f0, f1] = wordAt(shown.text, focus);
    const start = Math.min(a0, f0);
    const end = Math.max(a1, f1);
    if (lasso?.start === start && lasso?.end === end) return;
    lasso = { start, end, text: shown.text.slice(start, end), item: null };
    renderLasso();
  }

  function renderLasso() {
    const ui = lassoParts();
    const node = lassoText();
    if (!ui || !lasso || !node || lasso.end > node.data.length) return;
    const range = doc.createRange();
    range.setStart(node, lasso.start);
    range.setEnd(node, lasso.end);
    ui.bubble.set(Array.from(range.getClientRects()));
    // No pill while the finger is still circling, nor while the sentence that
    // replaces the words is spoken.
    ui.actions.hidden = Boolean(stroke || lasso.item);
    if (ui.actions.hidden) return;
    const box = range.getBoundingClientRect();
    const view = doc.defaultView;
    const half = ui.actions.offsetWidth / 2 + 8;
    ui.actions.style.left = `${Math.min(view.innerWidth - half, Math.max(half, box.left + box.width / 2))}px`;
    // Above the words: the box sits at the bottom of the screen.
    const above = box.top - ui.actions.offsetHeight - 12;
    ui.actions.style.top = `${above > 56 ? above : box.bottom + 12}px`;
  }

  function finishLasso() {
    const ui = lassoParts();
    if (!lasso || !dictation || !ui) return;
    ui.actions.hidden = false;
    ui.actions.style.animation = 'none';
    void ui.actions.offsetWidth; // the pop again for every new circle
    ui.actions.style.animation = '';
    renderLasso();
    dictation.select(lasso.start, lasso.end);
    if (!dictation.listening) void start();
  }

  /** Put the circle away; the server forgets it too. */
  function dropLasso() {
    if (!lasso && !stroke) return;
    lasso = null;
    stroke = null;
    if (dictation?.selection) dictation.select(null);
    if (lassoUi) {
      lassoUi.bubble.clear();
      lassoUi.actions.hidden = true;
    }
    decorate();
  }

  function deleteLasso() {
    if (!lasso || !target || !dictation) return;
    const before = shown.text;
    const text = before.slice(0, lasso.start) + before.slice(lasso.end);
    dropLasso();
    shown = { text, live: shown.live, value: text + shown.live };
    target.value = shown.value;
    dictation.setText(text);
    dictation.syncDraft();
    showFresh(text, diffRuns(before, text));
    composers.get(target)?.onRender?.(target);
    sync();
    decorate();
  }

  function lassoEvent(event) {
    if (!lasso) return;
    if (event.type === 'input_audio_buffer.speech_started' && dictation?.selection && !lasso.item) {
      lasso.item = event.item_id;
      renderLasso();
    } else if (event.item_id && event.item_id === lasso.item) {
      const heardNothing =
        event.type === 'conversation.item.input_audio_transcription.failed' ||
        (event.type === 'conversation.item.input_audio_transcription.completed' && !event.transcript);
      if (event.type === 'komorebi.selection.replaced') dropLasso();
      else if (heardNothing) {
        // Nothing was said: the words stay circled for the next sentence.
        lasso.item = null;
        renderLasso();
      }
    }
  }

  function strokeMove(event) {
    if (!stroke || event.pointerId !== stroke.id) return;
    if (stroke.anchor == null) {
      const dx = event.clientX - stroke.x;
      const dy = event.clientY - stroke.y;
      if (Math.hypot(dx, dy) < 8) return;
      // Up and down scrolls; only a sideways stroke circles, and not while a
      // sentence is still being heard or rewritten (its offsets would move).
      if (Math.abs(dx) <= Math.abs(dy) || dictation?.pending.size || lasso?.item || !shown.text) {
        stroke = null;
        return;
      }
      if (lasso) dropLasso();
      lasso = { start: 0, end: 0, text: '', item: null }; // draws the layer to measure
      decorate();
      const anchor = charAtPoint(stroke.x, stroke.y);
      if (anchor == null) {
        dropLasso();
        return;
      }
      stroke.anchor = anchor;
      lasso = null;
      globalThis.navigator?.vibrate?.(10);
    }
    setLasso(stroke.anchor, charAtPoint(event.clientX, event.clientY) ?? stroke.anchor);
  }

  function strokeEnd(event) {
    if (!stroke || event.pointerId !== stroke.id) return;
    const drew = stroke.anchor != null;
    stroke = null;
    if (drew) finishLasso();
    else if (lasso && !lasso.item && event.type === 'pointerup') dropLasso(); // a tap puts it away
  }

  if (doc?.addEventListener) {
    doc.addEventListener('pointermove', strokeMove);
    doc.addEventListener('pointerup', strokeEnd);
    doc.addEventListener('pointercancel', strokeEnd);
    // A tap anywhere but the box and the pill puts the circle away.
    doc.addEventListener(
      'pointerdown',
      (event) => {
        if (!lasso || lasso.item || stroke) return;
        const at = event.target;
        if (at === target || lassoUi?.actions.contains(at)) return;
        dropLasso();
      },
      true,
    );
    doc.defaultView?.addEventListener?.('resize', () => lasso && renderLasso());
  }

  function retarget() {
    const next = resolveTarget?.() || null;
    if (next === target) return;
    dropLasso();
    target = next;
    shown = { text: target?.value ?? '', live: '', value: target?.value ?? '' };
    if (dictation && target) dictation.setText(target.value);
    sync();
    decorate();
  }

  async function ensureDictation() {
    if (dictation) return dictation;
    const { Dictation } = await loadSdk();
    const options = dictationOptions(readVoiceSettings(storage));
    dictation = new Dictation({
      ...options,
      onchange: render,
      onerror: (err) => {
        error = err?.message || '連線失敗';
        sync();
        if (on && !dictation?.listening) armGesture();
      },
    });
    dictation.voice.onLevel = setLevel;
    const handle = dictation.voice.onEvent;
    dictation.voice.onEvent = (event) => {
      trackStage(event);
      if (event.type === 'komorebi.draft.updated') {
        const items = event.item_ids || [event.item_id];
        if (items.some((item) => staleItems.has(item) || sentItems.has(item))) keepTyped = true;
        for (const item of items) {
          staleItems.delete(item);
          sentItems.delete(item);
        }
      } else if (event.item_id && sentItems.has(event.item_id)) {
        return; // a sentence that already went out with the last send
      }
      handle(event);
      lassoEvent(event);
    };
    return dictation;
  }

  async function start() {
    if (!on) return;
    if (starting) return starting;
    clearTimeout(closeTimer);
    starting = (async () => {
      retarget();
      const d = await ensureDictation();
      if (d.listening) return;
      error = '';
      if (target) {
        shown = { text: target.value, live: '', value: target.value };
        d.setText(target.value);
      }
      // Without the keyboard there is nothing to type into: drop it now.
      if (doc?.activeElement && composers.has(doc.activeElement)) doc.activeElement.blur();
      await d.start();
      retried = false;
    })()
      .catch((err) => {
        error = err?.message || '無法開始收音';
        armGesture();
      })
      .finally(() => {
        starting = null;
        sync();
      });
    return starting;
  }

  async function stop() {
    const d = dictation;
    if (!d) return;
    await d.stop().catch(() => {});
    sync();
    // Let the last sentence land, then close the connection.
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      if (on || dictation !== d) return;
      d.close();
      dictation = null;
    }, IDLE_CLOSE_MS);
  }

  // Browsers only start audio from a user gesture, so after a reload, a return
  // to the page or a dropped connection the next tap anywhere starts it again.
  function armGesture() {
    if (armed || !doc) return;
    armed = true;
    const go = (event) => {
      if (event.target?.closest?.('.voice-ime-btn')) return; // the button decides itself
      disarm();
      void start();
    };
    const disarm = () => {
      armed = false;
      doc.removeEventListener('pointerdown', go, true);
      doc.removeEventListener('keydown', go, true);
    };
    doc.addEventListener('pointerdown', go, true);
    doc.addEventListener('keydown', go, true);
  }

  function toggle() {
    if (on && error && !dictation?.listening && !retried) {
      // The first tap after an error retries; if that fails too, the next
      // turns voice input off (a refused microphone failed every retry at
      // once, so voice input could not be turned off at all).
      retried = true;
      error = '';
      void start();
      return;
    }
    retried = false;
    on = !on;
    if (!on) dropLasso();
    persist();
    error = '';
    if (on) void start();
    else void stop();
    sync();
    decorate();
  }

  doc?.addEventListener?.('visibilitychange', () => {
    if (on && doc.visibilityState === 'visible' && !dictation?.listening) armGesture();
  });

  return {
    get on() {
      return on;
    },
    get listening() {
      return Boolean(dictation?.listening);
    },
    /** Add the mic button to a composer. `frame` glows; `before` is where the
     *  button goes; `onRender` runs after voice writes the box (autoGrow). */
    register(textarea, { frame, before, onRender }) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'icon-btn voice-ime-btn';
      button.innerHTML = MIC_ICON;
      // Keep focus (and so any keyboard) where it is.
      button.addEventListener('pointerdown', (event) => event.preventDefault());
      button.addEventListener('click', () => {
        retarget();
        toggle();
      });
      before.before(button);
      const mirror = doc.createElement('div');
      mirror.className = 'voice-mirror';
      mirror.setAttribute('aria-hidden', 'true');
      mirror.hidden = true;
      frame.classList.add('voice-ime-frame');
      frame.append(mirror);
      composers.set(textarea, { frame, button, mirror, onRender, placeholder: textarea.placeholder, overridden: false });
      // A finger on the box may stroke sideways and circle words (see lasso).
      textarea.addEventListener('pointerdown', (event) => {
        if (!on || textarea !== target || event.pointerType === 'mouse' || !event.isPrimary) return;
        stroke = { id: event.pointerId, x: event.clientX, y: event.clientY, anchor: null };
      });
      // iOS would still pan the page or move the caret with a circling stroke.
      textarea.addEventListener(
        'touchmove',
        (event) => {
          if (stroke?.anchor != null && event.cancelable) event.preventDefault();
        },
        { passive: false },
      );
      // A mouse selects in the box as usual; letting go circles the selection.
      textarea.addEventListener('mouseup', () =>
        setTimeout(() => {
          const { selectionStart: start, selectionEnd: end } = textarea;
          if (!on || !dictation || textarea !== target || start >= end || dictation.pending.size) return;
          if (end > shown.text.length || lasso?.item) return;
          dropLasso();
          lasso = { start, end, text: shown.text.slice(start, end), item: null };
          textarea.setSelectionRange(end, end);
          decorate();
          finishLasso();
        }),
      );
      textarea.addEventListener('scroll', () => lasso && renderLasso(), { passive: true });
      textarea.addEventListener('input', () => {
        if (textarea === target) dropLasso();
        if (!dictation || textarea !== target) return;
        const typed = typedText(textarea.value, shown.live);
        shown = { text: typed, live: shown.live, value: textarea.value };
        for (const item of dictation.pending.keys()) staleItems.add(item);
        dictation.setText(typed);
        // Now, not after the SDK's 300ms: a sentence ending in between would
        // be rewritten from the old draft.
        dictation.syncDraft();
        decorate();
      });
      textarea.addEventListener('scroll', () => {
        if (!mirror.hidden) mirror.scrollTop = textarea.scrollTop;
      }, { passive: true });
      sync();
      return button;
    },
    unregister(textarea) {
      const entry = composers.get(textarea);
      if (!entry) return;
      entry.button.remove();
      entry.mirror.remove();
      composers.delete(textarea);
      if (target === textarea) retarget();
    },
    /** The visible composer may have changed (Dashboard on/off, pane switch). */
    retarget,
    /** The app wrote the box itself (autocomplete): that is the draft now. */
    sync(textarea) {
      if (!dictation || textarea !== target) return;
      shown = { text: textarea.value, live: '', value: textarea.value };
      dictation.setText(textarea.value);
      decorate();
    },
    /**
     * Before sending from `textarea`: finish the sentence being spoken, wait for
     * the clean-up, and return the text to send (and clear the draft). Null
     * when voice input is not writing this box.
     */
    async take(textarea) {
      const d = dictation;
      if (!d || textarea !== target) return null;
      if (!d.listening && !d.busy && !d.text) return null;
      dropLasso();
      // End the sentence being spoken, and give it and the clean-up a moment.
      if (d.voice.listening && d.voice.finishUtterance()) d.awaitingCommit = true;
      if (d.busy && d.voice.connected) {
        await new Promise((resolve) => {
          d.waiters.push(resolve);
          setTimeout(resolve, TAKE_TIMEOUT_MS);
        });
      }
      // Whatever is not cleaned up yet goes as heard; its late rewrite is dropped.
      const text = d.text + d.live;
      for (const item of d.pending.keys()) sentItems.add(item);
      d.pending.clear();
      d.awaitingCommit = false;
      d.selection = null;
      d.text = '';
      d.syncDraft();
      // Empty the box too before telling anyone: a box still showing the
      // sentence would read as text typed behind voice input's back, and
      // render() would put it back into the draft. The caller sends `text`.
      textarea.value = '';
      shown = { text: '', live: '', value: '' };
      d.emit();
      return text;
    },
    /** The settings changed: a new server reconnects, a new clean-up model
     *  applies from the next sentence, new mic processing reopens the mic. */
    reconfigure() {
      const d = dictation;
      if (!d) return;
      const options = dictationOptions(readVoiceSettings(storage));
      if (d.voice.url !== options.url) {
        dictation = null;
        void d.stop().finally(() => d.close());
        if (on) void start();
        return;
      }
      d.model = options.model;
      d.setRefine(options.refine);
      // A running microphone reopens with the new processing.
      d.setProcessing(options.processing).catch((err) => {
        error = err?.message || '無法開始收音';
        sync();
        armGesture();
      });
    },
    /** Called once at boot: voice input that was left on resumes on the next tap. */
    resume() {
      sync();
      if (on) armGesture();
    },
  };
}
