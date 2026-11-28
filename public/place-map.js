/**
 * A ```map block drawn as one map with every listed place pinned on it.
 *
 * The user, 2026-11-28: 「如果有偵測到地址，他就會 embedded google map pin 著，
 * 如果有多個地址就一起 pin in same map」, then 「你可以用 system prompt drive agent
 * 回覆的時候要滿足某種特別的格式，他就會把多個地址包起來」, then of Google's own
 * embed 「這個很醜，改好看一點」. piweb asks Pi (src/agent/reply-format.ts) to
 * end a reply that names physical places with
 *
 *     ```map
 *     中埔穀倉農創園區 | 嘉義縣中埔鄉頂山門36號
 *     府城市集 | 臺南市中西區民族路二段76號
 *     ```
 *
 * and this draws it: a still map in the app's own colours (OpenFreeMap's light
 * or dark map, OpenStreetMap data) with a numbered pin per place, and over its
 * foot a card per place (「重新設計這個東西」 of the list that used to hang under
 * the map): one in view, a swipe to the next, the pins following. A card opens
 * the place in Google Maps; its arrow, directions to it.
 *
 * Why not Google's embed: with no Maps API key, the only embed that pins
 * several places is a driving route (A → B → C), which covers the map with its
 * stops panel, a route line and a drive-time bubble, and its one-finger drags
 * fight the transcript's scrolling. So the places are found with OpenStreetMap's
 * Nominatim (one request a second, as its usage policy asks; every answer is
 * kept in this browser) and drawn here; Google Maps is one tap away.
 *
 * Model text only ever reaches the DOM as text nodes and URL query values.
 */

/** More than this is a list, not a map. */
export const MAX_PLACES = 10;
/** The block must hold still this long on screen before its places are looked up. */
const SETTLE_MS = 500;
/** Nominatim's usage policy: at most one request a second. */
const GEOCODE_GAP_MS = 1100;
const GEOCODE_CACHE_KEY = 'piweb.geocode.v1';
/** A place Nominatim did not know is asked again after this long. */
const MISS_TTL_MS = 7 * 24 * 3600 * 1000;

const MAP_LINE_PREFIX = /^\s*(?:[-*+•·]|\d+[.)、])\s*/;
const SEPARATOR = /\s*[|｜]\s*/;

/**
 * The places in a ```map block: one per line, `名稱 | 地址` or just one of them,
 * list markers dropped, no repeats.
 */
export function parsePlaces(code) {
  const seen = new Set();
  const places = [];
  for (const raw of String(code ?? '').split('\n')) {
    const line = raw.replace(MAP_LINE_PREFIX, '').replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const [first, ...rest] = line.split(SEPARATOR).filter(Boolean);
    if (!first) continue;
    const name = first;
    const address = rest.join(' ');
    const key = `${name}\n${address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    places.push({ name, address });
    if (places.length === MAX_PLACES) break;
  }
  return places;
}

/** What to look a place up by, best first: its name, its address, its street. */
export function placeQueries({ name, address }) {
  const queries = [name, address];
  // OpenStreetMap rarely has Taiwan's house numbers; the street still puts the
  // pin within a few hundred metres (臺南市中西區民族路二段76號 → 民族路二段).
  const street = address.replace(/(?:\d+巷)?(?:\d+弄)?\d+(?:-\d+)?(?:之\d+)?號.*$/, '').trim();
  if (street && street !== address) queries.push(street);
  return [...new Set(queries.filter(Boolean))];
}

/** The place in Google Maps (opens the app where there is one). */
export function placeSearchUrl({ name, address }) {
  const query = address ? `${name} ${address}` : name;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

// ── finding places ─────────────────────────────────────────────────────────

let cache = null;

function readCache() {
  if (cache) return cache;
  cache = {};
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(GEOCODE_CACHE_KEY) ?? '{}');
    if (saved && typeof saved === 'object') cache = saved;
  } catch {
    /* No storage (private mode): this page's answers only. */
  }
  return cache;
}

function remember(query, value) {
  readCache()[query] = value;
  try {
    globalThis.localStorage?.setItem(GEOCODE_CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* Full or blocked: kept for this page. */
  }
}

let queue = Promise.resolve();
let lastRequestAt = 0;
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/** [lat, lon] for a query, or null; one Nominatim request at a time. */
export function geocode(query) {
  const hit = readCache()[query];
  if (Array.isArray(hit)) return Promise.resolve(hit);
  if (hit && Date.now() - hit.miss < MISS_TTL_MS) return Promise.resolve(null);
  const run = queue.then(async () => {
    const again = readCache()[query];
    if (Array.isArray(again)) return again;
    await wait(Math.max(0, lastRequestAt + GEOCODE_GAP_MS - Date.now()));
    lastRequestAt = Date.now();
    const lang = globalThis.navigator?.language || 'zh-TW';
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=${encodeURIComponent(lang)}&q=${encodeURIComponent(query)}`;
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' } });
      if (!response.ok) return null; // busy or refused: not remembered, asked again next time
      const [first] = await response.json();
      const point = first ? [Number(first.lat), Number(first.lon)] : null;
      if (point && point.every(Number.isFinite)) {
        remember(query, point);
        return point;
      }
      remember(query, { miss: Date.now() });
      return null;
    } catch {
      return null; // offline: asked again next time
    }
  });
  queue = run.catch(() => null);
  return run;
}

