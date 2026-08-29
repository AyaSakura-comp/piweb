/**
 * Markdown + LaTeX rendering for message bodies.
 *
 * Everything is built as DOM nodes; model output is never assigned to innerHTML.
 * KaTeX and highlight.js are the only exceptions: both generate their own
 * escaped markup from source text (with KaTeX configured as `trust: false`), so
 * no author HTML can pass through.
 *
 * Order matters. Fenced code is lifted out first (nothing inside it should be
 * interpreted), then math (so `$a_1$` is not eaten by the italic rule and
 * `\[...\]` survives), and only then markdown. Both are re-inserted at the end
 * via placeholders.
 */

// U+0000 cannot appear in the text we render, so it is a safe sentinel.
const PLACEHOLDER = '\u0000';
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const SAFE_LINK = /^(https?:|mailto:)/i;

function makePlaceholder(kind, index) {
  return `${PLACEHOLDER}${kind}${index}${PLACEHOLDER}`;
}

/** Pull fenced code blocks out so no other rule touches their contents. */
function extractCode(text, store) {
  return text.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    store.push({ lang: lang || '', code: code.replace(/\n$/, '') });
    return makePlaceholder('C', store.length - 1);
  });
}

/**
 * Pull math out. Display forms first so `$$…$$` is not consumed by the inline
 * `$…$` rule. Inline `$…$` requires a non-space right after the opening `$` so
 * ordinary prose about money ("$5 and $10") is left alone.
 */
function extractMath(text, store) {
  const push = (tex, display) => {
    store.push({ tex, display });
    return makePlaceholder('M', store.length - 1);
  };

  return text
    .replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex) => push(tex.trim(), true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_m, tex) => push(tex.trim(), true))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_m, tex) => push(tex.trim(), false))
    .replace(/\$(?!\s)([^$\n]+?)(?<!\s)\$/g, (_m, tex) => push(tex.trim(), false));
}

function renderMath(item) {
  const node = document.createElement(item.display ? 'div' : 'span');
  if (item.display) node.className = 'math-display';
  if (window.katex) {
    try {
      // KaTeX builds this markup itself from the TeX source; trust:false keeps
      // \htmlClass and friends from injecting anything.
      window.katex.render(item.tex, node, {
        displayMode: item.display,
        throwOnError: false,
        trust: false,
        strict: false,
      });
      return node;
    } catch {
      // fall through to plain text
    }
  }
  node.textContent = item.display ? `$$${item.tex}$$` : `$${item.tex}$`;
  return node;
}

export const JAPANESE_MERMAID_PALETTE = [
  '#64715a', // 苔色 — moss
  '#4f6268', // 藍鼠 — blue grey
  '#765a4d', // 赤錆 — red rust
  '#81755b', // 利休茶 — tea brown
  '#58645f', // 千歳緑 — pine grey
  '#746574', // 鳩羽紫 — muted violet
  '#5f746f', // 青磁 — celadon
  '#806957', // 胡桃 — walnut
  '#70745a', // 鶯 — olive
  '#566775', // 藍鉄 — indigo iron
  '#806763', // 小豆 — adzuki
  '#696b5e', // 鈍色 — warm slate
];

function numberedThemeColors(prefix, colors, start = 0) {
  return Object.fromEntries(colors.map((color, index) => [`${prefix}${index + start}`, color]));
}

export function getMermaidDiagramLabel(code) {
  const diagramType = code
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('%%'))
    ?.split(/\s+/)[0]
    ?.toLowerCase();

  const labels = {
    gantt: 'Gantt',
    flowchart: 'Flowchart',
    graph: 'Flowchart',
    sequencediagram: 'Sequence',
    classdiagram: 'Class',
    statediagram: 'State',
    'statediagram-v2': 'State',
    erdiagram: 'ER Diagram',
    journey: 'Journey',
    pie: 'Pie Chart',
    mindmap: 'Mindmap',
    timeline: 'Timeline',
    gitgraph: 'Git Graph',
    quadrantchart: 'Quadrant Chart',
    sankey: 'Sankey',
  };
  return labels[diagramType] ?? 'Mermaid';
}

