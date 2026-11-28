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

/**
 * What to look a place up by. Its names, best first: the name, the name
 * without its bracketed alias, the alias. Its address, best first: the street
 * (OpenStreetMap rarely has Taiwan's house numbers, villages or neighbourhoods
 * (鄰), and the street still puts the pin within a few hundred metres), the
 * street without its village, then the address as written; a line with two
 * addresses is looked up by the first (Life, 2026-11-28: 「金興玩具二廠 |
 * 嘉義縣民雄鄉興南村3鄰工業一路6之6號、工業五路3號」 found nothing, so its card
 * switched to no pin).
 */
export function placeQueries({ name, address }) {
  const bracket = /[（(]([^）)]*)[）)]/;
  const bare = name.replace(new RegExp(bracket.source, 'g'), ' ').replace(/\s+/g, ' ').trim(); // KHTOY 金興玩具旗艦館
  const alias = bracket.exec(name)?.[1]?.trim(); // 金興玩具一廠
  const first = address.split(/[、，,；;／/]|及|或/)[0].trim();
  const street = first
    .replace(/\d+鄰/g, '')
    .replace(/(?:\d+巷)?(?:\d+弄)?\d+(?:-\d+)?(?:之\d+)?號.*$/, '')
    .trim();
  const noVillage = street.replace(/([縣市][^縣市]{1,4}?[鄉鎮市區])[^鄉鎮市區\d]{1,4}[村里](?=.)/, '$1');
  const unique = (list) => [...new Set(list.filter(Boolean))];
  return { names: unique([name, bare, alias]), addresses: unique([street, noVillage, first]) };
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

// Two lookups run side by side (「那個地圖要載入好久」, 2026-11-28: two factories
// took 8.8 s, 7.7 s of it Nominatim's one-request-a-second queue, eight
// requests deep). Photon (komoot, OpenStreetMap too, no per-second limit)
// knows venues by name but not Chinese street names; Nominatim knows the
// streets. Every name goes to Photon at once while Nominatim works through the
// streets, one a second; a place Photon has found leaves Nominatim's queue.

let queue = Promise.resolve();
let lastRequestAt = 0;
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const LOOKUP_TIMEOUT_MS = 6000;

/** One lookup, kept in this browser under `key`: a point, a remembered miss, or null for "ask again". */
async function lookup(key, url, read) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) return null; // busy or refused: not remembered, asked again next time
    const point = read(await response.json());
    if (point && point.every(Number.isFinite)) {
      remember(key, point);
      return point;
    }
    remember(key, { miss: Date.now() });
    return null;
  } catch {
    return null; // offline or slow: asked again next time
  } finally {
    clearTimeout(timer);
  }
}

function cached(key) {
  const hit = readCache()[key];
  if (Array.isArray(hit)) return hit;
  if (hit && Date.now() - hit.miss < MISS_TTL_MS) return null;
  return undefined;
}