async function locate(place) {
  for (const query of placeQueries(place)) {
    const point = await geocode(query);
    if (point) return point;
  }
  return null;
}

// ── drawing ────────────────────────────────────────────────────────────────
//
// MapLibre (vendored, loaded only when a reply has a map) draws OpenFreeMap's
// vector map in the app's light or dark colours, labels in the places' own
// language (Chinese in Taiwan, from the phone's own font). The map is drawn
// once off screen, kept as a picture and the map thrown away: a live WebGL map
// per reply would run a long transcript out of WebGL contexts and catch the
// finger that scrolls it. One map is drawn at a time.

const MAPLIBRE_DIR = '/vendor/maplibre-gl-6.17.0/';
const STYLE_URL = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/fiord',
};
const CJK_FONT = '"PingFang TC", "Noto Sans TC", "Noto Sans CJK TC", "Microsoft JhengHei", sans-serif';
/** Room round the pins: a pin's circle and its shadow stay inside the frame. */
const FIT_PADDING = { top: 44, left: 30, right: 30 };
/** Above the place cards that lie over the map's foot. */
const CARD_CLEARANCE = 26;
const DRAW_TIMEOUT_MS = 12000;

let mapLibre = null;
function loadMapLibre() {
  mapLibre ??= (async () => {
    // Lazy, like Mermaid: a variable URL, so the module graph piscord loads
    // from markdown.js stays same-directory (test/piscord-renderer-contract.test.ts).
    const url = `${MAPLIBRE_DIR}maplibre-gl.js`;
    const lib = await import(url);
    lib.setWorkerUrl(`${MAPLIBRE_DIR}maplibre-gl-worker.js`);
    lib.setWorkerCount?.(1);
    return lib;
  })().catch((error) => {
    mapLibre = null;
    throw error;
  });
  return mapLibre;
}

/** Labels in the place's own name (臺南, not "Tainan\n臺南"); road shields keep their numbers. */
export function localLabels(style) {
  for (const layer of style.layers ?? []) {
    const field = layer.layout?.['text-field'];
    if (field && JSON.stringify(field).includes('name'))
      layer.layout['text-field'] = ['coalesce', ['get', 'name'], ['get', 'name:latin']];
  }
  return style;
}

const styles = new Map();
function loadStyle(theme) {
  if (!styles.has(theme)) {
    const style = fetch(STYLE_URL[theme])
      .then((response) => {
        if (!response.ok) throw new Error(`map style ${response.status}`);
        return response.json();
      })
      .then(localLabels);
    style.catch(() => styles.delete(theme));
    styles.set(theme, style);
  }
  return styles.get(theme);
}