export function getMermaidConfig() {
  return {
    startOnLoad: false,
    theme: 'dark',
    themeVariables: {
      darkMode: true,
      background: '#1c1c1a',
      primaryColor: JAPANESE_MERMAID_PALETTE[0],
      primaryTextColor: '#f4f0e6',
      primaryBorderColor: '#9a9488',
      secondaryColor: JAPANESE_MERMAID_PALETTE[1],
      secondaryTextColor: '#f4f0e6',
      secondaryBorderColor: '#89989c',
      tertiaryColor: JAPANESE_MERMAID_PALETTE[2],
      tertiaryTextColor: '#f4f0e6',
      tertiaryBorderColor: '#a98979',
      textColor: '#e6e0d5',
      lineColor: '#9b958a',
      arrowheadColor: '#9b958a',
      defaultLinkColor: '#9b958a',
      titleColor: '#f4f0e6',
      nodeBkg: JAPANESE_MERMAID_PALETTE[0],
      mainBkg: JAPANESE_MERMAID_PALETTE[0],
      nodeBorder: '#9a9488',
      nodeTextColor: '#f4f0e6',
      edgeLabelBackground: '#252622',
      clusterBkg: '#252622',
      clusterBorder: '#6f7168',
      noteBkgColor: JAPANESE_MERMAID_PALETTE[3],
      noteBorderColor: '#aaa083',
      noteTextColor: '#f4f0e6',
      actorBkg: JAPANESE_MERMAID_PALETTE[1],
      actorBorder: '#89989c',
      actorTextColor: '#f4f0e6',
      actorLineColor: '#777a74',
      signalColor: '#ded8ca',
      signalTextColor: '#e6e0d5',
      labelBoxBkgColor: '#252622',
      labelBoxBorderColor: '#6f7168',
      labelTextColor: '#e6e0d5',
      activationBkgColor: JAPANESE_MERMAID_PALETTE[6],
      activationBorderColor: '#91a39e',
      sectionBkgColor: '#252723',
      sectionBkgColor2: '#202522',
      taskBkgColor: '#64715a',
      taskBorderColor: '#a5aa96',
      taskTextColor: '#f4f0e6',
      taskTextOutsideColor: '#ded8ca',
      gridColor: '#5c5b55',
      doneTaskBkgColor: '#4f6268',
      doneTaskBorderColor: '#8c9ba0',
      critBkgColor: '#765a4d',
      critBorderColor: '#b58a75',
      todayLineColor: '#b58a75',
      stateBkg: JAPANESE_MERMAID_PALETTE[0],
      stateLabelColor: '#f4f0e6',
      transitionColor: '#9b958a',
      transitionLabelColor: '#e6e0d5',
      compositeBackground: '#252622',
      compositeBorder: '#6f7168',
      classText: '#f4f0e6',
      ...numberedThemeColors('fillType', JAPANESE_MERMAID_PALETTE.slice(0, 8)),
      ...numberedThemeColors('cScale', JAPANESE_MERMAID_PALETTE),
      scaleLabelColor: '#f4f0e6',
      ...numberedThemeColors('pie', JAPANESE_MERMAID_PALETTE, 1),
      pieTitleTextColor: '#f4f0e6',
      pieSectionTextColor: '#f4f0e6',
      pieLegendTextColor: '#e6e0d5',
      pieStrokeColor: '#1c1c1a',
      pieOuterStrokeColor: '#6f7168',
      quadrant1Fill: JAPANESE_MERMAID_PALETTE[0],
      quadrant2Fill: JAPANESE_MERMAID_PALETTE[1],
      quadrant3Fill: JAPANESE_MERMAID_PALETTE[2],
      quadrant4Fill: JAPANESE_MERMAID_PALETTE[3],
      quadrant1TextFill: '#f4f0e6',
      quadrant2TextFill: '#f4f0e6',
      quadrant3TextFill: '#f4f0e6',
      quadrant4TextFill: '#f4f0e6',
      quadrantPointFill: '#ded8ca',
      quadrantPointTextFill: '#f4f0e6',
      ...numberedThemeColors('git', JAPANESE_MERMAID_PALETTE.slice(0, 8)),
      branchLabelColor: '#f4f0e6',
      tagLabelColor: '#f4f0e6',
      tagLabelBackground: JAPANESE_MERMAID_PALETTE[2],
      tagLabelBorder: '#a98979',
      commitLabelColor: '#e6e0d5',
      commitLabelBackground: '#252622',
      fontFamily:
        "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
      fontSize: '15px',
      nodePadding: '14px',
    },
    flowchart: {
      useMaxWidth: false,
      htmlLabels: true,
      curve: 'basis',
      padding: 16,
      nodeSpacing: 45,
      rankSpacing: 45,
    },
    sequence: {
      useMaxWidth: false,
    },
    gantt: {
      useMaxWidth: false,
      useWidth: 1000,
      leftPadding: 220,
      rightPadding: 48,
      barHeight: 24,
      barGap: 8,
      fontSize: 13,
      sectionFontSize: 12,
    },
    securityLevel: 'loose',
    suppressErrorRendering: true,
  };
}

