/**
 * 🔑 Login details for the next message.
 *
 * The key button in the composer opens an inline card above the box (name,
 * account, password). 加入 turns it into a 🔑 chip; Send carries the details
 * in the request's `secrets` field, where the server seals them before writing
 * anything (src/secrets.ts). They live only in this page's memory until then:
 * never in localStorage, never in the draft, never in the transcript (which
 * shows just 🔑 <name>).
 */

const MAX_DETAILS = 8;

export function createComposerSecrets({
  button,
  panel,
  nameInput,
  userInput,
  passInput,
  cancelButton,
  onChange = () => {},
  onOpen = () => {},
}) {
  /** @type {{ name: string, username: string, password: string }[]} */
  let items = [];
  let available = false;

  const clearFields = () => {
    nameInput.value = '';
    userInput.value = '';
    passInput.value = '';
    nameInput.removeAttribute('aria-invalid');
    passInput.removeAttribute('aria-invalid');
  };

  const isOpen = () => !panel.hidden;

  function open() {
    if (!available) return;
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    onOpen();
    nameInput.focus({ preventScroll: true });
  }

  function close({ focusButton = false } = {}) {
    if (panel.hidden) return;
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    clearFields();
    if (focusButton) button.focus({ preventScroll: true });
  }

  function add() {
    const name = nameInput.value.trim().replace(/\s+/g, ' ');
    const username = userInput.value;
    const password = passInput.value;
    if (!name) {
      nameInput.setAttribute('aria-invalid', 'true');
      nameInput.focus({ preventScroll: true });
      return false;
    }
    if (!username && !password) {
      passInput.setAttribute('aria-invalid', 'true');
      (userInput.value ? passInput : userInput).focus({ preventScroll: true });
      return false;
    }
    // Same name again replaces the earlier entry (the server keys them the same way).
    const key = name.toLowerCase();
    items = items.filter((item) => item.name.toLowerCase() !== key);
    if (items.length >= MAX_DETAILS) items.shift();
    items.push({ name, username, password });
    close();
    onChange();
    return true;
  }

  button.addEventListener('click', () => (isOpen() ? close() : open()));
  cancelButton.addEventListener('click', () => close({ focusButton: true }));
  panel.addEventListener('submit', (event) => {
    event.preventDefault();
    add();
  });
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close({ focusButton: true });
      return;
    }
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
    // Return moves down the card; on the password it adds.
    if (event.target === nameInput) {
      event.preventDefault();
      userInput.focus({ preventScroll: true });
    } else if (event.target === userInput) {
      event.preventDefault();
      passInput.focus({ preventScroll: true });
    }
  });
  for (const field of [nameInput, userInput, passInput]) {
    field.addEventListener('input', () => field.removeAttribute('aria-invalid'));
  }

  return {
    get items() {
      return items;
    },
    get available() {
      return available;
    },
    /** Shown only when the host worker can open what is sealed. */
    setAvailable(value) {
      available = Boolean(value);
      button.hidden = !available;
      if (!available) close();
    },
    /** Hand the details to a send; the composer forgets them. */
    take() {
      const taken = items;
      items = [];
      onChange();
      return taken;
    },
    /** A failed send gives them back (ahead of anything added meanwhile). */
    restore(list) {
      if (!list?.length) return;
      const names = new Set(items.map((item) => item.name.toLowerCase()));
      items = [...list.filter((item) => !names.has(item.name.toLowerCase())), ...items].slice(-MAX_DETAILS);
      onChange();
    },
    remove(index) {
      items = items.filter((_, i) => i !== index);
      onChange();
    },
    /** Another conversation: details typed for this one must not follow. */
    clear() {
      close();
      if (items.length === 0) return;
      items = [];
      onChange();
    },
    open,
    close,
    isOpen,
  };
}
