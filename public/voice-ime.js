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
 * The SDK is the third_party/komorebi-voice submodule, copied to
 * public/komorebi/ by `npm run build:client`, and loaded on first use.
 */

const MODE_KEY = 'piweb.voiceIme';
const SETTINGS_KEY = 'piweb.voiceIme.settings';
const TAKE_TIMEOUT_MS = 5000;
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
      if (typeof saved[key] === 'string') settings[key] = saved[key].trim();
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
  if (!settings.refineUrl) return { url, model: 'komorebi-smart-cpu-e2b', refine: 'cpu-e2b' };
  return {
    url,
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
  let keepTyped = false;
  let fresh = { text: '', runs: [], timer: 0 }; // how the last rewrite changed the text, while it shows
  let on = false;
  let dictation = null;
  let target = null;
  let shown = { text: '', live: '', value: '' }; // what render() last wrote into target
  let starting = null;
  let error = '';
  let closeTimer = 0;
  let armed = false;

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
      if (status) {
        if (!entry.overridden) entry.placeholder = textarea.placeholder;
        entry.overridden = true;
        textarea.placeholder = status;
      } else if (entry.overridden) {
        entry.overridden = false;
        textarea.placeholder = entry.placeholder;
      }
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
      const runs = textarea === target && fresh.text === shown.text ? fresh.runs : [];
      const live = pending.some(([, heard]) => heard);
      const show = textarea === target && on && (live || runs.length > 0) && textarea.value === shown.value;
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
      if (runs.length) {
        // Painted as changed first, then eased out (the transitions in app.css).
        const marks = entry.mirror.querySelectorAll('.voice-fresh:not(.settled), .voice-gone:not(.settled)');
        requestAnimationFrame(() =>
          requestAnimationFrame(() => marks.forEach((mark) => mark.classList.add('settled'))),
        );
      }
    }
  }

  function retarget() {
    const next = resolveTarget?.() || null;
    if (next === target) return;
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
        if (items.some((item) => staleItems.has(item))) keepTyped = true;
        for (const item of items) staleItems.delete(item);
      }
      handle(event);
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
    if (on && error && !dictation?.listening) {
      // The first tap after an error retries.
      error = '';
      void start();
      return;
    }
    on = !on;
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
      textarea.addEventListener('input', () => {
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
      if (!dictation || textarea !== target) return null;
      if (!dictation.listening && !dictation.busy && !dictation.text) return null;
      const text = await dictation.take({ timeout: TAKE_TIMEOUT_MS });
      shown = { text: '', live: '', value: '' };
      return text;
    },
    /** The settings changed: a new server reconnects, a new clean-up model
     *  applies from the next sentence. */
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
    },
    /** Called once at boot: voice input that was left on resumes on the next tap. */
    resume() {
      sync();
      if (on) armGesture();
    },
  };
}
