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
  const status = card.querySelector('span');
  const typing = byId('typing');

  // The card replaces the main typing row while BTW is selected, so it carries
  // both states: the side answer in flight, and the main agent still working.
  function renderStatus() {
    if (sending) status.textContent = 'BTW 回答中…主對話不受影響';
    else if (typing && !typing.hidden) status.textContent = '主對話仍在執行 · 這裡的訊息只送到 BTW';
    else status.textContent = '這裡的訊息只送到 BTW，不會自動加入主對話';
  }
  if (typing) new MutationObserver(renderStatus).observe(typing, { attributes: true, attributeFilter: ['hidden'] });

  function pendingNodes(text) {
    const question = buildMessage({ role: 'user', content: text });
    question.classList.add('btw-pending');
    const waiting = document.createElement('div');
    waiting.className = 'btw-waiting';
    waiting.setAttribute('role', 'status');
    waiting.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
    waiting.append(Object.assign(document.createElement('span'), { textContent: 'BTW 回答中…' }));
    return [question, waiting];
  }

  const key = () => getSession()?.key || null;
  const snapshot = () => ({ target, owner });
  function setTarget(next) {
    if (next === target) return;
    if (target === 'main') { mainDraft = textarea.value; mainScroll = main.scrollTop; }
    else { sideDraft = textarea.value; sideScroll = side.scrollTop; }
    target = next;
    textarea.value = next === 'main' ? mainDraft : sideDraft;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    main.hidden = next === 'btw';
    side.hidden = next !== 'btw';
    card.hidden = next !== 'btw';
    byId('app').classList.toggle('btw-active', next === 'btw');
    // An inactive target cannot inherit the main composer attachments/clipboard.
    attach.disabled = next === 'btw';
    paste.disabled = next === 'btw';
    attach.title = next === 'btw' ? 'BTW currently supports text only' : 'Add attachment';
    textarea.setAttribute('aria-label', next === 'btw' ? '傳送至 BTW' : 'Message');
    textarea.placeholder = next === 'btw' ? 'Message BTW…' : 'Message pi…';
    send.setAttribute('aria-label', next === 'btw' ? '傳送至 BTW' : 'Send');
    (next === 'main' ? main : side).scrollTop = next === 'main' ? mainScroll : sideScroll;
  }

  async function open() {
    const session = getSession();
    if (!session || session.readOnly) return notify('先選擇可操作的 Pi 對話');
    if (target === 'btw' && owner === session.key) return;
    if (byId('attachments')?.childElementCount || !byId('quote-preview').hidden) {
      return notify('請先移除主對話附件或引用，再切到 BTW');
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
        owner = session.key; generation = data.generation; sideDraft = ''; sideScroll = 0;
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
      if (ticket === request) opening = false;
    }
  }

  async function submit(event) {
    if (target !== 'btw' && !opening) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const session = getSession();
    if (!session || session.key !== owner || sending) return;
    const text = textarea.value.trim();
    if (!text) return;
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
        method: 'POST', body: JSON.stringify({ text, generation }),
      });
      delivered = true;
      if (key() !== session.key || owner !== session.key) return;
      if (response?.thread?.messages) {
        side.replaceChildren(...response.thread.messages
          .filter((m) => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
          .map(buildMessage));
      }
    } catch (error) {
      if (key() === session.key && owner === session.key) {
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
      sending = false;
      send.disabled = false;
      if (!delivered) pending.forEach((node) => node.remove());
      else pending.forEach((node) => node.isConnected && node.classList.contains('btw-waiting') && node.remove());
      renderStatus();
    }
  }

  item.addEventListener('click', open);
  back.addEventListener('click', () => { setTarget('main'); item.focus({ preventScroll: true }); });
  byId('composer').addEventListener('submit', submit, true);
  // Capture before the main editor's keyboard slash/submit handlers run.
  textarea.addEventListener('keydown', (event) => {
    if ((target !== 'btw' && !opening) || event.isComposing) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      byId('composer').requestSubmit();
    }
  }, true);
  return {
    open,
    snapshot,
    reset() {
      ++request;
      opening = false;
      setTarget('main');
      owner = null;
      generation = null;
      sideDraft = '';
      side.replaceChildren();
      mainDraft = '';
    },
    isSide: () => target === 'btw',
    close: () => setTarget('main'),
  };
}
