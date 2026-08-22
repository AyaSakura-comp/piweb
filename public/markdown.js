/**
 * Markdown + LaTeX rendering for message bodies.
 *
 * Everything is built as DOM nodes; model output is never assigned to innerHTML.
 * The single exception is KaTeX's own output, which KaTeX generates from the
 * math source with `trust: false`, so no author HTML can pass through.
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

let mermaidInitDone = false;
function ensureMermaid() {
  if (mermaidInitDone || !window.mermaid) return;
  try {
    window.mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      themeVariables: {
        darkMode: true,
        background: '#232428',
        primaryColor: '#5865f2',
        primaryTextColor: '#f2f3f5',
        primaryBorderColor: '#3f4147',
        lineColor: '#949ba4',
        secondaryColor: '#2b2d31',
        tertiaryColor: '#1e1f22',
        fontFamily:
          "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
        fontSize: '14px',
      },
      flowchart: {
        useMaxWidth: false,
        htmlLabels: true,
        curve: 'basis',
      },
      sequence: {
        useMaxWidth: false,
      },
      gantt: {
        useMaxWidth: false,
      },
      securityLevel: 'loose',
      suppressErrorRendering: true,
    });
    mermaidInitDone = true;
  } catch (err) {
    console.error('Failed to init mermaid', err);
  }
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
    const stage = modal.querySelector('.mm-modal-stage');
    const updateTransform = () => {
      stage.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    };

    modal.querySelector('.mm-zoom-in').addEventListener('click', () => {
      scale = Math.min(4, scale * 1.25);
      updateTransform();
    });
    modal.querySelector('.mm-zoom-out').addEventListener('click', () => {
      scale = Math.max(0.25, scale / 1.25);
      updateTransform();
    });
    modal.querySelector('.mm-zoom-reset').addEventListener('click', () => {
      scale = 1;
      x = 0;
      y = 0;
      updateTransform();
    });
    const closeModal = () => {
      modal.hidden = true;
      document.body.style.overflow = '';
      scale = 1;
      x = 0;
      y = 0;
      updateTransform();
    };
    modal.querySelector('.mm-modal-close').addEventListener('click', closeModal);
    modal.querySelector('.mm-modal-backdrop').addEventListener('click', closeModal);
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

function renderCode(item) {
  if (item.lang === 'mermaid' && window.mermaid) {
    ensureMermaid();
    const wrap = document.createElement('div');
    wrap.className = 'mermaid-wrap';

    const header = document.createElement('div');
    header.className = 'mermaid-header';

    const title = document.createElement('span');
    title.className = 'mermaid-title';
    title.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3zM10 6.5h4M17.5 10v4M6.5 10v4M10 17.5h4"/></svg> Flowchart`;
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
    window.mermaid
      .render(id, item.code)
      .then(({ svg, bindFunctions }) => {
        renderedSvg = svg;
        chart.innerHTML = svg;
        const svgEl = chart.querySelector('svg');
        if (svgEl) {
          svgEl.style.maxWidth = 'none';
          const vb = svgEl.getAttribute('viewBox');
          if (vb) {
            const [, , w] = vb.split(' ').map(Number);
            if (w && w > 320) {
              svgEl.style.width = `${w}px`;
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
  if (item.lang) code.className = `lang-${item.lang}`;
  code.textContent = item.code;
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
  INLINE_RE.lastIndex = 0;

  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) container.append(document.createTextNode(text.slice(last, m.index)));
    const [, , codeText, bold1, bold2, strike, ital1, ital2, linkText, linkUrl, bareUrl] = m;

    if (codeText !== undefined) container.append(tag('code', codeText));
    else if (bold1 !== undefined) container.append(tag('strong', bold1));
    else if (bold2 !== undefined) container.append(tag('strong', bold2));
    else if (strike !== undefined) container.append(tag('del', strike));
    else if (ital1 !== undefined) container.append(tag('em', ital1));
    else if (ital2 !== undefined) container.append(tag('em', ital2));
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

  let i = start;
  while (i < lines.length) {
    const bullet = lines[i].match(BULLET_RE);
    const numbered = lines[i].match(ORDERED_RE);
    const match = bullet || numbered;
    if (!match) break;

    const indent = match[1].length;
    if (indent < baseIndent) break;

    if (indent > baseIndent) {
      // deeper level: recurse into the last item
      const host = list.lastElementChild ?? list.appendChild(document.createElement('li'));
      i = buildList(lines, i, host, inline);
      continue;
    }

    const li = document.createElement('li');
    inline(li, bullet ? match[2] : match[3]);
    list.append(li);
    i += 1;
  }

  container.append(list);
  return i;
}
