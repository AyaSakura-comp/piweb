const COPYABLE_CODE_SELECTOR = '#messages .msg-text code, #messages .event-body code';

/** Return the exact markdown code text activated inside the transcript. */
export function codeTextFromTarget(target) {
  const code = target?.closest?.(COPYABLE_CODE_SELECTOR);
  return code ? (code.textContent ?? '') : null;
}

/** Delegate one-tap copy handling so streamed and paged messages both work. */
export function bindCodeCopy(root, { copyText, onResult }) {
  root.addEventListener('click', async (event) => {
    if (event.target?.closest?.('a')) return;

    const text = codeTextFromTarget(event.target);
    const selection = root.getSelection?.()?.toString();
    if (text === null || selection) return;

    event.preventDefault();
    onResult(await copyText(text));
  });
}
