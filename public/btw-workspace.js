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
  let opening = false;
  let clearing = false;
  let runEpoch = 0;
  const tabs = document.createElement('div');
  tabs.id = 'btw-switcher';
  tabs.className = 'btw-switcher';
  tabs.hidden = true;
  tabs.setAttribute('role', 'group');
  tabs.setAttribute('aria-label', '對話收件對象');
  const mainTab = Object.assign(document.createElement('button'), {
    id: 'btw-switch-main',
    type: 'button',
    textContent: '主對話',
  });
  const sideTab = Object.assign(document.createElement('button'), {
    id: 'btw-switch-side',
    type: 'button',
    textContent: 'BTW',
  });
  tabs.append(mainTab, sideTab);
  main.before(tabs);
  const clear = Object.assign(document.createElement('button'), {
    id: 'btw-clear',
    type: 'button',
    textContent: '清除 BTW',
  });
  clear.setAttribute('aria-label', '清除 BTW 訊息');
  back.before(clear);
  const mainBlocked = () =>
    Boolean(byId('upload-progress') && !byId('upload-progress').hidden) || textarea.disabled;
  function renderControls() {
    send.disabled = target === 'btw' ? sending || clearing : mainBlocked();
    clear.disabled = sending || clearing || opening;
    mainTab.setAttribute('aria-pressed', String(target === 'main'));
    sideTab.setAttribute('aria-pressed', String(target === 'btw'));
    sideTab.textContent = sending ? 'BTW · 回答中' : clearing ? 'BTW · 清除中' : 'BTW';
    tabs.hidden = !owner;
  }
  const status = card.querySelector('span');
  const typing = byId('typing');

  // The card replaces the main typing row while BTW is selected, so it carries
  // both states: the side answer in flight, and the main agent still working.
  function renderStatus() {
    if (sending) status.textContent = 'BTW 回答中…主對話不受影響';
    else if (typing && !typing.hidden) status.textContent = '主對話仍在執行 · 這裡的訊息只送到 BTW';
    else status.textContent = '這裡的訊息只送到 BTW，不會自動加入主對話';
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

  const key = () => getSession()?.key || null;
  const snapshot = () => ({ target, owner });
  function setTarget(next) {
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
    textarea.placeholder = next === 'btw' ? 'Message BTW…' : 'Message pi…';
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
    if (owner === session.key && generation && (sending || clearing || cached)) {
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
      side.replaceChildren();
      for (const message of data.thread?.messages || []) {
        // The structured Web bridge must not hand untrusted HTML to the renderer.
        if (message.role !== 'user' && message.role !== 'assistant') continue;
        if (typeof message.content !== 'string') continue;
        side.append(buildMessage(message));
      }
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
    if (!session || session.key !== owner || sending || clearing || opening) return;
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

  clear.addEventListener('click', async () => {
    const session = getSession();
    if (sending || clearing || opening || !session || session.key !== owner) return;
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
  mainTab.addEventListener('click', goMain);
  sideTab.addEventListener('click', () => {
    void open({ cached: true });
  });
  item.addEventListener('click', () => {
    void open();
  });
  back.addEventListener('click', () => {
    goMain();
    item.focus({ preventScroll: true });
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
      clearing = false;
      opening = false;
      setTarget('main');
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
