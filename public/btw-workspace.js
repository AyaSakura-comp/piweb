// One visible composer, two explicitly owned drafts. The Web bridge is fail-closed:
// a side prompt is never allowed to fall through to the main message endpoint.
export function createBtwWorkspace({ api, getSession, notify, buildMessage }) {
  const byId = (id) => document.getElementById(id);
  const textarea = byId('input');
  const main = byId('messages');
  const side = byId('btw-messages');
  const card = byId('btw-card');
  const back = byId('btw-back');
  const item = byId('mi-btw');
  const attach = byId('btn-attach');
  const paste = byId('btn-paste');
  const send = byId('btn-send');
  let target = 'main';
  let owner = null;
  let generation = null;
  let request = 0;
  let mainDraft = '';
  let sideDraft = '';
  let mainScroll = 0;
  let sideScroll = 0;
  let sending = false;
  // A side answer started by an earlier page load / session selection that is
  // still running on the worker (reported by the snapshot's `pending`).
  let remotePending = false;
  let pendingPoll = null;
  const sideBusy = () => sending || remotePending;
  let opening = false;
  let clearing = false;
  let runEpoch = 0;
  const contextLabel = document.createElement('div');
  contextLabel.id = 'btw-context-label';
  contextLabel.className = 'btw-context-label';
  contextLabel.setAttribute('role', 'status');
  contextLabel.setAttribute('aria-live', 'polite');
  contextLabel.textContent = 'Main agent';
  main.before(contextLabel);
  // The ownership card sits at the top, right under the header, instead of
  // between the transcript and the composer.
  main.before(card);
  const clear = Object.assign(document.createElement('button'), {
    id: 'btw-clear',
    type: 'button',
    className: 'icon-btn',
    title: '清除 BTW',
    innerHTML:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>',
  });
  clear.setAttribute('aria-label', '清除 BTW 訊息');
  card.append(clear);
  // Main view while a side answer is pending: a quiet link on the typing line.
  const pendingRow = document.createElement('div');
  pendingRow.className = 'btw-pending-row';
  pendingRow.hidden = true;
  const pendingLink = Object.assign(document.createElement('button'), {
    type: 'button',
    textContent: 'BTW 回答中 ›',
  });
  pendingLink.setAttribute('aria-label', '查看 BTW（回答中）');
  pendingRow.append(pendingLink);
  const mainBlocked = () =>
    Boolean(byId('upload-progress') && !byId('upload-progress').hidden) || textarea.disabled;
  function renderControls() {
    send.disabled = target === 'btw' ? sideBusy() || clearing : mainBlocked();
    clear.disabled = sideBusy() || clearing || opening;
    pendingRow.hidden = !(target === 'main' && sideBusy() && owner);
    contextLabel.textContent =
      target === 'main'
        ? `Main agent${sideBusy() ? ' · BTW 回答中' : ''}`
        : `BTW${sideBusy() ? ' · 回答中' : clearing ? ' · 清除中' : ''}`;
    byId('app').classList.toggle('btw-swipe-ready', Boolean(owner));
  }
  const status = card.querySelector('span');
  const typing = byId('typing');

  // The card replaces the main typing row while BTW is selected, so it carries
  // both states: the side answer in flight, and the main agent still working.
  if (typing) typing.after(pendingRow);
  function renderStatus() {
    const mainBusy = Boolean(typing && !typing.hidden);
    if (sideBusy()) status.textContent = 'BTW 回答中…';
    else if (clearing) status.textContent = '清除中…';
    else if (mainBusy) status.textContent = '主對話執行中 · 不會加入主對話';
    else status.textContent = '不會加入主對話';
    status.classList.toggle('btw-live', sideBusy() || mainBusy);
    renderControls();
  }
  if (typing)
    new MutationObserver(renderStatus).observe(typing, {
      attributes: true,
      attributeFilter: ['hidden'],
    });

  function pendingNodes(text) {
    const question = buildMessage({ role: 'user', content: text });
    question.classList.add('btw-pending');
    const waiting = document.createElement('div');
    waiting.className = 'btw-waiting';
    waiting.setAttribute('role', 'status');
    waiting.innerHTML =
      '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
    waiting.append(Object.assign(document.createElement('span'), { textContent: 'BTW 回答中…' }));
    return [question, waiting];
  }

  // Render a snapshot. Questions still being answered on the worker show as
  // pending, and the snapshot is re-read until they finish.
  function renderThread(thread) {
    side.replaceChildren();
    for (const message of thread?.messages || []) {
      // The structured Web bridge must not hand untrusted HTML to the renderer.
      if (message.role !== 'user' && message.role !== 'assistant') continue;
      if (typeof message.content !== 'string') continue;
      side.append(buildMessage(message));
    }
    const pending = sending
      ? []
      : (thread?.pending || []).filter((text) => typeof text === 'string' && text);
    for (const text of pending) side.append(...pendingNodes(text));
    remotePending = pending.length > 0;
    clearTimeout(pendingPoll);
    pendingPoll = remotePending ? setTimeout(pollPending, 3000) : null;
  }
  async function pollPending() {
    pendingPoll = null;
    const session = getSession();
    if (!remotePending || !session || session.key !== owner || sending || clearing) return;
    const epoch = runEpoch;
    try {
      const data = await api(`/api/sessions/${encodeURIComponent(session.jid)}/btw`);
      if (epoch !== runEpoch || key() !== session.key || owner !== session.key || sending) return;
      if (!data?.available || data.generation !== generation) return;
      const atBottom = side.scrollHeight - side.scrollTop - side.clientHeight < 40;
      renderThread(data.thread);
      if (atBottom) side.scrollTop = side.scrollHeight;
    } catch {
      if (epoch === runEpoch && remotePending) pendingPoll = setTimeout(pollPending, 5000);
    }
    renderStatus();
  }

  const key = () => getSession()?.key || null;
  const snapshot = () => ({ target, owner });
  let motions = [],
    motionId = 0,
    drag = null;
  function cleanMotion() {
    motionId++;
    motions.forEach((animation) => animation.cancel());
    motions = [];
    for (const node of [main, side]) {
      for (const property of ['position', 'left', 'top', 'width', 'height', 'transform', 'zIndex'])
        node.style[property] = '';
      node.inert = false;
    }
    main.hidden = target === 'btw';
    side.hidden = target !== 'btw';
    main.parentElement.classList.remove('btw-sliding');
  }
  function overlay(node, rect) {
    const parent = main.parentElement.getBoundingClientRect();
    Object.assign(node.style, {
      position: 'absolute',
      left: `${rect.left - parent.left}px`,
      top: `${rect.top - parent.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      zIndex: '2',
    });
    node.hidden = false;
    node.inert = true;
    main.parentElement.classList.add('btw-sliding');
  }
  function setTarget(next, animate = true, offset = 0) {
    cleanMotion();
    drag = null;
    if (next === target) return;
    const from = target === 'main' ? main : side;
    const to = next === 'main' ? main : side;
    const rect = from.getBoundingClientRect();
    const direction = next === 'btw' ? 1 : -1;
    commitTarget(next);
    if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches || !rect.width) return;
    overlay(from, rect);
    const id = motionId;
    // DESIGN.md: 220ms in / 140ms ease-in back, translateX only, no rebound.
    // A committed drag settles from the finger over 120–280ms by remaining distance.
    const remaining = 1 - Math.min(1, Math.abs(offset) / rect.width);
    const timing = offset
      ? { duration: Math.round(120 + 160 * remaining), easing: 'cubic-bezier(.2,.8,.2,1)' }
      : next === 'btw'
        ? { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' }
        : { duration: 140, easing: 'ease-in' };
    motions = [
      from.animate(
        [
          { transform: `translateX(${offset}px)` },
          { transform: `translateX(${-direction * rect.width}px)` },
        ],
        timing,
      ),
      to.animate(
        [
          { transform: `translateX(${offset + direction * rect.width}px)` },
          { transform: 'translateX(0)' },
        ],
        timing,
      ),
    ];
    Promise.allSettled(motions.map((a) => a.finished)).then(() => {
      if (id === motionId) cleanMotion();
    });
  }
  function commitTarget(next) {
    if (next === target) return;
    if (target === 'main') {
      mainDraft = textarea.value;
      mainScroll = main.scrollTop;
    } else {
      sideDraft = textarea.value;
      sideScroll = side.scrollTop;
    }
    target = next;
    textarea.value = next === 'main' ? mainDraft : sideDraft;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    main.hidden = next === 'btw';
    side.hidden = next !== 'btw';
    card.hidden = next !== 'btw';
    byId('app').classList.toggle('btw-active', next === 'btw');
    // An inactive target cannot inherit the main composer attachments/clipboard.
    attach.disabled = next === 'btw' || mainBlocked();
    paste.disabled = next === 'btw' || mainBlocked();
    attach.title = next === 'btw' ? 'BTW currently supports text only' : 'Add attachment';
    textarea.setAttribute('aria-label', next === 'btw' ? '傳送至 BTW' : 'Message');
    textarea.placeholder = next === 'btw' ? '問 BTW…' : 'Message pi…';
    send.setAttribute('aria-label', next === 'btw' ? '傳送至 BTW' : 'Send');
    (next === 'main' ? main : side).scrollTop = next === 'main' ? mainScroll : sideScroll;
    renderStatus();
  }

  async function open({ cached = false } = {}) {
    const session = getSession();
    if (!session || session.readOnly) return notify('先選擇可操作的 Pi 對話');
    if (target === 'btw' && owner === session.key) return;
    if (opening) return;
    if (byId('attachments')?.childElementCount || !byId('quote-preview').hidden) {
      return notify('請先移除主對話附件或引用，再切到 BTW');
    }
    if (owner === session.key && generation && (sideBusy() || clearing || cached)) {
      setTarget('btw');
      renderStatus();
      return;
    }
    const ticket = ++request;
    opening = true;
    try {
      const data = await api(`/api/sessions/${encodeURIComponent(session.jid)}/btw`);
      if (ticket !== request || key() !== session.key) return;
      if (!data?.available) return notify(data?.reason || '此執行模式尚未支援 BTW');
      if (typeof data.generation !== 'string' || !data.generation) {
        return notify('BTW 回應缺少會話世代；未切換收件對象');
      }
      if (owner !== session.key || generation !== data.generation) {
        owner = session.key;
        generation = data.generation;
        sideDraft = '';
        sideScroll = 0;
      }
      renderThread(data.thread);
      setTarget('btw');
      renderStatus();
      back.focus({ preventScroll: true });
    } catch (error) {
      if (ticket === request) notify(error.message || '無法開啟 BTW');
    } finally {
      if (ticket === request) {
        opening = false;
        renderControls();
      }
    }
  }

  async function submit(event) {
    if (target !== 'btw' && !opening) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const session = getSession();
    if (!session || session.key !== owner || sideBusy() || clearing || opening) return;
    const text = textarea.value.trim();
    if (!text) return;
    const epoch = runEpoch;
    sending = true;
    send.disabled = true;
    // Show the question immediately and free the composer; the draft is put
    // back only if the bridge rejects it, so nothing is silently lost.
    const pending = pendingNodes(text);
    side.append(...pending);
    side.scrollTop = side.scrollHeight;
    sideDraft = '';
    textarea.value = '';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    renderStatus();
    let delivered = false;
    try {
      // There is deliberately no fallback to /messages or /commands.
      const response = await api(`/api/sessions/${encodeURIComponent(session.jid)}/btw`, {
        method: 'POST',
        body: JSON.stringify({ text, generation }),
      });
      delivered = true;
      if (epoch !== runEpoch || key() !== session.key || owner !== session.key) return;
      if (response?.thread?.messages) {
        side.replaceChildren(
          ...response.thread.messages
            .filter((m) => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
            .map(buildMessage),
        );
      }
    } catch (error) {
      if (epoch === runEpoch && key() === session.key && owner === session.key) {
        // Restore without clobbering anything typed meanwhile.
        if (target === 'btw') {
          if (!textarea.value.trim()) {
            textarea.value = text;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
          }
        } else if (!sideDraft.trim()) {
          sideDraft = text;
        }
        notify(error.message || 'BTW 送出失敗，草稿已保留');
      }
    } finally {
      if (epoch === runEpoch) {
        sending = false;
        if (!delivered) pending.forEach((node) => node.remove());
        else
          pending.forEach(
            (node) => node.isConnected && node.classList.contains('btw-waiting') && node.remove(),
          );
        renderStatus();
      }
    }
  }

  for (const surface of [main, side]) {
    surface.addEventListener('pointerdown', (event) => {
      const session = getSession();
      if (
        !event.isPrimary ||
        event.button !== 0 ||
        !owner ||
        owner !== session?.key ||
        session.readOnly ||
        event.clientX < 35 ||
        event.clientX > innerWidth - 35 ||
        event.target.closest('button, a, input, textarea, video, audio, summary') ||
        !window.getSelection()?.isCollapsed ||
        byId('attachments')?.childElementCount ||
        !byId('quote-preview').hidden
      )
        return;
      cleanMotion();
      drag = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        dx: 0,
        active: false,
        surface,
        next: target === 'main' ? 'btw' : 'main',
      };
    });
    surface.addEventListener('pointermove', (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      const dx = event.clientX - drag.x,
        dy = event.clientY - drag.y;
      if (!drag.active) {
        if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) {
          drag = null;
          return;
        }
        if (Math.abs(dx) < 12 || Math.abs(dx) < Math.abs(dy) * 1.3) return;
        if ((target === 'main' && dx > 0) || (target === 'btw' && dx < 0)) {
          drag = null;
          return;
        }
        drag.active = true;
        drag.rect = surface.getBoundingClientRect();
        drag.other = surface === main ? side : main;
        overlay(drag.other, drag.rect);
        drag.other.scrollTop = surface === main ? sideScroll : mainScroll;
        surface.setPointerCapture(event.pointerId);
      }
      event.preventDefault();
      const direction = drag.next === 'btw' ? 1 : -1;
      drag.dx =
        direction > 0
          ? Math.max(-drag.rect.width, Math.min(0, dx))
          : Math.min(drag.rect.width, Math.max(0, dx));
      const now = event.timeStamp;
      if (drag.t != null && now > drag.t) {
        const v = (drag.dx - drag.lastDx) / (now - drag.t);
        drag.v = drag.v == null ? v : drag.v * 0.6 + v * 0.4;
      }
      drag.t = now;
      drag.lastDx = drag.dx;
      surface.style.transform = `translateX(${drag.dx}px)`;
      drag.other.style.transform = `translateX(${drag.dx + direction * drag.rect.width}px)`;
    });
    const finish = (event, cancelled) => {
      if (!drag || drag.id !== event.pointerId) return;
      const saved = drag;
      drag = null;
      if (!saved.active) return;
      // DESIGN.md (shared with Subagents): commit at 28% of the width, or a
      // ≥60px flick at ≥0.5px/ms whose 180ms projection reaches 28%. Velocity
      // expires after 100ms without movement; a reversed flick never commits.
      const threshold = saved.rect.width * 0.28;
      const sign = saved.next === 'btw' ? -1 : 1;
      const fresh = saved.t != null && event.timeStamp - saved.t <= 100;
      const speed = fresh ? (saved.v || 0) * sign : 0;
      const travelled = saved.dx * sign;
      const fling = travelled >= 60 && speed >= 0.5 && travelled + speed * 180 >= threshold;
      if (!cancelled && (travelled >= threshold || fling)) {
        setTarget(saved.next, true, saved.dx);
      } else {
        const id = motionId,
          direction = saved.next === 'btw' ? 1 : -1;
        const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180;
        motions = [
          saved.surface.animate(
            [{ transform: `translateX(${saved.dx}px)` }, { transform: 'translateX(0)' }],
            { duration, easing: 'ease-out' },
          ),
          saved.other.animate(
            [
              { transform: `translateX(${saved.dx + direction * saved.rect.width}px)` },
              { transform: `translateX(${direction * saved.rect.width}px)` },
            ],
            { duration, easing: 'ease-out' },
          ),
        ];
        Promise.allSettled(motions.map((a) => a.finished)).then(() => {
          if (id === motionId) cleanMotion();
        });
      }
    };
    surface.addEventListener('pointerup', (event) => finish(event, false));
    surface.addEventListener('pointercancel', (event) => finish(event, true));
  }

  clear.addEventListener('click', async () => {
    const session = getSession();
    if (sideBusy() || clearing || opening || !session || session.key !== owner) return;
    if (!confirm('清除這個 BTW 側聊的訊息與脈絡？主對話不受影響。')) return;
    const epoch = runEpoch;
    clearing = true;
    renderStatus();
    try {
      const response = await api(`/api/sessions/${encodeURIComponent(session.jid)}/btw`, {
        method: 'POST',
        body: JSON.stringify({ action: 'clear', generation }),
      });
      if (epoch !== runEpoch || key() !== session.key) return;
      if (
        !response?.available ||
        !Array.isArray(response.thread?.messages) ||
        response.thread.messages.length
      ) {
        throw new Error('尚未確認 BTW 已清除，請稍後重試');
      }
      side.replaceChildren();
      sideScroll = 0;
      notify('BTW 已清除，主對話保持不變');
    } catch (error) {
      if (epoch === runEpoch && key() === session.key) notify(error.message || 'BTW 清除失敗');
    } finally {
      if (epoch === runEpoch) {
        clearing = false;
        renderStatus();
      }
    }
  });
  function goMain() {
    ++request;
    opening = false;
    setTarget('main');
    renderControls();
  }
  item.addEventListener('click', () => {
    void open();
  });
  back.addEventListener('click', () => {
    goMain();
    item.focus({ preventScroll: true });
  });
  pendingLink.addEventListener('click', () => {
    if (!owner || owner !== key()) return;
    setTarget('btw');
    back.focus({ preventScroll: true });
  });
  byId('composer').addEventListener('submit', submit, true);
  // Capture before the main editor's keyboard slash/submit handlers run.
  textarea.addEventListener(
    'keydown',
    (event) => {
      if ((target !== 'btw' && !opening) || event.isComposing) return;
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        byId('composer').requestSubmit();
      }
    },
    true,
  );
  return {
    open,
    snapshot,
    reset() {
      ++request;
      ++runEpoch;
      sending = false;
      remotePending = false;
      clearTimeout(pendingPoll);
      pendingPoll = null;
      clearing = false;
      opening = false;
      setTarget('main', false);
      owner = null;
      generation = null;
      sideDraft = '';
      side.replaceChildren();
      mainDraft = '';
      renderControls();
    },
    isSide: () => target === 'btw',
    close: goMain,
  };
}
