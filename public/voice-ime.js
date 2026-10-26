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
 *   space.
 * Send waits for the last sentence (take()) and sends the cleaned-up text.
 *
 * The SDK is the third_party/komorebi-voice submodule, copied to
 * public/komorebi/ by `npm run build:client`, and loaded on first use.
 */

const MODE_KEY = 'piweb.voiceIme';
const SETTINGS_KEY = 'piweb.voiceIme.settings';
const TAKE_TIMEOUT_MS = 5000;
const IDLE_CLOSE_MS = 8000;

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
  const composers = new Map(); // textarea → { frame, button, onRender, placeholder }
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
    if (target.value !== shown.value) {
      // Written behind our back: keep that text as the draft.
      const merged = mergeOutsideEdit(typedText(target.value, shown.live), shown.text, text);
      shown = { text: merged, live, value: merged + live };
      dictation.setText(merged);
    } else {
      shown = { text, live, value: text + live };
    }
    target.value = shown.value;
    entry?.onRender?.(target);
    sync();
  }

  function retarget() {
    const next = resolveTarget?.() || null;
    if (next === target) return;
    target = next;
    shown = { text: target?.value ?? '', live: '', value: target?.value ?? '' };
    if (dictation && target) dictation.setText(target.value);
    sync();
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
      composers.set(textarea, { frame, button, onRender, placeholder: textarea.placeholder, overridden: false });
      textarea.addEventListener('input', () => {
        if (!dictation || textarea !== target) return;
        const typed = typedText(textarea.value, shown.live);
        shown = { text: typed, live: shown.live, value: textarea.value };
        dictation.setText(typed);
      });
      sync();
      return button;
    },
    unregister(textarea) {
      const entry = composers.get(textarea);
      if (!entry) return;
      entry.button.remove();
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