let mermaidInitDone = false;
let mermaidLoadingPromise = null;
export function ensureMermaid() {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (window.mermaid) {
    if (!mermaidInitDone) {
      window.mermaid.initialize(getMermaidConfig());
      mermaidInitDone = true;
    }
    return Promise.resolve(window.mermaid);
  }
  if (mermaidLoadingPromise) return mermaidLoadingPromise;
  mermaidLoadingPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/mermaid/mermaid.min.js';
    s.onload = () => {
      try {
        if (window.mermaid) {
          window.mermaid.initialize(getMermaidConfig());
          mermaidInitDone = true;
        }
        resolve(window.mermaid);
      } catch (err) {
        console.error('Failed to init mermaid', err);
        reject(err);
      }
    };
    s.onerror = (err) => {
      mermaidLoadingPromise = null;
      reject(err);
    };
    document.head.append(s);
  });
  return mermaidLoadingPromise;
}

function attachMermaidGesture(scrollEl, chartEl) {
  let scale = 1;
  let startScale = 1;
  let initialDist = 0;
  let isPinching = false;
  let isPanning = false;
  let posX = 0;
  let posY = 0;
  let originClientX = 0;
  let originClientY = 0;
  let panStartX = 0;
  let panStartY = 0;
  let contentFocalX = 0;
  let contentFocalY = 0;
  let lastTap = 0;
  let lastTapX = 0;
  let lastTapY = 0;

  const updateTransform = (animate = false) => {
    chartEl.style.transition = animate ? 'transform 0.2s cubic-bezier(0.2, 0, 0.2, 1)' : 'none';
    chartEl.style.transformOrigin = '0 0';
    if (scale === 1 && posX === 0 && posY === 0) {
      chartEl.style.transform = '';
    } else {
      chartEl.style.transform = `translate(${posX}px, ${posY}px) scale(${scale})`;
    }
  };

  scrollEl.addEventListener(
    'touchstart',
    (e) => {
      // 1. Two-finger pinch gesture: record focal point between the 2 fingers
      if (e.touches.length === 2) {
        if (e.cancelable) e.preventDefault();
        isPinching = true;
        isPanning = false;
        const t1 = e.touches[0];
        const t2 = e.touches[1];
        const chartRect = chartEl.getBoundingClientRect();
        initialDist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
        startScale = scale;
        const focalClientX = (t1.clientX + t2.clientX) / 2;
        const focalClientY = (t1.clientY + t2.clientY) / 2;
        originClientX = chartRect.left - posX;
        originClientY = chartRect.top - posY;
        contentFocalX = (focalClientX - chartRect.left) / startScale;
        contentFocalY = (focalClientY - chartRect.top) / startScale;
        return;
      }

      // 2. Single finger touch
      if (e.touches.length === 1) {
        const touch = e.touches[0];
        const now = Date.now();

        // Double-tap to toggle zoom centered around the tap point
        if (now - lastTap < 300 && Math.hypot(touch.clientX - lastTapX, touch.clientY - lastTapY) < 35) {
          if (e.cancelable) e.preventDefault();
          lastTap = 0;
          if (Math.abs(scale - 1) > 0.15) {
            scale = 1;
            posX = 0;
            posY = 0;
          } else {
            const chartRect = chartEl.getBoundingClientRect();
            const originClientX = chartRect.left - posX;
            const originClientY = chartRect.top - posY;
            const tapContentX = (touch.clientX - chartRect.left) / scale;
            const tapContentY = (touch.clientY - chartRect.top) / scale;
            scale = 1.8;
            posX = touch.clientX - originClientX - tapContentX * scale;
            posY = touch.clientY - originClientY - tapContentY * scale;
          }
          updateTransform(true);
          return;
        }
        lastTap = now;
        lastTapX = touch.clientX;
        lastTapY = touch.clientY;

        if (Math.abs(scale - 1) > 0.05) {
          isPanning = true;
          panStartX = touch.clientX - posX;
          panStartY = touch.clientY - posY;
        }
      }
    },
    { passive: false }
  );

  scrollEl.addEventListener(
    'touchmove',
    (e) => {
      // Two-finger pinch: scale centered on the moving focal point between fingers
      if (isPinching && e.touches.length === 2) {
        if (e.cancelable) e.preventDefault();
        const t1 = e.touches[0];
        const t2 = e.touches[1];
        const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
        const ratio = dist / (initialDist || 1);
        scale = Math.min(5, Math.max(0.2, startScale * ratio));

        const newFocalClientX = (t1.clientX + t2.clientX) / 2;
        const newFocalClientY = (t1.clientY + t2.clientY) / 2;
        posX = newFocalClientX - originClientX - contentFocalX * scale;
        posY = newFocalClientY - originClientY - contentFocalY * scale;
        updateTransform(false);
        return;
      }

      // Single finger panning when scaled
      if (isPanning && e.touches.length === 1) {
        if (e.cancelable) e.preventDefault();
        const touch = e.touches[0];
        posX = touch.clientX - panStartX;
        posY = touch.clientY - panStartY;
        updateTransform(false);
      }
    },
    { passive: false }
  );

  const endGesture = () => {
    isPinching = false;
    isPanning = false;
    if (scale < 0.2) {
      scale = 0.2;
      updateTransform(true);
    } else if (scale > 5) {
      scale = 5;
      updateTransform(true);
    }
  };

  scrollEl.addEventListener('touchend', endGesture);
  scrollEl.addEventListener('touchcancel', endGesture);
}

