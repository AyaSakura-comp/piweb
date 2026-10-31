// /claude-usage, /gpt-usage and /agy-usage reports, drawn as a card instead
// of the worker's monospace text. The worker keeps writing that text (Discord
// shows it as is, and it is what history holds), so the page reads it back
// here. Anything it does not recognise returns null and the row keeps the
// plain text: a format change upstream must never hide a reading.

export const USAGE_ROLES = new Set(['claude-usage', 'gpt-usage', 'pi gpt-usage', 'agy-usage']);

/** At or above this share used, the bar and its number take the danger colour. */
export const HIGH_USE = 90;

const pad = (n) => String(n).padStart(2, '0');

// Node's zh-TW dates put a thin space (U+2009) between date and time.
const spaced = (text) => text.replace(/\s+/g, ' ');

/** "2026/11/6 01:33:20" → "11/06 01:33"; anything else as it came. */
function shortStamp(text) {
  const m = /^\d{4}\/(\d{1,2})\/(\d{1,2})\s(\d{1,2}):(\d{2})/.exec(text);
  return m ? `${pad(m[1])}/${pad(m[2])} ${pad(m[3])}:${m[4]}` : spaced(text);
}

/** "111 小時 7 分" / "42 分鐘" → the "還有 4 天 15 小時" phrasing the other reports use. */
function untilPhrase(text) {
  const t = text.trim();
  if (!t || t === '—') return '';
  if (t.startsWith('還有') || t === '已重置') return t;
  const hm = /^(\d+) 小時 (\d+) 分$/.exec(t);
  const m = /^(\d+) 分(?:鐘)?$/.exec(t);
  const minutes = hm ? Number(hm[1]) * 60 + Number(hm[2]) : m ? Number(m[1]) : null;
  if (minutes == null) return `還有 ${t}`;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days) return `還有 ${days} 天 ${hours} 小時`;
  if (hours) return `還有 ${hours} 小時 ${minutes % 60} 分`;
  return `還有 ${minutes % 60} 分`;
}

const percent = (text) => (text === '—' ? null : Number(text));

function row(label, used, left, extra = {}) {
  return {
    label,
    sub: '',
    used,
    left: left ?? (used == null ? null : Math.max(0, Math.round((100 - used) * 10) / 10)),
    reset: '',
    until: '',
    disabled: '',
    ...extra,
  };
}

/** Strip the ```text fence the command result is wrapped in. */
function unfence(content) {
  const m = /^\s*```[\w-]*\n([\s\S]*?)\n?```\s*$/.exec(content ?? '');
  return (m ? m[1] : content ?? '').split('\n');
}

function parseClaude(lines) {
  const head = /^🤖 Claude Code 用量（(.+)）$/.exec(lines[0] ?? '');
  if (!head) return null;
  const report = { title: 'Claude Code 用量', caption: head[1], sections: [{ name: '', rows: [] }], notes: [], footer: '' };
  const rows = report.sections[0].rows;
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    let m;
    if ((m = /^(?:🟢|🟠|🔴) (.+?) {2,}已用 ([\d.]+)% {2}剩 ([\d.]+)%(?: {2}[█░]+)?$/u.exec(line))) {
      rows.push(row(m[1], Number(m[2]), Number(m[3])));
    } else if ((m = /^ {3}重置 (.+)$/.exec(line)) && rows.length) {
      const at = /^(.+?)（(.+)）$/.exec(m[1]);
      Object.assign(rows.at(-1), at ? { reset: spaced(at[1]), until: at[2] } : { reset: m[1] === '未提供' ? '' : spaced(m[1]) });
    } else if (/^查詢 /.test(line)) {
      report.footer = spaced(line);
    } else if (/^服務未提供可用的額度資料/.test(line)) {
      report.notes.push({ text: line, tone: '' });
    } else return null;
  }
  return report;
}

function parseGpt(lines) {
  const head = /^🤖 ChatGPT\/Codex 用量 {2}\(方案: (.+)\)$/.exec(lines[0] ?? '');
  if (!head) return null;
  const plan = head[1] === '?' ? '' : head[1];
  const report = {
    title: 'ChatGPT/Codex 用量',
    caption: plan ? `方案 ${plan}` : '',
    sections: [{ name: '', rows: [] }],
    notes: [],
    footer: '',
  };
  const rows = report.sections[0].rows;
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    let m;
    if ((m = /^(?:🟠|🔵) (\S+) \((.+)\)$/u.exec(line))) {
      rows.push(row(m[1], null, null, { sub: m[2].replace(' 滾動', '滾動') }));
    } else if ((m = /^ {3}已用 (\S+)% {2}剩 (\S+)%/.exec(line)) && rows.length) {
      const used = percent(m[1]);
      const left = percent(m[2]);
      if (Number.isNaN(used) || Number.isNaN(left)) return null;
      Object.assign(rows.at(-1), { used, left });
    } else if ((m = /^ {3}重置: (.+?)(?: \(台灣時間\))? \(還有 (.+)\)$/.exec(line)) && rows.length) {
      Object.assign(rows.at(-1), { reset: m[1] === '—' ? '' : shortStamp(m[1]), until: untilPhrase(m[2]) });
    } else if ((m = /^💳 (.+)$/u.exec(line))) {
      report.notes.push({ text: m[1], tone: '' });
    } else if ((m = /^⚠️ (.+)$/u.exec(line))) {
      report.notes.push({ text: m[1], tone: 'warn' });
    } else return null;
  }
  return rows.length ? report : null;
}