const themeNow = () => (globalThis.document?.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

/** Every place, one frame, as the reader sees it: [south-west, north-east] in [lon, lat]. */
function boundsOf(lonLats) {
  const lons = lonLats.map(([lon]) => lon);
  const lats = lonLats.map(([, lat]) => lat);
  return [
    [Math.min(...lons), Math.min(...lats)],
    [Math.max(...lons), Math.max(...lats)],
  ];
}

const pictures = new Map();
const MAX_PICTURES = 24;
let drawing = Promise.resolve();

/**
 * A picture of the map and where each place falls on it, in CSS px. `bottom`
 * is the map's foot under the place cards: the pins are framed above it.
 */
function picture(points, width, height, bottom, theme) {
  const ratio = Math.min(globalThis.devicePixelRatio || 1, 3);
  const key = JSON.stringify([theme, width, height, bottom, ratio, points]);
  if (pictures.has(key)) return pictures.get(key);
  const run = drawing.then(() => drawOnce(points, width, height, bottom, theme, ratio));
  drawing = run.catch(() => null);
  run.catch(() => pictures.delete(key));
  pictures.set(key, run);
  if (pictures.size > MAX_PICTURES) pictures.delete(pictures.keys().next().value);
  return run;
}

async function drawOnce(points, width, height, bottom, theme, ratio) {
  const [lib, style] = await Promise.all([loadMapLibre(), loadStyle(theme)]);
  const doc = globalThis.document;
  const host = doc.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;height:${height}px;pointer-events:none`;
  doc.body.append(host);
  const lonLats = points.map(([lat, lon]) => [lon, lat]);
  const options = {
    container: host,
    style: structuredClone(style),
    interactive: false,
    attributionControl: false,
    fadeDuration: 0,
    pixelRatio: ratio,
    localIdeographFontFamily: CJK_FONT,
    canvasContextAttributes: { preserveDrawingBuffer: true },
  };
  const padding = { ...FIT_PADDING, bottom };
  const span = boundsOf(lonLats);
  const single = span[0][0] === span[1][0] && span[0][1] === span[1][1];
  if (single) Object.assign(options, { center: lonLats[0], zoom: 14 });
  else Object.assign(options, { bounds: span, fitBoundsOptions: { padding, maxZoom: 15 } });
  let map;
  try {
    map = new lib.Map(options);
    // One place sits in the middle of the map above the cards.
    if (single) map.jumpTo({ center: lonLats[0], zoom: 14, padding: { top: 0, left: 0, right: 0, bottom } });
    await new Promise((done) => {
      const timer = setTimeout(done, DRAW_TIMEOUT_MS);
      map.once('idle', () => {
        clearTimeout(timer);
        done();
      });
    });
    const at = lonLats.map((lonLat) => map.project(lonLat));
    const blob = await new Promise((done) => map.getCanvas().toBlob(done, 'image/jpeg', 0.9));
    if (!blob) throw new Error('map picture failed');
    return { url: URL.createObjectURL(blob), at: at.map(({ x, y }) => ({ x, y })) };
  } finally {
    map?.remove();
    host.remove();
  }
}

const states = new WeakMap();

async function draw(card) {
  const state = states.get(card);
  if (!state?.located.length) return;
  const width = Math.round(state.view.clientWidth);
  const height = Math.round(state.view.clientHeight);
  if (!width || !height) return;
  const bottom = Math.round(state.cards.offsetHeight + CARD_CLEARANCE);
  const theme = themeNow();
  const want = `${theme}|${width}|${height}|${bottom}`;
  if (state.drawn === want || state.wanted === want) return;
  state.wanted = want;
  let result;
  try {
    result = await picture(state.located.map((place) => place.point), width, height, bottom, theme);
  } catch {
    if (state.wanted === want && !state.drawn) card.dataset.state = 'list';
    return;
  }
  if (state.wanted !== want || !card.isConnected) return;
  state.image.src = result.url;
  result.at.forEach(({ x, y }, i) => {
    const marker = state.pins.children[i];
    marker.style.left = `${x}px`;
    marker.style.top = `${y}px`;
  });
  state.drawn = want;
  card.dataset.state = 'ready';
}

// A Dashboard pane resizing, or the theme switching, redraws every drawn map.
let resizeObserver = null;
let themeObserver = null;
const drawn = new Set();

function watch(card) {
  drawn.add(card);
  resizeObserver ??= new ResizeObserver((entries) => {
    for (const entry of entries) {
      const owner = entry.target.closest('.place-map');
      if (!owner?.isConnected) {
        resizeObserver.unobserve(entry.target);
        drawn.delete(owner);
      } else void draw(owner);
    }
  });
  resizeObserver.observe(states.get(card).view);
  themeObserver ??= new MutationObserver(() => {
    for (const owner of [...drawn]) {
      if (!owner.isConnected) drawn.delete(owner);
      else void draw(owner);
    }
  });
  themeObserver.observe(card.ownerDocument.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * The place in front: its card is the one shown (scrolled to when `scroll`),
 * its pin stands out. A pin tap and a swipe through the cards both land here.
 */
function select(card, index, { scroll = false } = {}) {
  const state = states.get(card);
  if (!state) return;
  state.active = index;
  state.cards.querySelectorAll('.place-map-card').forEach((item, i) => {
    if (i === index) item.dataset.active = 'true';
    else delete item.dataset.active;
  });
  for (const marker of state.pins.children)
    marker.setAttribute('aria-pressed', String(Number(marker.dataset.index) === index));
  if (scroll) {
    const target = state.cards.children[index];
    state.cards.scrollTo({
      left: target.offsetLeft - state.cards.firstElementChild.offsetLeft,
      behavior: reducedMotion() ? 'auto' : 'smooth',
    });
  }
}

async function fill(card) {
  const state = states.get(card);
  card.dataset.state = 'locating';
  const points = [];
  for (const place of state.places) points.push(await locate(place));
  if (!card.isConnected) return;
  state.located = [];
  state.places.forEach((place, i) => {
    if (points[i]) state.located.push({ ...place, point: points[i], index: i });
    else state.cards.children[i].dataset.unlocated = 'true';
  });
  if (!state.located.length) {
    card.dataset.state = 'list';
    return;
  }
  const doc = card.ownerDocument;
  state.pins.replaceChildren(
    ...state.located.map((place) => {
      const marker = doc.createElement('button');
      marker.type = 'button';
      marker.className = 'place-map-marker';
      marker.dataset.index = String(place.index);
      marker.textContent = String(place.index + 1);
      marker.setAttribute('aria-label', `${place.index + 1}. ${place.name}`);
      marker.addEventListener('click', (event) => {
        event.stopPropagation();
        select(card, place.index, { scroll: true });
      });
      return marker;
    }),
  );
  select(card, state.active ?? 0);
  await draw(card);
  watch(card);
}

// A streaming reply re-renders its ```map block as lines arrive, each time as a
// new card; only a card that stays on screen is looked up, so a half-typed line
// is never sent anywhere, and a history page looks up only the maps scrolled to.
const waiting = new WeakMap();
let showObserver = null;

function whenShown(card, run) {
  if (typeof IntersectionObserver !== 'function') {
    run();
    return;
  }
  showObserver ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const pending = waiting.get(entry.target);
      if (!pending) continue;
      clearTimeout(pending.timer);
      if (!entry.target.isConnected) {
        showObserver.unobserve(entry.target);
        waiting.delete(entry.target);
        continue;
      }
      if (!entry.isIntersecting) continue;
      pending.timer = setTimeout(() => {
        if (!entry.target.isConnected) return;
        showObserver.unobserve(entry.target);
        waiting.delete(entry.target);
        pending.run();
      }, SETTLE_MS);
    }
  });
  waiting.set(card, { run, timer: 0 });
  showObserver.observe(card);
}

