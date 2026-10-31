/**
 * The composers' 貼上 button (chat and Dashboard panes): what the clipboard
 * holds, read once.
 *
 * iOS shows its 貼上 bubble for every read, and the button used to read twice:
 * clipboard.read() for media, then readText() for text. A link copied with
 * Safari's share sheet (拷貝) is only a URL (text/uri-list): read() found no
 * media, readText() found no text/plain, and the box said the clipboard was
 * empty (iPad, 2026-11-01). One read now gives both; the text is text/plain,
 * else the link in text/uri-list, else the words of text/html.
 */

/** The types the button attaches as files rather than pasting as text. */
export function isMediaType(type) {
  return (
    type.startsWith('image/') ||
    type.startsWith('audio/') ||
    type.startsWith('video/') ||
    (type.startsWith('application/') && !type.includes('json') && !type.includes('xml'))
  );
}

async function typeText(item, type) {
  if (!item.types.includes(type)) return '';
  try {
    return await (await item.getType(type)).text();
  } catch {
    return '';
  }
}

/** The text of one clipboard item: its plain text, else its link, else its HTML's words. */
export async function itemText(item, parseHtml = defaultParseHtml) {
  const plain = await typeText(item, 'text/plain');
  if (plain) return plain;
  const link = (await typeText(item, 'text/uri-list'))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#'));
  if (link) return link;
  const html = await typeText(item, 'text/html');
  return html ? parseHtml(html).trim() : '';
}

function defaultParseHtml(html) {
  return new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '';
}

/**
 * `{ media: [{ blob, type }], text }` from one read, or null when this
 * browser cannot read the clipboard. Throws when it may not.
 */
export async function readClipboard(clipboard = globalThis.navigator?.clipboard) {
  if (clipboard?.read) {
    let items = null;
    try {
      items = await clipboard.read();
    } catch {
      // read() not permitted (or no such types): readText() below.
    }
    if (items) {
      const media = [];
      let text = '';
      for (const item of items) {
        const type = item.types.find(isMediaType);
        if (type) media.push({ blob: await item.getType(type), type });
        else if (!text) text = await itemText(item);
      }
      return { media, text };
    }
  }
  if (clipboard?.readText) return { media: [], text: await clipboard.readText() };
  return null;
}
