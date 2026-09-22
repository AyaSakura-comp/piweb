/** A read-only child viewer. Rendering is injected from the NORMAL transcript,
 * not copied: Markdown, tools, code highlighting and XSS rules stay identical. */
export function createSubagentsView({ api, getParent, buildEventNode }) {
  const make = (tag, cls, text) => {
    const e = document.createElement(tag);
    e.className = cls;
    if (text) e.textContent = text;
    return e;
  };
  const dialog = make('dialog', 'subagents-dialog');
  dialog.setAttribute('aria-label', 'Subagents');
  const header = make('header', 'subagents-header');
  const back = make('button', '', '←');
  back.type = 'button';
  back.setAttribute('aria-label', 'Back to subagents');
  const title = make('h2', '', 'Subagents');
  const count = make('span', 'subagents-count');
  const heading = make('div', 'subagents-heading');
  heading.append(title, count);
  const closeButton = make('button', '', '×');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Close subagents');
  header.append(back, heading, closeButton);
  const note = make('p', 'subagents-note');
  note.setAttribute('role', 'status');
  const body = make('div', 'subagents-body');
  const older = make('button', 'subagents-older', 'Load older messages');
  older.type = 'button';
  older.hidden = true;
  dialog.append(header, note, older, body);
  document.body.append(dialog);
  let generation = 0,
    timer,
    parent,
    scope,
    selected,
    request = 0,
    earliest,
    latest;
  let controller;
  const nodes = new Map();
  const cards = new Map();
  const list = make('div', 'subagents-list');
  let listScroll = 0,
    returnId,
    viewAnimation,
    closeAnimation;
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  function animateView(direction = 1) {
    viewAnimation?.cancel();
    if (!reduced())
      viewAnimation = body.animate(
        [
          { opacity: 0, transform: `translateX(${direction * 12}px)` },
          { opacity: 1, transform: 'translateX(0)' },
        ],
        { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' },
      );
  }
  function displayName(child) {
    const generated =
      /^subagent-(.+)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}-\d+$/i.exec(
        child.name || '',
      );
    if (!generated) return child.name || 'Subagent';
    const name = generated[1].replace(/[-_]+/g, ' ');
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  function stateLabel(child) {
    if (child.running === true) return 'Running';
    if (/complete/i.test(child.state)) return 'Response ready';
    if (/interrupt|error|unreadable/i.test(child.state)) return 'Needs attention';
    return 'Recorded activity';
  }
  function close(animated = false) {
    const g = ++generation;
    request++;
    controller?.abort();
    clearTimeout(timer);
    viewAnimation?.cancel();
    closeAnimation?.cancel();
    const finish = () => {
      if (generation !== g) return;
      if (dialog.open) dialog.close();
      nodes.clear();
      cards.clear();
      body.replaceChildren();
      list.replaceChildren();
    };
    if (animated && dialog.open && !reduced()) {
      closeAnimation = dialog.animate(
        [
          { opacity: 1, transform: 'translateY(0)' },
          { opacity: 0, transform: 'translateY(12px)' },
        ],
        { duration: 140, easing: 'ease-in' },
      );
      closeAnimation.finished.then(finish, () => {});
    } else finish();
  }
  function selectChild(child, g) {
    listScroll = body.scrollTop;
    returnId = child.id;
    selected = child;
    dialog.dataset.view = 'detail';
    back.hidden = false;
    count.hidden = true;
    body.replaceChildren();
    nodes.clear();
    earliest = undefined;
    latest = undefined;
    title.textContent = displayName(child);
    title.title = child.name;
    note.textContent = 'Loading child history…';
    clearTimeout(timer);
    back.focus({ preventScroll: true });
    animateView(1);
    void refresh(g);
  }
  function current(g) {
    return dialog.open && generation === g && getParent()?.key === parent?.key;
  }
  function renderEvents(events, prepend = false) {
    const follow = body.scrollHeight - body.scrollTop - body.clientHeight < 90;
    const oldHeight = body.scrollHeight;
    const fragment = document.createDocumentFragment();
    for (const event of events) {
      const key = event.id || String(event.rowid);
      if (nodes.has(key)) continue;
      const node = buildEventNode(event);
      nodes.set(key, node);
      fragment.append(node);
    }
    if (prepend) {
      body.prepend(fragment);
      body.scrollTop += body.scrollHeight - oldHeight;
    } else {
      body.append(fragment);
      if (follow) body.scrollTop = body.scrollHeight;
    }
  }
  async function refresh(g, before) {
    if (!current(g)) {
      if (generation === g) close();
      return;
    }
    const ticket = ++request;
    const params = new URLSearchParams();
    // Lists follow the current parent (including the first persisted prompt).
    // A selected child's detail is always pinned to its captured exact scope.
    if (scope && selected) params.set('scope', scope);
    if (selected) params.set('child', selected.id);
    if (before) params.set('before', String(before));
    else if (selected && latest) params.set('after', latest);
    let stopped = false,
      more = false;
    controller?.abort();
    controller = new AbortController();
    const separator = parent.url.includes('?') ? '&' : '?';
    try {
      const data = await api(parent.url + separator + params, { signal: controller.signal });
      if (!current(g) || ticket !== request) return;
      scope = data.scope;
      if (selected) {
        const child = data.children.find((c) => c.id === selected.id);
        const item = child || selected;
        title.textContent = displayName(item);
        note.textContent = `${(item.model || 'Model pending').split('/').at(-1)} · ${stateLabel(item)} · Read only`;
        note.title =
          'Persisted messages, not live process status. Updates appear at message boundaries.';
        if (data.reset) {
          body.replaceChildren();
          nodes.clear();
          earliest = undefined;
          latest = undefined;
        }
        renderEvents(data.events || [], !!before);
        if (!before && data.events?.length)
          latest = data.events.at(-1).id || String(data.events.at(-1).rowid);
        more = !!data.hasMoreNewer;
        const first = data.events?.[0]?.rowid;
        if (first && (!earliest || first < earliest)) {
          earliest = first;
          older.hidden = !data.hasMore;
        }
      } else {
        count.textContent = String(data.children.length);
        count.hidden = !data.children.length;
        note.textContent = data.children.length
          ? 'This session · Select an agent to view its work'
          : 'This session';
        note.title = 'Persisted native subagents only. Updates appear at message boundaries.';
        if (!list.isConnected) body.replaceChildren(list);
        const ids = new Set(data.children.map((child) => child.id));
        for (const [id, card] of cards)
          if (!ids.has(id)) {
            card.button.remove();
            cards.delete(id);
          }
        list.querySelector('.subagents-empty')?.remove();
        const focusedCard = [...cards.values()].find(
          (c) => c.button === document.activeElement,
        )?.button;
        const anchor =
          body.scrollTop > 0
            ? focusedCard ||
              [...list.children].find(
                (e) => e.getBoundingClientRect().bottom > body.getBoundingClientRect().top + 8,
              )
            : undefined;
        const anchorTop = anchor?.getBoundingClientRect().top;
        data.children.forEach((child, index) => {
          let card = cards.get(child.id);
          if (!card) {
            const button = make('button', 'subagent-row');
            button.type = 'button';
            const top = make('span', 'subagent-top');
            const number = make('span', 'subagent-number');
            const name = make('strong', 'subagent-name');
            const arrow = make('span', 'subagent-chevron', '›');
            arrow.setAttribute('aria-hidden', 'true');
            top.append(number, name, arrow);
            const task = make('span', 'subagent-task');
            const meta = make('span', 'subagent-meta');
            const model = make('span', 'subagent-model');
            const status = make('span', 'subagent-state');
            meta.append(model, status);
            button.append(top, task, meta);
            card = { button, number, name, task, model, status, child };
            const entry = card;
            button.addEventListener('click', () => selectChild(entry.child, generation));
            cards.set(child.id, card);
          }
          card.child = child;
          card.number.textContent = String(index + 1).padStart(2, '0');
          card.name.textContent = displayName(child);
          card.button.title = child.name;
          card.task.textContent = (child.task || 'Open conversation and tool history').replace(
            /^Task:\s*/i,
            '',
          );
          card.model.textContent = (child.model || 'Model pending').split('/').at(-1);
          card.status.textContent = stateLabel(child);
          card.status.dataset.tone =
            child.running === true
              ? 'running'
              : /complete/i.test(child.state)
                ? 'ready'
                : /interrupt|error|unreadable/i.test(child.state)
                  ? 'attention'
                  : 'neutral';
          // Do not replace or move unchanged buttons on polling: retain focus.
          if (list.children[index] !== card.button)
            list.insertBefore(card.button, list.children[index] || null);
        });
        if (focusedCard?.isConnected && document.activeElement !== focusedCard)
          focusedCard.focus({ preventScroll: true });
        if (anchor?.isConnected && anchorTop !== undefined)
          body.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
        if (!data.children.length) {
          const empty = make('div', 'subagents-empty');
          empty.append(
            make('span', 'subagents-empty-icon', '◇'),
            make('h3', '', 'No subagents yet'),
            make(
              'p',
              '',
              'Saved agent conversations will appear here when this session delegates work.',
            ),
          );
          list.append(empty);
        }
        if (returnId) {
          body.scrollTop = listScroll;
          cards.get(returnId)?.button.focus({ preventScroll: true });
          returnId = undefined;
        }
      }
    } catch (error) {
      if (!current(g) || ticket !== request) return;
      note.textContent = error.message || 'Could not load subagents.';
      // Never silently rebind a stale child to a new parent generation.
      if (/changed|not found/i.test(note.textContent)) {
        body.replaceChildren();
        older.hidden = true;
        stopped = true;
        return;
      }
    } finally {
      if (!stopped && current(g) && ticket === request) {
        clearTimeout(timer);
        timer = setTimeout(() => void refresh(g), more ? 0 : 1000);
      }
    }
  }
  function open() {
    close();
    parent = getParent();
    if (!parent) return;
    scope = undefined;
    selected = undefined;
    earliest = undefined;
    latest = undefined;
    back.hidden = true;
    older.hidden = true;
    listScroll = 0;
    returnId = undefined;
    dialog.dataset.view = 'list';
    count.hidden = true;
    title.textContent = 'Subagents';
    title.removeAttribute('title');
    note.textContent = 'Loading subagents…';
    body.replaceChildren(list);
    dialog.showModal();
    if (!reduced())
      dialog.animate(
        [
          { opacity: 0, transform: 'translateY(16px) scale(.985)' },
          { opacity: 1, transform: 'translateY(0) scale(1)' },
        ],
        { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' },
      );
    void refresh(generation);
  }
  back.addEventListener('click', () => {
    clearTimeout(timer);
    request++;
    returnId = selected?.id;
    selected = undefined;
    latest = undefined;
    nodes.clear();
    body.replaceChildren(list);
    body.scrollTop = listScroll;
    dialog.dataset.view = 'list';
    back.hidden = true;
    older.hidden = true;
    title.textContent = 'Subagents';
    title.removeAttribute('title');
    note.textContent = 'This session · Select an agent to view its work';
    cards.get(returnId)?.button.focus({ preventScroll: true });
    returnId = undefined; // Restore once; delayed refresh must not steal subsequent navigation.
    animateView(-1);
    void refresh(generation);
  });
  older.addEventListener('click', () => {
    clearTimeout(timer);
    void refresh(generation, earliest);
  });
  closeButton.addEventListener('click', () => close(true));
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    close(true);
  });
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) {
      const r = dialog.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
        close(true);
    }
  });
  return { open, close };
}
