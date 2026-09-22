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
  const preview = make('div', 'subagents-swipe-preview');
  preview.inert = true;
  preview.setAttribute('aria-hidden', 'true');
  const surface = make('div', 'subagents-surface');
  surface.append(header, note, older, body);
  dialog.append(preview, surface);
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
    closeAnimation,
    openAnimation;
  let gesture, dragAnimation;
  let settling = false,
    dragEpoch = 0;
  function resetDrag() {
    dragEpoch++;
    dragAnimation?.cancel();
    dragAnimation = undefined;
    settling = false;
    gesture = undefined;
    surface.inert = false;
    surface.style.transform = '';
    delete dialog.dataset.dragging;
    preview.replaceChildren();
  }
  function beginDrag() {
    viewAnimation?.cancel();
    openAnimation?.cancel();
    dialog.dataset.dragging = selected ? 'detail' : 'list';
    if (selected) {
      const underHeader = make('header', 'subagents-header');
      const underHeading = make('div', 'subagents-heading');
      underHeading.append(
        make('h2', '', 'Subagents'),
        make('span', 'subagents-count', String(cards.size)),
      );
      underHeader.append(underHeading, make('button', '', '×'));
      const underBody = make('div', 'subagents-body');
      underBody.append(list.cloneNode(true));
      for (const node of underBody.querySelectorAll('[id]')) node.removeAttribute('id');
      preview.replaceChildren(
        underHeader,
        make('p', 'subagents-note', 'This session · Select an agent to view its work'),
        underBody,
      );
      underBody.scrollTop = listScroll;
    }
  }
  function settleDrag(start, commit) {
    const epoch = ++dragEpoch;
    settling = true;
    surface.inert = true;
    const target = commit ? start.width : 0;
    const distance = Math.abs(target - start.distance);
    const duration = reduced()
      ? 0
      : Math.max(120, Math.min(280, distance / Math.max(0.6, Math.abs(start.velocity))));
    const finish = () => {
      if (epoch !== dragEpoch) return;
      const valid = current(start.g) && start.view === selected?.id;
      resetDrag();
      if (valid && !commit && start.focus?.isConnected) start.focus.focus({ preventScroll: true });
      if (!valid || !commit) return;
      if (selected) returnToList(false);
      else close();
    };
    if (!duration) {
      finish();
      return;
    }
    dragAnimation = surface.animate(
      [{ transform: `translateX(${start.distance}px)` }, { transform: `translateX(${target}px)` }],
      { duration, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' },
    );
    dragAnimation.finished.then(finish, () => {});
  }
  function cancelDrag() {
    const start = gesture;
    gesture = undefined;
    if (start?.dragging) settleDrag(start, false);
  }
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  function animateView(direction = 1) {
    viewAnimation?.cancel();
    if (!reduced())
      viewAnimation = body.animate(
        [{ transform: `translateX(${direction * 100}%)` }, { transform: 'translateX(0)' }],
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
  const sourcePrefix = (source) =>
    source === 'agy' ? 'AGY · ' : source === 'claude-code' ? 'CLAUDE · ' : '';

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
    openAnimation?.cancel();
    resetDrag();
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
        [{ transform: 'translateX(0)' }, { transform: 'translateX(100%)' }],
        { duration: 140, easing: 'ease-in' },
      );
      closeAnimation.finished.then(finish, () => {});
    } else finish();
  }
  function selectChild(child, g) {
    resetDrag();
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
        const source = sourcePrefix(item.source);
        note.textContent = `${source}${(item.model || 'Model pending').split('/').at(-1)} · ${stateLabel(item)} · Read only`;
        note.title =
          'Saved child messages, not live process status. Updates appear at message boundaries.';
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
        note.title = 'Saved Pi, AGY and Claude subagents. Updates appear at message boundaries.';
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
          card.model.textContent =
            sourcePrefix(child.source) + (child.model || 'Model pending').split('/').at(-1);
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
      openAnimation = dialog.animate(
        [{ transform: 'translateX(100%)' }, { transform: 'translateX(0)' }],
        { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' },
      );
    void refresh(generation);
  }
  function returnToList(animated = true) {
    if (!selected) return;
    resetDrag();
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
    if (animated) animateView(-1);
    void refresh(generation);
  }
  back.addEventListener('click', () => returnToList());

  // Finger-following right drag: one level back, never a global browser gesture.
  // Reserve interactive controls, text selection and horizontally scrollable
  // content for their native interactions rather than stealing their gestures.
  dialog.addEventListener(
    'touchstart',
    (event) => {
      if (settling) return;
      cancelDrag();
      if (event.touches.length !== 1 || window.getSelection()?.type === 'Range') return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const control = target.closest(
        'button,a,input,textarea,select,summary,pre,code,[contenteditable]',
      );
      // Navigation cards are the main list swipe surface; toolbar controls and
      // editable/output content retain their own interactions.
      if (control && !control.matches('button.subagent-row')) return;
      for (let node = target; node && node !== dialog; node = node.parentElement) {
        if (
          node.scrollWidth > node.clientWidth + 1 &&
          /auto|scroll/.test(getComputedStyle(node).overflowX)
        )
          return;
      }
      const touch = event.touches[0];
      gesture = {
        x: touch.clientX,
        y: touch.clientY,
        id: touch.identifier,
        g: generation,
        view: selected?.id,
        width: dialog.getBoundingClientRect().width,
        dragging: false,
        distance: 0,
        velocity: 0,
        lastX: touch.clientX,
        lastTime: performance.now(),
        focus: surface.contains(document.activeElement) ? document.activeElement : undefined,
      };
    },
    { passive: true },
  );
  dialog.addEventListener(
    'touchmove',
    (event) => {
      if (!gesture) return;
      if (event.touches.length !== 1 || window.getSelection()?.type === 'Range') {
        cancelDrag();
        return;
      }
      const touch = event.touches[0];
      const dx = touch.clientX - gesture.x;
      const dy = touch.clientY - gesture.y;
      if (!gesture.dragging) {
        if (Math.abs(dy) > 12 && Math.abs(dy) >= Math.abs(dx)) {
          cancelDrag();
          return;
        }
        // iOS may latch native scrolling after the first uncancelled move.
        // Claim clear rightward intent immediately, while retaining the 12px
        // threshold for visual movement; leave vertical motion to the browser.
        if (dx > 0 && Math.abs(dx) > Math.abs(dy) * 1.5 && event.cancelable) event.preventDefault();
        if (dx <= 12 || Math.abs(dx) <= Math.abs(dy) * 1.5) return;
        gesture.dragging = true;
        beginDrag();
      }
      if (event.cancelable) event.preventDefault();
      const now = performance.now();
      const elapsed = now - gesture.lastTime;
      if (elapsed > 0)
        gesture.velocity =
          0.5 * gesture.velocity +
          0.5 * Math.max(-3, Math.min(3, (touch.clientX - gesture.lastX) / elapsed));
      gesture.lastX = touch.clientX;
      gesture.lastTime = now;
      gesture.distance = Math.max(0, Math.min(gesture.width, dx));
      surface.style.transform = `translateX(${gesture.distance}px)`;
    },
    { passive: false },
  );
  dialog.addEventListener('touchcancel', cancelDrag);
  dialog.addEventListener(
    'touchend',
    (event) => {
      const start = gesture;
      gesture = undefined;
      if (!start?.dragging) return;
      if (
        event.touches.length ||
        !current(start.g) ||
        start.view !== selected?.id ||
        window.getSelection()?.type === 'Range'
      ) {
        settleDrag(start, false);
        return;
      }
      const touch = [...event.changedTouches].find((t) => t.identifier === start.id);
      if (!touch) {
        settleDrag(start, false);
        return;
      }
      const releaseVelocity = performance.now() - start.lastTime > 100 ? 0 : start.velocity;
      const projected = start.distance + Math.max(0, releaseVelocity) * 180;
      const commit =
        start.distance >= start.width * 0.28 ||
        (start.distance >= 60 && releaseVelocity >= 0.5 && projected >= start.width * 0.28);
      // Reversing the drag should not fling a nearly restored page away.
      settleDrag(start, commit && releaseVelocity >= -0.2);
    },
    { passive: true },
  );
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