function openMermaidModal(svgHtml) {
  let modal = document.getElementById('mermaid-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'mermaid-modal';
    modal.className = 'mermaid-modal';
    modal.hidden = true;
    modal.innerHTML = `
      <div class="mm-modal-backdrop"></div>
      <div class="mm-modal-content">
        <header class="mm-modal-head">
          <span class="mm-modal-title">Mermaid Diagram</span>
          <div class="mm-modal-tools">
            <button type="button" class="icon-btn mm-zoom-in" title="Zoom In" aria-label="Zoom in">
              <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>
            </button>
            <button type="button" class="icon-btn mm-zoom-out" title="Zoom Out" aria-label="Zoom out">
              <svg viewBox="0 0 24 24"><path d="M5 12h14" /></svg>
            </button>
            <button type="button" class="icon-btn mm-zoom-reset" title="Reset Zoom" aria-label="Reset zoom">
              <svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>
            </button>
            <button type="button" class="icon-btn mm-modal-close" title="Close" aria-label="Close">
              <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </div>
        </header>
        <div class="mm-modal-body">
          <div class="mm-modal-stage"></div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    let scale = 1;
    let x = 0;
    let y = 0;
    let originClientX = 0;
    let originClientY = 0;
    let isPinching = false;
    let isPanning = false;
    let initialDist = 0;
    let startScale = 1;
    let contentFocalX = 0;
    let contentFocalY = 0;
    let panStartX = 0;
    let panStartY = 0;
    let lastTap = 0;
    let lastTapX = 0;
    let lastTapY = 0;

    const stage = modal.querySelector('.mm-modal-stage');
    const body = modal.querySelector('.mm-modal-body');

    const updateTransform = (animate = false) => {
      stage.style.transition = animate ? 'transform 0.22s cubic-bezier(0.2, 0, 0.2, 1)' : 'none';
      stage.style.transformOrigin = '0 0';
      stage.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    };

    const zoomByRatio = (factor) => {
      const stageRect = stage.getBoundingClientRect();
      const bodyRect = body.getBoundingClientRect();
      const cx = bodyRect.left + bodyRect.width / 2;
      const cy = bodyRect.top + bodyRect.height / 2;
      const origX = stageRect.left - x;
      const origY = stageRect.top - y;
      const contentX = (cx - stageRect.left) / scale;
      const contentY = (cy - stageRect.top) / scale;
      scale = Math.min(6, Math.max(0.2, scale * factor));
      x = cx - origX - contentX * scale;
      y = cy - origY - contentY * scale;
      updateTransform(true);
    };

    modal.querySelector('.mm-zoom-in').addEventListener('click', () => zoomByRatio(1.3));
    modal.querySelector('.mm-zoom-out').addEventListener('click', () => zoomByRatio(1 / 1.3));
    modal.querySelector('.mm-zoom-reset').addEventListener('click', () => {
      scale = 1;
      x = 0;
      y = 0;
      updateTransform(true);
    });
    const closeModal = () => {
      modal.hidden = true;
      document.body.style.overflow = '';
      scale = 1;
      x = 0;
      y = 0;
      updateTransform(false);
    };
    modal.querySelector('.mm-modal-close').addEventListener('click', closeModal);
    modal.querySelector('.mm-modal-backdrop').addEventListener('click', closeModal);

    // Two-finger pinch centered on the midpoint between fingers
    body.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length === 2) {
          if (e.cancelable) e.preventDefault();
          isPinching = true;
          isPanning = false;
          const t1 = e.touches[0];
          const t2 = e.touches[1];
          const stageRect = stage.getBoundingClientRect();
          initialDist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
          startScale = scale;
          const focalClientX = (t1.clientX + t2.clientX) / 2;
          const focalClientY = (t1.clientY + t2.clientY) / 2;
          originClientX = stageRect.left - x;
          originClientY = stageRect.top - y;
          contentFocalX = (focalClientX - stageRect.left) / startScale;
          contentFocalY = (focalClientY - stageRect.top) / startScale;
          return;
        }

        if (e.touches.length === 1) {
          const touch = e.touches[0];
          const now = Date.now();

          // Double tap zoom toggle centered around the tapped spot
          if (now - lastTap < 300 && Math.hypot(touch.clientX - lastTapX, touch.clientY - lastTapY) < 30) {
            if (e.cancelable) e.preventDefault();
            lastTap = 0;
            if (scale > 1.2) {
              scale = 1;
              x = 0;
              y = 0;
            } else {
              const stageRect = stage.getBoundingClientRect();
              const origX = stageRect.left - x;
              const origY = stageRect.top - y;
              const tapContentX = (touch.clientX - stageRect.left) / scale;
              const tapContentY = (touch.clientY - stageRect.top) / scale;
              scale = 2.2;
              x = touch.clientX - origX - tapContentX * scale;
              y = touch.clientY - origY - tapContentY * scale;
            }
            updateTransform(true);
            return;
          }
          lastTap = now;
          lastTapX = touch.clientX;
          lastTapY = touch.clientY;

          isPanning = true;
          panStartX = touch.clientX - x;
          panStartY = touch.clientY - y;
        }
      },
      { passive: false }
    );

    body.addEventListener(
      'touchmove',
      (e) => {
        if (isPinching && e.touches.length === 2) {
          if (e.cancelable) e.preventDefault();
          const t1 = e.touches[0];
          const t2 = e.touches[1];
          const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
          const ratio = dist / (initialDist || 1);
          scale = Math.min(6, Math.max(0.2, startScale * ratio));

          const newFocalClientX = (t1.clientX + t2.clientX) / 2;
          const newFocalClientY = (t1.clientY + t2.clientY) / 2;
          x = newFocalClientX - originClientX - contentFocalX * scale;
          y = newFocalClientY - originClientY - contentFocalY * scale;
          updateTransform(false);
          return;
        }

        if (isPanning && e.touches.length === 1) {
          if (e.cancelable) e.preventDefault();
          const touch = e.touches[0];
          x = touch.clientX - panStartX;
          y = touch.clientY - panStartY;
          updateTransform(false);
        }
      },
      { passive: false }
    );

    const endTouch = () => {
      isPinching = false;
      isPanning = false;
      if (scale < 0.2) {
        scale = 0.2;
        updateTransform(true);
      } else if (scale > 6) {
        scale = 6;
        updateTransform(true);
      }
    };

    body.addEventListener('touchend', endTouch);
    body.addEventListener('touchcancel', endTouch);
  }

  const stage = modal.querySelector('.mm-modal-stage');
  stage.innerHTML = svgHtml;
  const svgEl = stage.querySelector('svg');
  if (svgEl) {
    svgEl.style.maxWidth = 'none';
    svgEl.removeAttribute('width');
    svgEl.removeAttribute('height');
  }
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
}

export function highlightCode(code, language = '', highlighter = globalThis.window?.hljs) {
  if (!highlighter) return undefined;
  try {
    if (language && highlighter.getLanguage?.(language)) {
      return highlighter.highlight(code, { language, ignoreIllegals: true });
    }
    return highlighter.highlightAuto(code);
  } catch {
    return undefined;
  }
}

export function applySyntaxHighlighting(element, code, language = '', highlighter = globalThis.window?.hljs) {
  const highlighted = highlightCode(code, language, highlighter);
  if (!highlighted) return false;

  // highlight.js escapes the source before returning this token-only markup;
  // no model-authored HTML is passed through.
  element.innerHTML = highlighted.value;
  element.classList.add('hljs');
  const detected = highlighted.language || language;
  if (detected && /^[\w+-]+$/.test(detected)) {
    element.classList.add(`language-${detected}`);
    element.dataset.language = detected;
  }
  return true;
}

function renderCode(item) {
  if (item.lang === 'mermaid') {
    const wrap = document.createElement('div');
    wrap.className = 'mermaid-wrap';

    const header = document.createElement('div');
    header.className = 'mermaid-header';

    const title = document.createElement('span');
    title.className = 'mermaid-title';
    title.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3zM10 6.5h4M17.5 10v4M6.5 10v4M10 17.5h4"/></svg> ${getMermaidDiagramLabel(item.code)}`;
    header.append(title);

    const actions = document.createElement('div');
    actions.className = 'mermaid-actions';

    const btnZoom = document.createElement('button');
    btnZoom.type = 'button';
    btnZoom.className = 'mermaid-btn';
    btnZoom.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5M11 8v6M8 11h6"/></svg> 放大檢視`;

    const btnCopy = document.createElement('button');
    btnCopy.type = 'button';
    btnCopy.className = 'mermaid-btn';
    btnCopy.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> 複製代碼`;
    btnCopy.addEventListener('click', () => {
      navigator.clipboard.writeText(item.code);
      btnCopy.textContent = '已複製 ✓';
      setTimeout(() => {
        btnCopy.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> 複製代碼`;
      }, 1500);
    });

    actions.append(btnZoom);
    actions.append(btnCopy);
    header.append(actions);
    wrap.append(header);

    const scrollWrap = document.createElement('div');
    scrollWrap.className = 'mermaid-scroll';

    const chart = document.createElement('div');
    chart.className = 'mermaid-chart';

    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.className = 'lang-mermaid';
    code.textContent = item.code;
    pre.append(code);
    scrollWrap.append(pre);
    wrap.append(scrollWrap);

    let renderedSvg = '';
    btnZoom.addEventListener('click', () => {
      if (renderedSvg) openMermaidModal(renderedSvg);
    });

    const id = `mm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    ensureMermaid()
      .then((mermaid) => {
        if (!mermaid) return;
        return mermaid.render(id, item.code);
      })
      .then((res) => {
        if (!res) return;
        const { svg, bindFunctions } = res;
        renderedSvg = svg;
        chart.innerHTML = svg;
        const svgEl = chart.querySelector('svg');
        if (svgEl) {
          svgEl.style.maxWidth = 'none';
          svgEl.style.display = 'block';
          const vb = svgEl.getAttribute('viewBox');
          if (vb) {
            const [, , w] = vb.split(' ').map(Number);
            if (w) {
              const targetWidth = Math.max(w, 360);
              svgEl.style.width = `${targetWidth}px`;
            }
          }
        }
        if (bindFunctions) {
          try {
            bindFunctions(chart);
          } catch {}
        }
        pre.remove();
        scrollWrap.append(chart);
        attachMermaidGesture(scrollWrap, chart);
      })
      .catch(() => {
        const errEl = document.getElementById(id);
        if (errEl) errEl.remove();
        const dError = document.getElementById('d' + id);
        if (dError) dError.remove();
      });

    return wrap;
  }

  const pre = document.createElement('pre');
  const code = document.createElement('code');
  if (!applySyntaxHighlighting(code, item.code, item.lang)) {
    if (item.lang) code.classList.add(`language-${item.lang}`);
    code.textContent = item.code;
  }
  pre.append(code);
  return pre;
}

/** Split a string on placeholders, yielding text and resolved nodes. */
function splitPlaceholders(text, code, math) {
  const parts = [];
  const re = new RegExp(`${reEscape(PLACEHOLDER)}([CM])(\\d+)${reEscape(PLACEHOLDER)}`, 'g');
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    const index = Number(m[2]);
    parts.push({ node: m[1] === 'C' ? renderCode(code[index]) : renderMath(math[index]) });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/** Inline markdown: code, bold, italic, strikethrough, links. */
function renderInline(container, text, code, math) {
  for (const part of splitPlaceholders(text, code, math)) {
    if (part.node) {
      container.append(part.node);
      continue;
    }
    renderInlineText(container, part.text);
  }
}

const INLINE_RE = new RegExp(
  [
    '(`+)([\\s\\S]+?)\\1', // `code`
    '\\*\\*([\\s\\S]+?)\\*\\*', // **bold**
    '__([\\s\\S]+?)__', // __bold__
    '~~([\\s\\S]+?)~~', // ~~strike~~
    '\\*([^*\\n]+?)\\*', // *italic*
    '(?<![\\w\\\\])_([^_\\n]+?)_(?!\\w)', // _italic_ (not inside identifiers)
    '\\[([^\\]]+)\\]\\(([^)\\s]+)\\)', // [text](url)
    '(https?://[^\\s<>()]+)', // bare url
  ].join('|'),
  'g',
);