/** Lucide "navigation": the arrow a maps app draws for directions. */
const GO_PATH = 'M3 11l19-9-9 19-2-8-8-2z';

function goIcon(doc) {
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', GO_PATH);
  svg.append(path);
  return svg;
}

/** Directions to the place in Google Maps, from where the phone is. */
export function placeDirectionsUrl({ name, address }) {
  const query = address ? `${name} ${address}` : name;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(query)}`;
}

function externalLink(doc, className, href, label) {
  const link = doc.createElement('a');
  link.className = className;
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.setAttribute('aria-label', label);
  // It opens; transcript links otherwise copy on tap (app.js).
  link.addEventListener('click', (event) => event.stopPropagation());
  return link;
}

/** The card for a ```map block, or null when it names no place. */
export function renderPlaceMap(code, doc = document) {
  const places = parsePlaces(code);
  if (places.length === 0) return null;

  const card = doc.createElement('figure');
  card.className = 'place-map';
  card.dataset.places = String(places.length);
  card.dataset.state = 'waiting';

  const view = doc.createElement('div');
  view.className = 'place-map-view';
  view.setAttribute('role', 'img');
  view.setAttribute('aria-label', `地圖：${places.map((p, i) => `${i + 1}. ${p.name}`).join('、')}`);
  const image = doc.createElement('img');
  image.className = 'place-map-image';
  image.alt = '';
  image.draggable = false;
  const pins = doc.createElement('div');
  pins.className = 'place-map-pins';
  const credit = doc.createElement('span');
  credit.className = 'place-map-credit';
  credit.textContent = 'OpenFreeMap © OpenMapTiles © OpenStreetMap';
  view.append(image, pins, credit);

  // The places lie over the map's foot as cards, one in view at a time; a
  // swipe brings the next, and the pins follow.
  const cards = doc.createElement('div');
  cards.className = 'place-map-cards';
  cards.setAttribute('role', 'list');
  cards.setAttribute('aria-label', '地點');
  for (const [i, place] of places.entries()) {
    const item = doc.createElement('div');
    item.className = 'place-map-card';
    item.setAttribute('role', 'listitem');
    const label = `${place.name}${place.address ? `，${place.address}` : ''}`;
    const main = externalLink(doc, 'place-map-card-main', placeSearchUrl(place), `${i + 1}. ${label}，在 Google 地圖開啟`);
    const number = doc.createElement('span');
    number.className = 'place-map-num';
    number.textContent = String(i + 1);
    const text = doc.createElement('span');
    text.className = 'place-map-text';
    const name = doc.createElement('span');
    name.className = 'place-map-name';
    name.textContent = place.name;
    text.append(name);
    if (place.address) {
      const address = doc.createElement('span');
      address.className = 'place-map-address';
      address.textContent = place.address;
      text.append(address);
    }
    main.append(number, text);
    const go = externalLink(doc, 'place-map-go', placeDirectionsUrl(place), `導航到 ${place.name}`);
    go.append(goIcon(doc));
    item.append(main, go);
    cards.append(item);
  }
  // A swipe on the cards is theirs: not the transcript's drawer or Life edge.
  cards.addEventListener('touchstart', (event) => event.stopPropagation(), { passive: true });
  let frame = 0;
  cards.addEventListener(
    'scroll',
    () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (card.dataset.state === 'list') return;
        const start = cards.firstElementChild.offsetLeft;
        let nearest = 0;
        let distance = Infinity;
        [...cards.children].forEach((item, i) => {
          const d = Math.abs(item.offsetLeft - start - cards.scrollLeft);
          if (d < distance) [nearest, distance] = [i, d];
        });
        if (nearest !== states.get(card).active) select(card, nearest);
      });
    },
    { passive: true },
  );

  card.append(view, cards);
  states.set(card, { places, view, image, pins, cards, located: [], active: 0 });
  cards.firstElementChild.dataset.active = 'true';
  whenShown(card, () => void fill(card));
  return card;
}