/** [lat, lon] for a query from Nominatim, or null; one request at a time, a second apart. */
export function geocode(query, skip = () => false) {
  const known = cached(query);
  if (known !== undefined) return Promise.resolve(known);
  const run = queue.then(async () => {
    const again = cached(query);
    if (again !== undefined) return again;
    if (skip()) return null; // found meanwhile by name: no request
    await wait(Math.max(0, lastRequestAt + GEOCODE_GAP_MS - Date.now()));
    if (skip()) return null;
    lastRequestAt = Date.now();
    const lang = globalThis.navigator?.language || 'zh-TW';
    return lookup(
      query,
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=${encodeURIComponent(lang)}&q=${encodeURIComponent(query)}`,
      ([first]) => (first ? [Number(first.lat), Number(first.lon)] : null),
    );
  });
  queue = run.catch(() => null);
  return run;
}

/** [lat, lon] for a name from Photon, or null; asked at once, no queue. */
export function photon(query) {
  const key = `photon:${query}`;
  const known = cached(key);
  if (known !== undefined) return Promise.resolve(known);
  return lookup(key, `https://photon.komoot.io/api/?limit=1&q=${encodeURIComponent(query)}`, (body) => {
    const [lon, lat] = body?.features?.[0]?.geometry?.coordinates ?? [];
    return lat === undefined ? null : [Number(lat), Number(lon)];
  });
}

/** The first point of `queries` (best first) that `find` knows, asked all at once. */
async function firstFound(queries, find) {
  const answers = queries.map((query) => find(query));
  for (const answer of answers) {
    const point = await answer;
    if (point) return point;
  }
  return null;
}

/** Each place's point, or null where neither lookup knows it. */
export async function locateAll(places) {
  const queries = places.map(placeQueries);
  const byName = queries.map(({ names }) => firstFound(names, photon));
  const named = places.map(() => null);
  byName.forEach((answer, i) => answer.then((point) => (named[i] = point)));
  // Nominatim: the streets, then the names Photon did not know.
  const nominatim = queries.map(async ({ names, addresses }, i) => {
    for (const query of [...addresses, ...names]) {
      if (named[i]) return null;
      const point = await geocode(query, () => Boolean(named[i]));
      if (point) return point;
    }
    return null;
  });
  // A name found by Photon wins over a street: it is the place itself.
  return Promise.all(places.map(async (_, i) => (await byName[i]) ?? (await nominatim[i])));
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
  dark: 'https://tiles.openfreemap.org/styles/dark',
};

/**
 * The map in the app's own colours (「而且地圖顏色好怪」, 2026-11-28: fiord's blue
 * land and teal labels sat oddly beside the app's neutral greys and the blurple
 * pins), yet readable at a glance (「至少道路顏色什麼的要可以區分吧？什麼都看不懂」:
 * an all-grey map hid which line was a highway, a road or a river). Two plain
 * OpenFreeMap styles recoloured layer by layer: land, buildings and labels in the
 * app's neutrals; water blue, parks green, motorways amber, main roads a step
 * brighter than side streets, as maps are read.
 */
const PALETTE = {
  dark: {
    land: '#2f3136', water: '#1d4f86', park: '#2b5c3c', residential: '#35373c',
    building: '#3e4047', buildingLine: '#4a4c54', path: '#4a4d55', road: '#62656f',
    roadMajor: '#b7a25f', roadCasing: '#1e1f22', motorway: '#f0a940', rail: '#7a7286',
    boundary: '#8f84a8', label: '#e6e8eb', labelMinor: '#b4b8bf', waterLabel: '#8fc0f0', halo: '#1e1f22',
  },
  light: {
    land: '#f4f2ed', water: '#a9cbe5', park: '#cde5c2', residential: '#eceae3',
    building: '#e1dcd2', buildingLine: '#d2ccc1', path: '#e2ddd4', road: '#ffffff',
    roadMajor: '#fff1bd', roadCasing: '#cfc9bd', motorway: '#f2b84b', rail: '#bdb7aa',
    boundary: '#a8a296', label: '#3b3935', labelMinor: '#6d6a63', waterLabel: '#3f6f98', halo: '#f9f8f4',
  },
};

/** Which palette colour a layer's paint takes, by what the layer draws. */
function toneOf(layer) {
  const id = layer.id;
  if (layer.type === 'background') return { 'background-color': 'land' };
  if (layer.type === 'symbol')
    return {
      'text-color': /water/.test(id) ? 'waterLabel' : /highway|road/.test(id) ? 'labelMinor' : 'label',
      'text-halo-color': 'halo',
    };
  if (layer.type === 'fill') {
    if (/water/.test(id)) return { 'fill-color': 'water' };
    if (/park|wood|grass/.test(id)) return { 'fill-color': 'park' };
    if (/residential/.test(id)) return { 'fill-color': 'residential' };
    if (/building/.test(id)) return { 'fill-color': 'building', 'fill-outline-color': 'buildingLine' };
    if (/aeroway/.test(id)) return { 'fill-color': 'road' };
    return { 'fill-color': 'land' };
  }
  if (layer.type === 'line') {
    if (/water/.test(id)) return { 'line-color': 'water' };
    if (/boundary/.test(id)) return { 'line-color': 'boundary' };
    if (/dash|pier/.test(id)) return { 'line-color': 'land' };
    if (/rail/.test(id)) return { 'line-color': 'rail' };
    if (/casing/.test(id)) return { 'line-color': 'roadCasing' };
    if (/motorway/.test(id)) return { 'line-color': 'motorway' };
    if (/major|primary|trunk|runway/.test(id)) return { 'line-color': 'roadMajor' };
    if (/path/.test(id)) return { 'line-color': 'path' };
    return { 'line-color': 'road' };
  }
  return {};
}

/** The style recoloured to `theme`'s palette. */
export function tone(style, theme) {
  const palette = PALETTE[theme];
  // OpenFreeMap's dark style draws no parks (OpenMapTiles' `park` layer); positron
  // does. Add it under everything else, so a park is green in both themes.
  const layers = (style.layers ??= []);
  if (style.sources?.openmaptiles && !layers.some((layer) => layer['source-layer'] === 'park')) {
    const at = layers.findIndex((layer) => layer.type === 'background') + 1;
    layers.splice(at, 0, {
      id: 'park',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'park',
      filter: ['match', ['geometry-type'], ['MultiPolygon', 'Polygon'], true, false],
      paint: { 'fill-color': palette.park },
    });
  }
  for (const layer of style.layers ?? []) {
    if (layer.type === 'symbol' && !layer.layout?.['text-field']) continue; // icons only
    const paint = (layer.paint ??= {});
    // A pattern draws over the colour: dark's woods are a `wood-pattern` its sprite
    // does not have, so they were not drawn at all.
    if (layer.type === 'fill') delete paint['fill-pattern'];
    for (const [property, colour] of Object.entries(toneOf(layer))) paint[property] = palette[colour];
    if (layer.type === 'symbol') paint['text-halo-width'] = 1.2;
  }
  return style;
}
const CJK_FONT = '"PingFang TC", "Noto Sans TC", "Noto Sans CJK TC", "Microsoft JhengHei", sans-serif';
/**
 * Room round the places: a pin stands 36px above its tip (43px for the place
 * in front), and its head stays under the credit chip at the top (20px).
 */
const FIT_PADDING = { top: 66, left: 30, right: 30 };
/**
 * How far several places may zoom in: two buildings on neighbouring streets
 * (~50 m apart) stand as two pins, not one on top of the other.
 */
const CLOSE_ZOOM = 17;
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
      .then((style) => tone(localLabels(style), theme));
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
  else Object.assign(options, { bounds: span, fitBoundsOptions: { padding, maxZoom: CLOSE_ZOOM } });
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
  showCard(state.cards, index, scroll);
  for (const pin of state.pins.children) pin.setAttribute('aria-pressed', String(Number(pin.dataset.index) === index));
  // A place with no pin says so over the map, rather than the map just not changing.
  state.lost.hidden = !state.cards.children[index]?.dataset.unlocated;
}