function renderInlineText(container, text) {
  let last = 0;
  let m;
  // Styled spans recurse into this parser. Each call needs its own cursor;
  // sharing INLINE_RE.lastIndex would restart the outer call forever.
  const inlineRe = new RegExp(INLINE_RE.source, INLINE_RE.flags);

  while ((m = inlineRe.exec(text)) !== null) {
    if (m.index > last) container.append(document.createTextNode(text.slice(last, m.index)));
    const [, , codeText, bold1, bold2, strike, ital1, ital2, linkText, linkUrl, bareUrl] = m;

    if (codeText !== undefined) container.append(tag('code', codeText));
    else if (bold1 !== undefined) container.append(formattedTag('strong', bold1));
    else if (bold2 !== undefined) container.append(formattedTag('strong', bold2));
    else if (strike !== undefined) container.append(formattedTag('del', strike));
    else if (ital1 !== undefined) container.append(formattedTag('em', ital1));
    else if (ital2 !== undefined) container.append(formattedTag('em', ital2));
    else if (linkText !== undefined) container.append(link(linkText, linkUrl));
    else if (bareUrl !== undefined) container.append(link(bareUrl, bareUrl));

    last = m.index + m[0].length;
  }

  if (last < text.length) container.append(document.createTextNode(text.slice(last)));
}

