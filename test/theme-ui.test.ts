import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const root = resolve(import.meta.dirname, '..');

class MemoryStorage {
  values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class ThemeButton {
  attributes = new Map<string, string>();
  label = { textContent: '' };
  listener?: () => void;

  addEventListener(type: string, listener: () => void): void {
    if (type === 'click') this.listener = listener;
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type === 'click' && this.listener === listener) this.listener = undefined;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  querySelector(selector: string): { textContent: string } | null {
    return selector === '[data-theme-label]' ? this.label : null;
  }

  click(): void {
    this.listener?.();
  }
}

describe('day mode', () => {
  it('restores light mode, toggles back to dark, and persists the choice', async () => {
    const { bindThemeToggle } = await import('../public/theme.js');
    const storage = new MemoryStorage();
    storage.setItem('piweb.theme', 'light');
    const documentRoot = { dataset: {}, style: { colorScheme: '' } };
    const themeColor = { setAttribute: vi.fn() };
    const button = new ThemeButton();
    const afterToggle = vi.fn();

    const controller = bindThemeToggle(button, {
      root: documentRoot,
      storage,
      themeColor,
      afterToggle,
    });

    expect(documentRoot.dataset).toEqual({ theme: 'light' });
    expect(documentRoot.style.colorScheme).toBe('light');
    expect(themeColor.setAttribute).toHaveBeenLastCalledWith('content', '#ffffff');
    expect(button.label.textContent).toBe('Dark mode');
    expect(button.getAttribute('aria-label')).toBe('Switch to dark mode');
    expect(button.getAttribute('aria-pressed')).toBe('true');

    button.click();

    expect(controller.theme).toBe('dark');
    expect(documentRoot.dataset).toEqual({ theme: 'dark' });
    expect(storage.getItem('piweb.theme')).toBe('dark');
    expect(themeColor.setAttribute).toHaveBeenLastCalledWith('content', '#1e1f22');
    expect(button.label.textContent).toBe('Light mode');
    expect(button.getAttribute('aria-label')).toBe('Switch to light mode');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(afterToggle).toHaveBeenCalledWith('dark');

    controller.destroy();
    button.click();
    expect(controller.theme).toBe('dark');
  });

  it('falls back to dark mode when browser storage is unavailable', async () => {
    const { readTheme } = await import('../public/theme.js');
    const storage = {
      getItem: vi.fn(() => {
        throw new Error('storage denied');
      }),
    };

    expect(readTheme(storage)).toBe('dark');
  });

  it('loads the saved theme before CSS and exposes the theme action in the drawer footer', () => {
    const html = readFileSync(resolve(root, 'public/index.html'), 'utf8');
    const css = readFileSync(resolve(root, 'public/app.css'), 'utf8');
    const app = readFileSync(resolve(root, 'public/app.js'), 'utf8');
    const drawerFooter = html.match(/<footer class="drawer-foot">([\s\S]*?)<\/footer>/)?.[1] ?? '';
    const moreMenu = html.match(/<div class="menu-pop"[\s\S]*?<\/div>/)?.[0] ?? '';

    expect(drawerFooter).toContain('id="btn-theme"');
    expect(drawerFooter).toContain('data-theme-toggle');
    expect(drawerFooter).toContain('data-theme-label');
    expect(moreMenu).not.toContain('data-theme-toggle');
    expect(html.indexOf("localStorage.getItem('piweb.theme')")).toBeLessThan(
      html.indexOf('<link rel="stylesheet" href="/app.css"'),
    );
    expect(css).toContain(":root[data-theme='light']");
    expect(css).toContain('--bg: #ffffff;');
    expect(css).toContain('--bg-alt: #fbfaf7;');
    expect(css).toContain('--bg-input: #f4f2ed;');
    expect(css).toContain('--border: #dedbd3;');
    expect(css).toContain('--text-bright: #1f1e1a;');
    expect(css).toContain('--accent: #3f5f6f;');
    expect(css).toMatch(/:root\[data-theme='light'\] \.event \{[^}]*box-shadow: none;/s);
    expect(css).toMatch(
      /:root\[data-theme='light'\] \.msg-text pre,[\s\S]*?background: var\(--bg-input\);/,
    );
    expect(css).toMatch(
      /:root\[data-theme='light'\] \.msg-text pre code,[\s\S]*?color: var\(--text\);/,
    );
    expect(app).toContain("import { bindThemeToggle } from './theme.js';");
    expect(app).toContain("bindThemeToggle($('btn-theme'))");
  });
});
