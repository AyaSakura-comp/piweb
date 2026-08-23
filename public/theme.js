const STORAGE_KEY = 'piweb.theme';
const THEME_COLORS = {
  dark: '#1e1f22',
  light: '#ffffff',
};

function defaultStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** Read the explicit appearance choice. Dark remains the safe/default theme. */
export function readTheme(storage = defaultStorage()) {
  try {
    return storage?.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function saveTheme(storage, theme) {
  try {
    storage?.setItem(STORAGE_KEY, theme);
  } catch {
    // Private browsing and locked-down storage should not break the toggle.
  }
}

function syncButton(button, theme) {
  const light = theme === 'light';
  const label = button.querySelector('[data-theme-label]');
  if (label) label.textContent = light ? 'Dark mode' : 'Light mode';
  button.setAttribute('aria-label', light ? 'Switch to dark mode' : 'Switch to light mode');
  button.setAttribute('aria-pressed', String(light));
}

/** Bind a light/dark appearance action and return a small imperative controller. */
export function bindThemeToggle(button, options = {}) {
  const root = options.root ?? globalThis.document?.documentElement;
  const storage = options.storage ?? defaultStorage();
  const themeColor =
    options.themeColor ?? globalThis.document?.querySelector('meta[name="theme-color"]');
  let theme = readTheme(storage);

  function apply(nextTheme, persist = true) {
    theme = nextTheme === 'light' ? 'light' : 'dark';
    if (root) {
      root.dataset.theme = theme;
      root.style.colorScheme = theme;
    }
    themeColor?.setAttribute('content', THEME_COLORS[theme]);
    syncButton(button, theme);
    if (persist) saveTheme(storage, theme);
    return theme;
  }

  function toggle() {
    const nextTheme = apply(theme === 'light' ? 'dark' : 'light');
    options.afterToggle?.(nextTheme);
    return nextTheme;
  }

  const onClick = () => toggle();
  button.addEventListener('click', onClick);
  apply(theme, false);

  return {
    get theme() {
      return theme;
    },
    setTheme: apply,
    toggle,
    destroy() {
      button.removeEventListener('click', onClick);
    },
  };
}