function tag(name, text) {
  const node = document.createElement(name);
  node.textContent = text;
  return node;
}

/** Styled spans may contain links or other inline markup; code spans stay literal. */
function formattedTag(name, text) {
  const node = document.createElement(name);
  renderInlineText(node, text);
  return node;
}

/** Only http(s)/mailto become anchors; anything else stays inert text. */
function link(text, url) {
  if (!SAFE_LINK.test(url)) return document.createTextNode(text);
  const a = document.createElement('a');
  a.href = url;
  a.textContent = text;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

const BULLET_RE = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED_RE = /^(\s*)(\d+)[.)]\s+(.*)$/;
const HR_RE = /^\s*([-*_])\1{2,}\s*$/;
const TABLE_SEP_RE = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;

/** A table = a row containing `|` immediately followed by a |---|---| separator. */
function isTableStart(lines, i) {
  return (
    lines[i].includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])
  );
}

/**
 * Block-level parse. Deliberately small: headings, rules, quotes, lists,
 * tables and paragraphs — the shapes agent output actually uses.
 */
export function renderRich(container, raw) {
  const code = [];
  const math = [];
  // Normalise line endings FIRST. `.` does not match `\r` in JavaScript (it is a
  // line terminator), so a CRLF heading fails /^(#{1,6})\s+(.*)$/ while still
  // matching the paragraph loop's guard /^(#{1,6})\s+/ — no branch consumes the
  // line, `i` never advances, and the tab freezes. agy's tool output is CRLF,
  // which is how this surfaced; every `$`-anchored rule here has the same flaw.
  const source = String(raw ?? '').replace(/\r\n?/g, '\n');
  const text = extractMath(extractCode(source, code), math);
  renderBlocks(container, text, code, math);
}

