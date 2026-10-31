import { expect, test, type Page } from 'playwright/test';

// 2026-10-31 iPhone recording: right after a prompt was sent and answered,
// a tap into full-screen reading left a blank band where the composer had
// been, below the newest message, instead of the newest message riding down
// to the foot of the screen.
test.use({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 3 });

const history = Array.from({ length: 6 }, (_, i) => [
  { role: 'user', content: `Earlier question ${i + 1}?` },
  { role: 'assistant', content: `Earlier answer ${i + 1}: the run finished and every check passed, so these numbers stay.` },
]).flat();

function reply(paragraphs: number) {
  return Array.from(
    { length: paragraphs },
    (_, i) => `Paragraph ${i + 1} of the newest reply: the strip now shows the host readings in the header where there is room for them.`,
  ).join('\n\n') + '\n\nLast line of the newest reply.';
}

async function setup(page: Page) {
  const events = history.map((e, i) => ({ id: i + 1, kind: 'message', files: [], createdAt: '2026-10-31T09:00:00Z', ...e }));
  const session = { jid: 'web:fs-send', name: 'Piweb', kind: 'standard', deleted: false, busy: false, model: '', provider: '', lastReplyId: events.length };
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('piweb.mode', 'sessions');
    const host = window as any;
    class Stream extends EventTarget {
      closed = false;
      constructor(public url: string) {
        super();
        host.__stream = this;
      }
      close() {
        this.closed = true;
      }
    }
    host.EventSource = Stream;
    host.__emit = (type: string, data: unknown) => host.__stream.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
  });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/me') return route.fulfill({ json: { authed: true } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions: [session] } });
    if (path.endsWith('/events'))
      return route.fulfill({ json: { events, session, busy: false, partial: null, hasMoreOlder: false, hasMoreNewer: false } });
    if (path.endsWith('/messages')) {
      const event = { id: events.length + 1, kind: 'message', role: 'user', content: route.request().postDataJSON().text, files: [], createdAt: '2026-10-31T09:01:00Z' };
      events.push(event);
      return route.fulfill({ json: { ok: true, eventId: event.id } });
    }
    return route.fulfill({ json: { commands: [], models: [], sessions: [], items: [] } });
  });
  await page.goto('/');
  await expect(page.locator('#session-name')).toHaveText(session.name);
  await expect.poll(() => page.evaluate(() => !!(window as any).__stream)).toBe(true);
  return { events, errors };
}

/** Send a prompt from the composer and stream back a reply `paragraphs` long. */
async function sendAndAnswer(page: Page, events: any[], paragraphs: number) {
  await page.locator('#input').fill('有餘裕的情況下把這個資訊顯示在這');
  await page.locator('#btn-send').click();
  await expect.poll(() => events.length).toBe(history.length + 1);
  const prompt = events.at(-1);
  await page.evaluate((e) => (window as any).__emit('event', e), prompt);
  const answer = { id: prompt.id + 1, kind: 'message', role: 'assistant', content: reply(paragraphs), files: [], createdAt: '2026-10-31T09:01:30Z' };
  events.push(answer);
  await page.evaluate((e) => (window as any).__emit('event', e), answer);
  await expect(page.locator('#messages')).toContainText('Last line of the newest reply');
  await expect(page.locator('#messages')).not.toHaveAttribute('data-prompt-motion', /.+/);
  await page.locator('#input').blur();
}

/** How the newest message sits: blank px between its last line and the foot of what shows. */
const foot = (page: Page) =>
  page.evaluate(() => {
    const m = document.getElementById('messages')!;
    const rows = [...m.children].filter((n) => (n as HTMLElement).offsetHeight > 0);
    const last = rows.at(-1)!.getBoundingClientRect();
    const box = m.getBoundingClientRect();
    const composer = document.getElementById('composer-wrap')!.getBoundingClientRect();
    const full = document.getElementById('app')!.classList.contains('session-fullscreen');
    // What covers the bottom of the transcript: the composer, or nothing in full screen.
    const visibleBottom = Math.min(box.bottom, full ? innerHeight : composer.top);
    return {
      full,
      blank: Math.round(visibleBottom - last.bottom),
      atEnd: m.scrollHeight - m.scrollTop - m.clientHeight < 2,
      space: m.style.getPropertyValue('--prompt-turn-space') || '0',
      turn: m.dataset.promptTurn ?? '',
    };
  });

async function scrollToEnd(page: Page) {
  // A reader's own scroll (as on the phone) to the end of the reply.
  const box = (await page.locator('#messages').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 600);
  await expect.poll(async () => (await foot(page)).atEnd).toBe(true);
}

// A reply that fills the chat but not the taller full screen (the recording),
// one that fills neither (its spacer was already under it), and a long one.
for (const [name, paragraphs] of [['fits the chat, not full screen', 15], ['short', 2], ['long', 20]] as const) {
  test(`after a sent prompt is answered (${name}), full screen adds no blank under the newest message`, async ({ page }, info) => {
    const { events, errors } = await setup(page);
    await sendAndAnswer(page, events, paragraphs);
    await scrollToEnd(page);
    const before = await foot(page);
    expect(before.turn).toBe('active');
    await page.getByText('Last line of the newest reply').tap();
    await expect(page.locator('#app')).toHaveClass(/session-fullscreen/);
    await page.waitForTimeout(400);
    const after = await foot(page);
    await page.screenshot({ path: info.outputPath(`${paragraphs}-full.png`) });
    // Still at its newest message, which rode down to the foot of the screen:
    // no more blank under it than the chat had, and no spacer grown below.
    expect(after.atEnd).toBe(true);
    expect(after.blank).toBeLessThanOrEqual(before.blank + 1);
    expect(parseFloat(after.space)).toBeLessThanOrEqual(parseFloat(before.space));
    await expect(page.locator('#jump-live')).not.toHaveClass(/visible/);

    // And back: the newest message rides up with the composer, still at the end.
    await page.getByText('Last line of the newest reply').tap();
    await expect(page.locator('#app')).not.toHaveClass(/session-fullscreen/);
    await page.waitForTimeout(400);
    const back = await foot(page);
    expect(back.atEnd).toBe(true);
    expect(back.blank).toBeLessThanOrEqual(before.blank + 1);
    expect(errors).toEqual([]);
  });
}
