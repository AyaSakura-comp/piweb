import React, {
  Children,
  isValidElement,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { CachedMarkdown, Streamdown, preprocessLaTeX } from '@lobehub/streamdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkBreaks from 'remark-breaks';
import rehypeKatex from 'rehype-katex';
// External leaf helpers. No old Markdown block parsing runs in this island.
import { bindInlineYouTube, getYouTubeVideoId, renderCode } from './markdown.js';
import { remarkOutboxMedia } from './outbox-media.js';
import { continuesSource, tokenizeOutbox } from '../public/outbox-stream.js';
import {
  documentDefinitions,
  normalizeDisplayMath,
  protectCurrencyDollars,
  remarkDocumentDefinitions,
} from './document-context.js';

const roots = new WeakMap();
const liveRoots = new Set();
let removalObserver;
const normalize = (value) =>
  String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .trimStart();
const remarkPlugins = [remarkGfm, remarkMath, remarkOutboxMedia, remarkBreaks];
const rehypePlugins = [[rehypeKatex, { throwOnError: false, strict: 'ignore', trust: false }]];
const remend = { htmlTags: false };

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return isValidElement(node) ? textOf(node.props.children) : '';
}

const Pre = memo(function Pre({ children, className = '' }) {
  const child = Children.toArray(children).find(isValidElement);
  const lang = /language-([\w+-]+)/.exec(child?.props.className ?? '')?.[1] ?? '';
  const code = textOf(children).replace(/\n$/, '');
  const holder = useRef(null);
  useEffect(() => {
    // Only expensive diagram/highlight preparation is debounced. Reveal cadence
    // and incomplete-tail repair remain entirely upstream-owned.
    const timer = setTimeout(() => {
      if (holder.current) holder.current.replaceChildren(renderCode({ lang, code }));
    }, 180);
    return () => clearTimeout(timer);
  }, [code, lang]);
  useLayoutEffect(() => {
    const pre = document.createElement('pre');
    const node = document.createElement('code');
    node.textContent = code;
    pre.append(node);
    holder.current.replaceChildren(pre);
  }, [code, lang]);
  return (
    <div className={`lobe-code ${className}`.trim()}>
      <div ref={holder} />
    </div>
  );
});