async function fill(card) {
  const state = states.get(card);
  card.dataset.state = 'locating';
  // The map's code and style load while the places are looked up.
  loadMapLibre().catch(() => {});
  loadStyle(themeNow()).catch(() => {});
  const points = await locateAll(state.places);
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
    ...state.located.map((place) => marker(doc, place, (i) => select(card, i, { scroll: true }))),
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

const goIcon = (doc) => svgIcon(doc, GO_PATH);

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

/**
 * The places as cards, one in view at a time over a map's foot; a swipe brings
 * the next. `onShown(i)` hears which card is in front as the strip settles.
 */
function placeCards(doc, places, onShown) {
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
        const start = cards.firstElementChild.offsetLeft;
        let nearest = 0;
        let distance = Infinity;
        [...cards.children].forEach((item, i) => {
          const d = Math.abs(item.offsetLeft - start - cards.scrollLeft);
          if (d < distance) [nearest, distance] = [i, d];
        });
        onShown(nearest);
      });
    },
    { passive: true },
  );
  return cards;
}

/** Mark card `index` as the one in front; scroll it into view when asked. */
function showCard(cards, index, scroll) {
  [...cards.children].forEach((item, i) => {
    if (i === index) item.dataset.active = 'true';
    else delete item.dataset.active;
  });
  if (!scroll) return;
  const target = cards.children[index];
  cards.scrollTo({
    left: target.offsetLeft - cards.firstElementChild.offsetLeft,
    behavior: scroll === 'instant' || reducedMotion() ? 'auto' : 'smooth',
  });
}