/**
 * Block parser over text whose code/math have already been lifted out.
 *
 * Nested contexts (blockquotes) recurse HERE, not through renderRich: the text
 * they carry already holds placeholders, and re-running extraction on it would
 * find nothing and leave the placeholders as literal garbage on screen.
 */
function renderBlocks(container, text, code, math) {
  const lines = text.split('\n');

  let i = 0;
  const inline = (el, s) => renderInline(el, s, code, math);

  while (i < lines.length) {
    const line = lines[i];

    // blank
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // a lone placeholder line (fenced code / display math) is its own block
    const solo = line.trim().match(new RegExp(`^${reEscape(PLACEHOLDER)}([CM])(\\d+)${reEscape(PLACEHOLDER)}$`));
    if (solo) {
      const index = Number(solo[2]);
      container.append(solo[1] === 'C' ? renderCode(code[index]) : renderMath(math[index]));
      i += 1;
      continue;
    }

    // horizontal rule
    if (HR_RE.test(line)) {
      container.append(document.createElement('hr'));
      i += 1;
      continue;
    }

    // heading
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const h = document.createElement(`h${heading[1].length}`);
      inline(h, heading[2].trim());
      container.append(h);
      i += 1;
      continue;
    }

    // blockquote — collect consecutive `>` lines and recurse
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      const quote = document.createElement('blockquote');
      renderBlocks(quote, buf.join('\n'), code, math);
      container.append(quote);
      continue;
    }

    // table: a header row followed by a |---|---| separator
    if (isTableStart(lines, i)) {
      const rows = [];
      while (i < lines.length && lines[i].includes('|')) {
        rows.push(lines[i]);
        i += 1;
      }
      container.append(buildTable(rows, inline));
      continue;
    }

    // lists
    if (BULLET_RE.test(line) || ORDERED_RE.test(line)) {
      const consumed = buildList(lines, i, container, inline);
      i = consumed;
      continue;
    }

    // paragraph — consecutive non-blank, non-block lines
    const buf = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*>/.test(lines[i]) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !BULLET_RE.test(lines[i]) &&
      !ORDERED_RE.test(lines[i]) &&
      !HR_RE.test(lines[i]) &&
      // A table often follows a label line with no blank line between them
      // ("**材料：**" then "| a | b |"). Without this the paragraph swallows the
      // whole table and it renders as raw pipes.
      !isTableStart(lines, i)
    ) {
      buf.push(lines[i]);
      i += 1;
    }
    // Progress guarantee: if no rule above consumed this line and the paragraph
    // scan rejected it too, emit it as-is rather than looping forever. Reaching
    // here means a guard and its matching rule disagree — a bug worth fixing at
    // the source, but never one worth hanging the tab over.
    if (buf.length === 0) {
      buf.push(lines[i]);
      i += 1;
    }

    const p = document.createElement('p');
    // A single newline inside a paragraph is a visible line break here: agent
    // output uses them meaningfully, unlike strict markdown.
    buf.forEach((l, n) => {
      if (n > 0) p.append(document.createElement('br'));
      inline(p, l);
    });
    container.append(p);
  }
}

