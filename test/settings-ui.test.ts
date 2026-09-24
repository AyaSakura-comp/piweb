import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');

describe('settings page', () => {
  it('requests notification permission before awaiting service-worker setup', () => {
    const app = readFileSync(resolve(root, 'public/app.js'), 'utf8');
    const toggle = app.match(/async function toggleNotifications\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';

    expect(toggle.indexOf('await Notification.requestPermission()')).toBeGreaterThan(-1);
    expect(toggle.indexOf('await Notification.requestPermission()')).toBeLessThan(
      toggle.indexOf("navigator.serviceWorker.register('/sw.js')"),
    );
  });

  it('moves drawer utilities into one settings dialog and includes Pi subscription controls', () => {
    const html = readFileSync(resolve(root, 'public/index.html'), 'utf8');
    const app = readFileSync(resolve(root, 'public/app.js'), 'utf8');
    const css = readFileSync(resolve(root, 'public/app.css'), 'utf8');
    const drawerFooter = html.match(/<footer class="drawer-foot">([\s\S]*?)<\/footer>/)?.[1] ?? '';
    const settings = html.match(/<dialog[^>]+id="settings-dialog"[\s\S]*?<\/dialog>/)?.[0] ?? '';

    expect(drawerFooter).toContain('id="btn-settings"');
    expect(drawerFooter).not.toContain('id="btn-trash"');
    expect(drawerFooter).not.toContain('id="btn-notify"');
    expect(drawerFooter).not.toContain('id="btn-theme"');
    expect(drawerFooter).not.toContain('id="btn-logout"');

    expect(settings).toContain('id="btn-trash"');
    expect(settings).toMatch(/id="btn-notify"[^>]+role="switch"[^>]+aria-checked="false"/);
    expect(settings).toContain('class="notification-toggle"');
    expect(settings).not.toContain('class="settings-value notif-state"');
    expect(settings).toContain('id="btn-theme"');
    expect(settings).toContain('id="btn-logout"');
    expect(settings).toContain('id="subscription-openai"');
    expect(settings).toContain('id="subscription-device-code"');
    expect(settings).toContain('id="subscription-verification-link"');
    const trashPage = html.match(/<section[^>]+id="trash-sheet"[\s\S]*?<\/section>/)?.[0] ?? '';
    expect(trashPage.indexOf('id="btn-trash-close"')).toBeLessThan(
      trashPage.indexOf('id="trash-title"'),
    );
    expect(app).toContain("api('/api/subscriptions/openai-codex'");
    expect(app).toContain("$('btn-settings').addEventListener('click'");
    expect(app).toContain("setAttribute('aria-checked'");
    expect(css).toContain('@keyframes settings-enter');
    expect(css).toContain('animation: settings-enter');
  });
});