function parseAgy(lines) {
  if (lines[0] !== '🤖 Antigravity (agy) 用量') return null;
  const report = { title: 'Antigravity 用量', caption: '', sections: [], notes: [], footer: '' };
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const section = report.sections.at(-1);
    let m;
    // agy's own "5小時窗" spelled the way the Claude report spells it.
    const label = (text) => text.trim().replace(/^5小時窗$/, '5 小時窗');
    if ((m = /^▸ (.+)$/.exec(line))) {
      report.sections.push({ name: m[1], rows: [] });
    } else if (section && (m = /^ {2}(?:🟢|🟠|🔴) (.+?) +已用 (-?\d+)% [█░]+$/u.exec(line))) {
      section.rows.push(row(label(m[1]), Math.max(0, Number(m[2]))));
    } else if (section && (m = /^ {2}⚪ (.+?) +(已停用.*)$/u.exec(line))) {
      section.rows.push(row(label(m[1]), null, null, { disabled: m[2] }));
    } else if (section?.rows.length && (m = /^ {5}(\d{2}\/\d{2}\s\d{2}:\d{2})(?: (.*))?$/.exec(line))) {
      Object.assign(section.rows.at(-1), { reset: spaced(m[1]), until: untilPhrase(m[2] ?? '') });
    } else return null;
  }
  return report.sections.some((s) => s.rows.length) ? report : null;
}

/** The report as data, or null when this is not a usage report we can read whole. */
export function parseUsageReport(role, content) {
  if (!USAGE_ROLES.has(role)) return null;
  const lines = unfence(content);
  return parseClaude(lines) ?? parseGpt(lines) ?? parseAgy(lines);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function renderRow(r) {
  const item = el('div', 'usage-row');
  const head = el('div', 'usage-row-head');
  const label = el('span', 'usage-label', r.label);
  if (r.sub) label.append(el('span', 'usage-sub', r.sub));
  head.append(label);
  if (r.disabled) {
    item.classList.add('is-disabled');
    item.append(head, el('div', 'usage-meta', r.disabled));
    return item;
  }
  const value = el('span', 'usage-value');
  value.append(el('span', 'usage-value-label', '已用'), el('strong', '', r.used == null ? '—' : `${r.used}%`));
  head.append(value);

  const high = r.used != null && r.used >= HIGH_USE;
  item.dataset.level = high ? 'high' : 'normal';
  const track = el('div', 'usage-track');
  track.setAttribute('role', 'meter');
  track.setAttribute('aria-label', `${r.label}已用`);
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  if (r.used != null) {
    track.setAttribute('aria-valuenow', String(Math.min(100, r.used)));
    track.setAttribute('aria-valuetext', `已用 ${r.used}%，剩 ${r.left}%`);
  } else track.setAttribute('aria-valuetext', '未提供');
  const fill = el('div', 'usage-fill');
  fill.style.width = `${Math.min(100, Math.max(0, r.used ?? 0))}%`;
  track.append(fill);

  const meta = el('div', 'usage-meta');
  meta.append(el('span', 'usage-left', r.left == null ? '剩 —' : `剩 ${r.left}%`));
  const when = r.reset ? [`${r.reset} 重置`, r.until].filter(Boolean).join(' · ') : '重置時間未提供';
  meta.append(el('span', 'usage-reset', when));
  item.append(head, track, meta);
  return item;
}

/** The card's body; the caller keeps its notice shell (summary, fold). */
export function renderUsageReport(report) {
  const root = el('div', 'usage-report');
  if (report.caption) root.append(el('p', 'usage-caption', report.caption));
  for (const section of report.sections) {
    const group = el('section', 'usage-group');
    if (section.name) group.append(el('h4', 'usage-group-name', section.name));
    for (const r of section.rows) group.append(renderRow(r));
    root.append(group);
  }
  for (const note of report.notes) {
    const p = el('p', `usage-note${note.tone ? ` is-${note.tone}` : ''}`, note.text);
    root.append(p);
  }
  if (report.footer) root.append(el('p', 'usage-footer', report.footer));
  return root;
}
