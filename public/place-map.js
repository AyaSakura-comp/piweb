/**
 * A ```map block drawn as one Google Map with every listed place pinned on it.
 *
 * The user, 2026-11-28: 「如果有偵測到地址，他就會 embedded google map pin 著，
 * 如果有多個地址就一起 pin in same map」, then 「你可以用 system prompt drive agent
 * 回覆的時候要滿足某種特別的格式，他就會把多個地址包起來」. piweb asks every agent
 * (src/agent/reply-format.ts) to end a reply that names physical places with
 *
 *     ```map
 *     臺南市中西區民族路二段76號
 *     中埔穀倉農創園區 嘉義縣中埔鄉
 *     ```
 *
 * and this draws it: Google's keyless embed (`maps.google.com/maps?…&output=embed`,
 * no API key) with every line pinned on one map (placeMapEmbedUrl). Below the
 * map each place is a row that opens it in Google Maps (the app on a phone).
 *
 * Model text only ever reaches the DOM as text nodes and URL query values.
 */

/** More than this is a list, not a map. */
export const MAX_PLACES = 10;
/** The block must hold still this long on screen before the map loads. */
const SETTLE_MS = 500;

const MAP_LINE_PREFIX = /^\s*(?:[-*+•·]|\d+[.)、])\s*/;

/** The places in a ```map block: one per line, list markers dropped, no repeats. */
export function parsePlaces(code) {
  const seen = new Set();
  const places = [];
  for (const raw of String(code ?? '').split('\n')) {
    // `名稱 | 地址` is one place.
    const place = raw.replace(MAP_LINE_PREFIX, '').replace(/\|/g, ' ').replace(/\s+/g, ' ').trim();
    if (!place || seen.has(place)) continue;
    seen.add(place);
    places.push(place);
    if (places.length === MAX_PLACES) break;
  }
  return places;
}

/**
 * One map, every place pinned on it. One place is a place search (a single
 * pin). Several are the stops of a route (`saddr`/`daddr` … `+to:` …): that is
 * the keyless embed that geocodes every line and frames them all — joining
 * them into one search (`q=A|B|C`) pinned one or two and left the rest out of
 * view (measured 2026-11-28). Places that can be driven between get the route
 * drawn between them; others (across a sea) just their pins.
 */
export function placeMapEmbedUrl(places) {
  const enc = encodeURIComponent;
  if (places.length === 1) return `https://maps.google.com/maps?q=${enc(places[0])}&output=embed`;
  const [first, ...rest] = places;
  return `https://maps.google.com/maps?saddr=${enc(first)}&daddr=${rest.map(enc).join('+to:')}&output=embed`;
}

/** One place in Google Maps (opens the app where there is one). */
export function placeSearchUrl(place) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`;
}

// A streaming reply re-renders its ```map block as lines arrive, each time as a
// new card; only a card that stays on screen gets a frame, so a half-typed line
// never loads a map, and a history page of maps loads only the ones scrolled to.
const pendingFrames = new WeakMap();
let frameObserver = null;

function observeFrame(card, frame, url) {
  if (typeof IntersectionObserver !== 'function') {
    frame.src = url;
    return;
  }
  frameObserver ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const pending = pendingFrames.get(entry.target);
      if (!pending) continue;
      clearTimeout(pending.timer);
      if (!entry.target.isConnected) {
        frameObserver.unobserve(entry.target);
        pendingFrames.delete(entry.target);
        continue;
      }
      if (!entry.isIntersecting) continue;
      pending.timer = setTimeout(() => {
        if (!entry.target.isConnected) return;
        frameObserver.unobserve(entry.target);
        pendingFrames.delete(entry.target);
        pending.frame.src = pending.url;
      }, SETTLE_MS);
    }
  });
  pendingFrames.set(card, { frame, url, timer: 0 });
  frameObserver.observe(card);
}

const PIN_PATH =
  'M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z M12 12.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4z';

function pinIcon(doc) {
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('place-map-pin');
  const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', PIN_PATH);
  svg.append(path);
  return svg;
}

/** The card for a ```map block, or null when it names no place. */
export function renderPlaceMap(code, doc = document) {
  const places = parsePlaces(code);
  if (places.length === 0) return null;

  const card = doc.createElement('figure');
  card.className = 'place-map';
  card.dataset.places = String(places.length);
  card.setAttribute('aria-label', `地圖：${places.length} 個地點`);

  const frameWrap = doc.createElement('div');
  frameWrap.className = 'place-map-frame';
  const frame = doc.createElement('iframe');
  frame.title = `Google 地圖：${places.join('、')}`;
  frame.loading = 'lazy';
  frame.referrerPolicy = 'no-referrer-when-downgrade';
  frame.setAttribute('allowfullscreen', '');
  // The frame starts as about:blank (its own load event); show it once the map is in.
  frame.addEventListener('load', () => {
    if (frame.getAttribute('src')) card.dataset.loaded = 'true';
  });
  frameWrap.append(frame);
  card.append(frameWrap);

  const list = doc.createElement('ul');
  list.className = 'place-map-list';
  for (const place of places) {
    const item = doc.createElement('li');
    const link = doc.createElement('a');
    link.className = 'place-map-place';
    link.href = placeSearchUrl(place);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', `在 Google 地圖開啟 ${place}`);
    const name = doc.createElement('span');
    name.className = 'place-map-name';
    name.textContent = place;
    link.append(pinIcon(doc), name);
    // A place opens; transcript links otherwise copy on tap (app.js).
    link.addEventListener('click', (event) => event.stopPropagation());
    item.append(link);
    list.append(item);
  }
  card.append(list);

  observeFrame(card, frame, placeMapEmbedUrl(places));
  return card;
}