function marker(doc, place, onPick) {
  const pin = doc.createElement('button');
  pin.type = 'button';
  pin.className = 'place-map-marker';
  pin.dataset.index = String(place.index);
  pin.setAttribute('aria-label', `${place.index + 1}. ${place.name}`);
  // A flat 2D map pin, its tip on the place, the number in its head
  // (「標記我想要改成2D圖針加上號碼」, 2026-11-28).
  pin.append(svgIcon(doc, PIN_PATH, 'place-map-marker-shape', PIN_VIEWBOX));
  const number = doc.createElement('span');
  number.className = 'place-map-marker-number';
  number.textContent = String(place.index + 1);
  pin.append(number);
  pin.addEventListener('click', (event) => {
    event.stopPropagation();
    onPick(place.index);
  });
  return pin;
}

function svgIcon(doc, d, className, viewBox = '0 0 24 24') {
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.classList.add(className);
  const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

const EXPAND_PATH = 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7';
const CLOSE_PATH = 'M18 6 6 18M6 6l12 12';
/** A 28×36 teardrop pin: a 24px head round (14,13), the tip at (14,35). */
const PIN_VIEWBOX = '0 0 28 36';
const PIN_PATH =
  'M14 1C7.4 1 2 6.4 2 13c0 8.4 9.8 19.6 11.2 21.2a1.1 1.1 0 0 0 1.6 0C16.2 32.6 26 21.4 26 13 26 6.4 20.6 1 14 1z';

// ── the map in your fingers ────────────────────────────────────────────────
//
// 「想要手指可以自由操作地圖」 (2026-11-28). In the transcript the map stays a
// picture (a finger on it still scrolls the transcript, and no WebGL map is
// held per reply); a tap opens it full screen as a live map: one finger pans,
// two pinch, the cards and pins work as in the transcript and a card in front
// brings its place to the middle. Closed with ✕ or Escape; the live map is
// thrown away. One at a time.

let viewer = null;

function loadMapLibreCss(doc) {
  const href = `${MAPLIBRE_DIR}maplibre-gl.css`;
  let link = doc.querySelector(`link[href="${href}"]`);
  if (!link) {
    link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    doc.head.append(link);
  }
  if (link.sheet) return Promise.resolve();
  return new Promise((done) => {
    link.addEventListener('load', done, { once: true });
    link.addEventListener('error', done, { once: true });
    setTimeout(done, 3000);
  });
}

export async function openPlaceMapViewer(card) {
  const state = states.get(card);
  if (viewer || !state?.located.length) return;
  const doc = card.ownerDocument;
  const overlay = doc.createElement('div');
  overlay.className = 'place-map-viewer';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', '地圖');
  overlay.dataset.places = String(state.places.length);
  const host = doc.createElement('div');
  host.className = 'place-map-viewer-map';
  // Inline: MapLibre's own stylesheet, loaded after app.css, makes its container `position: relative`.
  host.style.cssText = 'position:absolute;inset:0';
  const close = doc.createElement('button');
  close.type = 'button';
  close.className = 'place-map-viewer-close';
  close.setAttribute('aria-label', '關閉地圖');
  close.append(svgIcon(doc, CLOSE_PATH));
  const credit = doc.createElement('span');
  credit.className = 'place-map-credit';
  credit.textContent = 'OpenFreeMap © OpenMapTiles © OpenStreetMap';
  const lost = doc.createElement('span');
  lost.className = 'place-map-lost';
  lost.textContent = '地圖上找不到這個地點';
  lost.hidden = true;
  let map = null;
  const pins = [];
  const pick = (index, scroll) => {
    showCard(cards, index, scroll);
    for (const pin of pins) pin.setAttribute('aria-pressed', String(Number(pin.dataset.index) === index));
    const place = state.located.find((p) => p.index === index);
    lost.hidden = Boolean(place);
    if (place && map) map.easeTo({ center: [place.point[1], place.point[0]], duration: reducedMotion() ? 0 : 450 });
  };
  let shown = state.active ?? 0;
  const cards = placeCards(doc, state.places, (i) => {
    if (i !== shown) pick((shown = i), false);
  });
  state.places.forEach((_, i) => {
    if (state.cards.children[i]?.dataset.unlocated) cards.children[i].dataset.unlocated = 'true';
  });
  overlay.append(host, credit, lost, cards, close);
  // The overlay's touches are the map's: not the drawer's or Life's edge swipes.
  overlay.addEventListener('touchstart', (event) => event.stopPropagation(), { passive: true });

  const back = doc.activeElement;
  const onKey = (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    teardown();
  };
  const teardown = () => {
    if (viewer !== record) return;
    viewer = null;
    doc.removeEventListener('keydown', onKey, true);
    map?.remove();
    overlay.remove();
    (back?.isConnected ? back : state.view).focus?.({ preventScroll: true });
  };
  const record = { overlay, close: teardown };
  viewer = record;
  close.addEventListener('click', (event) => {
    event.stopPropagation();
    teardown();
  });
  doc.addEventListener('keydown', onKey, true);
  doc.body.append(overlay);
  showCard(cards, shown, 'instant');
  close.focus({ preventScroll: true });

  try {
    const [lib, style] = await Promise.all([loadMapLibre(), loadStyle(themeNow()), loadMapLibreCss(doc)]);
    if (viewer !== record) return;
    const lonLats = state.located.map(({ point: [lat, lon] }) => [lon, lat]);
    const span = boundsOf(lonLats);
    const padding = { ...FIT_PADDING, top: 64, bottom: Math.round(cards.offsetHeight + 40) };
    const single = span[0][0] === span[1][0] && span[0][1] === span[1][1];
    map = new lib.Map({
      container: host,
      style: structuredClone(style),
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      fadeDuration: 0,
      localIdeographFontFamily: CJK_FONT,
      ...(single ? { center: lonLats[0], zoom: 15 } : { bounds: span, fitBoundsOptions: { padding, maxZoom: CLOSE_ZOOM } }),
    });
    map.touchZoomRotate.disableRotation();
    if (single) map.jumpTo({ center: lonLats[0], zoom: 15, padding: { top: 0, left: 0, right: 0, bottom: padding.bottom - 26 } });
    for (const place of state.located) {
      const pin = marker(doc, place, (i) => pick((shown = i), true));
      pins.push(pin);
      // MapLibre moves the wrapper; the pin keeps its own scale for the place in front.
      const wrap = doc.createElement('div');
      wrap.className = 'place-map-viewer-pin';
      wrap.append(pin);
      new lib.Marker({ element: wrap, anchor: 'bottom' }).setLngLat([place.point[1], place.point[0]]).addTo(map);
    }
    for (const pin of pins) pin.setAttribute('aria-pressed', String(Number(pin.dataset.index) === shown));
    lost.hidden = state.located.some((p) => p.index === shown);
    overlay.dataset.state = 'ready';
  } catch {
    teardown();
  }
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
  view.setAttribute('role', 'button');
  view.tabIndex = 0;
  view.setAttribute('aria-label', `打開地圖：${places.map((p, i) => `${i + 1}. ${p.name}`).join('、')}`);
  const image = doc.createElement('img');
  image.className = 'place-map-image';
  image.alt = '';
  image.draggable = false;
  const pins = doc.createElement('div');
  pins.className = 'place-map-pins';
  const credit = doc.createElement('span');
  credit.className = 'place-map-credit';
  credit.textContent = 'OpenFreeMap © OpenMapTiles © OpenStreetMap';
  const expand = doc.createElement('span');
  expand.className = 'place-map-expand';
  expand.append(svgIcon(doc, EXPAND_PATH));
  const lost = doc.createElement('span');
  lost.className = 'place-map-lost';
  lost.textContent = '地圖上找不到這個地點';
  lost.hidden = true;
  view.append(image, pins, credit, expand, lost);
  // A tap opens the map full screen, where fingers move it.
  const open = (event) => {
    if (card.dataset.state !== 'ready') return;
    event.preventDefault();
    event.stopPropagation();
    void openPlaceMapViewer(card);
  };
  view.addEventListener('click', open);
  view.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') open(event);
  });

  const cards = placeCards(doc, places, (i) => {
    if (card.dataset.state !== 'list' && i !== states.get(card).active) select(card, i);
  });

  card.append(view, cards);
  states.set(card, { places, view, image, pins, cards, lost, located: [], active: 0 });
  cards.firstElementChild.dataset.active = 'true';
  whenShown(card, () => void fill(card));
  return card;
}