function Table({ children, node: _node, ...props }) {
  return (
    <div className="table-wrap">
      <table {...props}>{children}</table>
    </div>
  );
}
function Image({ src, alt, node: _node, ...props }) {
  if (!src) return null;
  if (props['data-piweb-media'] === 'video' || /\.(?:mp4|webm|mov)(?:[?#]|$)/i.test(src))
    return (
      <span className="msg-inline-media">
        <video {...props} src={src} controls playsInline preload="metadata" />
      </span>
    );
  return (
    <span className="msg-inline-media">
      <img {...props} src={src} alt={alt || 'image'} className="msg-inline-img" loading="lazy" />
    </span>
  );
}
function Link({ href, children, node: _node, className = '', ...props }) {
  const anchor = useRef(null);
  const videoId = getYouTubeVideoId(href);
  useLayoutEffect(() => {
    if (anchor.current && videoId) return bindInlineYouTube(anchor.current, videoId);
  }, [href, videoId]);
  if (!href) return <span>{children}</span>;
  return (
    <a
      {...props}
      ref={anchor}
      className={`${className} ${videoId ? 'youtube-inline-link' : ''}`.trim()}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  );
}
const components = { pre: Pre, table: Table, img: Image, a: Link };
const options = { components, remarkPlugins, rehypePlugins, skipHtml: true };

const preprocessReply = (source) => preprocessLaTeX(protectCurrencyDollars(source));
const preprocessDocument = (source) => normalizeDisplayMath(preprocessReply(source));

function Reply({ source, media, animate, complete }) {
  const definitions = useMemo(() => documentDefinitions(preprocessReply(source)), [source]);
  // Keyed by content so an unchanged table keeps the plugin list stable.
  const mediaKey = JSON.stringify(media);
  const contextualPlugins = useMemo(
    () => [
      ...remarkPlugins.map((plugin) =>
        plugin === remarkOutboxMedia
          ? [remarkOutboxMedia, { media: JSON.parse(mediaKey) }]
          : plugin,
      ),
      [remarkDocumentDefinitions, { definitions }],
    ],
    [definitions, mediaKey],
  );
  if (!animate)
    return (
      <CachedMarkdown {...options} remarkPlugins={contextualPlugins}>
        {preprocessReply(source)}
      </CachedMarkdown>
    );
  // Explicit requested settings: balanced smoothing, character reveal. Keep the
  // native 180ms fade; EOF does not toggle this branch or remount Streamdown.
  return (
    <Streamdown
      {...options}
      content={source}
      remarkPlugins={contextualPlugins}
      granularity="char"
      smoothing="balanced"
      preprocess={preprocessDocument}
      latexGuard={!complete}
      remend={remend}
    />
  );
}

function dispose(record) {
  if (record.disposed) return;
  record.disposed = true;
  record.resize?.disconnect();
  record.motion?.removeEventListener('change', record.onMotion);
  record.target.removeEventListener('animationend', record.onAnimationEnd);
  record.target.removeEventListener('animationcancel', record.onAnimationEnd);
  liveRoots.delete(record);
  record.root.unmount();
  record.target.classList.remove('lobe-rich');
  roots.delete(record.target);
  if (!liveRoots.size) {
    removalObserver?.disconnect();
    removalObserver = null;
  }
}

function watchRemoval(record) {
  liveRoots.add(record);
  if (removalObserver) return;
  removalObserver = new MutationObserver(() => {
    // A compatible EOF moves the same body synchronously. Only an actually
    // disconnected live island is disposed, never a temporary move.
    for (const item of liveRoots) {
      if (item.target.isConnected) {
        item.connected = true;
        gateControls(item);
      } else if (item.connected) dispose(item);
    }
  });
  removalObserver.observe(document.body, { childList: true, subtree: true });
}

function recordFor(target, live) {
  let record = roots.get(target);
  if (record) return record;
  target.classList.add('lobe-rich');
  record = {
    target,
    source: '',
    live,
    key: 0,
    disposed: false,
    connected: target.isConnected,
    root: createRoot(target),
  };
  roots.set(target, record);
  record.scrollRoot = target.closest('#messages');
  record.motion = matchMedia('(prefers-reduced-motion: reduce)');
  record.onMotion = () => paint(record);
  if (live) {
    record.motion.addEventListener('change', record.onMotion);
    record.onAnimationEnd = () => gateControls(record);
    target.addEventListener('animationend', record.onAnimationEnd);
    target.addEventListener('animationcancel', record.onAnimationEnd);
    watchRemoval(record);
    record.resize = new ResizeObserver(() => {
      if (!record.disposed && target.isConnected) {
        // Preserve pre-growth tail intent only while the reader stayed at the
        // last owned offset. Late image/diagram readiness cannot reuse intent
        // captured before a reader scroll or a different navigation.
        const unchanged =
          record.scrollRoot && Math.abs(record.scrollRoot.scrollTop - record.lastTop) < 1;
        record.afterAppend?.(unchanged ? record.follow : record.beforeAppend?.());
        record.lastTop = record.scrollRoot?.scrollTop;
      }
    });
    record.resize.observe(target);
  }
  return record;
}

// Interaction guard only. Never override, reschedule or extend library fades.
function gateControls(record) {
  if (record.gateQueued || record.disposed) return;
  record.gateQueued = true;
  queueMicrotask(() => {
    record.gateQueued = false;
    if (record.disposed || !record.target.isConnected) return;
    const fading = record.target
      .getAnimations({ subtree: true })
      .filter(
        (animation) =>
          animation.animationName === 'streamdown-fade-in' &&
          animation.playState !== 'finished' &&
          animation.playState !== 'idle',
      )
      .map((animation) => animation.effect?.target)
      .filter((node) => node instanceof Element);
    for (const span of record.target.querySelectorAll('.stream-char')) {
      span.inert = fading.some((node) => node === span || node.contains(span));
      if (span.inert) span.dataset.lobeFading = 'true';
      else delete span.dataset.lobeFading;
    }
    for (const control of record.target.querySelectorAll(
      'a, button, input, img, video, audio, iframe',
    )) {
      control.inert = fading.some((node) => node.contains(control) || control.contains(node));
    }
  });
}

function paint(record) {
  if (record.disposed) return;
  record.follow = record.beforeAppend?.();
  flushSync(() =>
    record.root.render(
      <Reply
        key={record.key}
        source={record.source}
        media={record.media}
        complete={record.complete}
        animate={record.live && !record.motion.matches}
      />,
    ),
  );
  if (record.live) gateControls(record);
  record.afterAppend?.(record.follow);
  record.lastTop = record.scrollRoot?.scrollTop;
}

export function canReuseLobehubRich(target, text) {
  const record = target && roots.get(target);
  return !!record && !record.disposed && continuesSource(normalize(text), record.source);
}

export function updateLobehubRich(
  target,
  text,
  { complete = false, beforeAppend, afterAppend } = {},
) {
  const { source, media } = tokenizeOutbox(normalize(text), complete);
  const record = recordFor(target, true);
  if (!continuesSource(source, record.source)) record.key++;
  record.source = source;
  record.media = media;
  record.complete = complete;
  record.beforeAppend = beforeAppend;
  record.afterAppend = afterAppend;
  paint(record);
  return Promise.resolve();
}

export function renderLobehubStatic(target, text) {
  const record = recordFor(target, false);
  record.source = normalize(text);
  record.media = [];
  paint(record);
}