function buildTable(rows, inline) {
  const cells = (row) =>
    row
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => c.trim());

  const table = document.createElement('table');
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const c of cells(rows[0])) {
    const th = document.createElement('th');
    inline(th, c);
    headRow.append(th);
  }
  head.append(headRow);
  table.append(head);

  const body = document.createElement('tbody');
  for (const row of rows.slice(2)) {
    const tr = document.createElement('tr');
    for (const c of cells(row)) {
      const td = document.createElement('td');
      inline(td, c);
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(body);

  // Wide tables scroll inside their own box; the page never scrolls sideways.
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  wrap.append(table);
  return wrap;
}

/** Build (possibly nested) lists by indentation. Returns the next line index. */
function buildList(lines, start, container, inline) {
  const first = lines[start].match(BULLET_RE) || lines[start].match(ORDERED_RE);
  const baseIndent = first[1].length;
  const ordered = ORDERED_RE.test(lines[start]);
  const list = document.createElement(ordered ? 'ol' : 'ul');
  if (ordered && first[2]) {
    const startNum = parseInt(first[2], 10);
    if (Number.isFinite(startNum) && startNum !== 1) {
      list.start = startNum;
    }
  }

  let i = start;
  while (i < lines.length) {
    const line = lines[i];

    // Blank line lookahead: a loose list can have empty lines between items
    if (!line.trim()) {
      let next = i + 1;
      while (next < lines.length && !lines[next].trim()) next++;
      if (next >= lines.length) {
        i = next;
        break;
      }
      // If the next non-blank line starts another block element, the list ends
      if (
        /^\s*>/.test(lines[next]) ||
        /^(#{1,6})\s+/.test(lines[next]) ||
        HR_RE.test(lines[next]) ||
        isTableStart(lines, next)
      ) {
        break;
      }
      const nextBullet = lines[next].match(BULLET_RE);
      const nextNumbered = lines[next].match(ORDERED_RE);
      const nextMatch = nextBullet || nextNumbered;
      if (nextMatch) {
        const nextIndent = nextMatch[1].length;
        const nextOrdered = Boolean(nextNumbered);
        // Dedented: belongs to outer list level
        if (nextIndent < baseIndent) break;
        // Same level but changed list type (e.g. ol to ul): list ends
        if (nextIndent === baseIndent && nextOrdered !== ordered) break;
        // Valid continuation of the same list or deeper level
        i = next;
        continue;
      } else {
        // Non-list line after blank line: if indented > baseIndent, continuation
        const nextIndent = (lines[next].match(/^(\s*)/)?.[1] || '').length;
        if (nextIndent > baseIndent && list.lastElementChild) {
          i = next;
          continue;
        }
        break;
      }
    }

    const bullet = lines[i].match(BULLET_RE);
    const numbered = lines[i].match(ORDERED_RE);
    const match = bullet || numbered;

    if (match) {
      const indent = match[1].length;
      if (indent < baseIndent) break;

      if (indent > baseIndent) {
        // deeper level: recurse into the last item
        const host = list.lastElementChild ?? list.appendChild(document.createElement('li'));
        i = buildList(lines, i, host, inline);
        continue;
      }

      const itemOrdered = Boolean(numbered);
      if (itemOrdered !== ordered) {
        break;
      }

      const li = document.createElement('li');
      inline(li, bullet ? match[2] : match[3]);
      list.append(li);
      i += 1;
      continue;
    }

    // Not a bullet/number: check if it starts a different block
    if (
      /^\s*>/.test(line) ||
      /^(#{1,6})\s+/.test(line) ||
      HR_RE.test(line) ||
      isTableStart(lines, i)
    ) {
      break;
    }

    // Indented continuation line under the current item
    const indent = (line.match(/^(\s*)/)?.[1] || '').length;
    if (indent > baseIndent && list.lastElementChild) {
      list.lastElementChild.append(document.createElement('br'));
      inline(list.lastElementChild, line.trim());
      i += 1;
      continue;
    }

    break;
  }

  container.append(list);
  return i;
}
