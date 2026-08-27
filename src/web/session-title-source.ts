export const MAX_SESSION_TITLE_SOURCE_LENGTH = 8_000;

const PART_SEPARATOR = '\n\n';

/** Preserve an API-supplied title; only unnamed UI creation gets an auto-title job. */
export function resolveSessionCreationTitle(name: unknown): {
  name: string;
  prepareSessionTitle: boolean;
} {
  const explicitName = typeof name === 'string' ? name.trim() : '';
  return {
    name: explicitName || 'New session',
    prepareSessionTitle: !explicitName,
  };
}

/** Bound the source while reserving space for every present turn component. */
function fitSourceParts(parts: string[]): string {
  const combined = parts.join(PART_SEPARATOR);
  if (combined.length <= MAX_SESSION_TITLE_SOURCE_LENGTH) return combined;

  const separatorLength = PART_SEPARATOR.length * (parts.length - 1);
  let remaining = MAX_SESSION_TITLE_SOURCE_LENGTH - separatorLength;
  const budgets = Array<number>(parts.length).fill(0);
  let active = parts.map((_, index) => index);

  while (active.length > 0) {
    const share = Math.floor(remaining / active.length);
    const completed = active.filter((index) => parts[index].length <= share);
    if (completed.length === 0) {
      active.forEach((index, offset) => {
        budgets[index] = share + (offset < remaining % active.length ? 1 : 0);
      });
      break;
    }

    for (const index of completed) {
      budgets[index] = parts[index].length;
      remaining -= budgets[index];
    }
    const completedSet = new Set(completed);
    active = active.filter((index) => !completedSet.has(index));
  }

  return parts.map((part, index) => part.slice(0, budgets[index])).join(PART_SEPARATOR);
}

/** Build the bounded, dependency-free summary input for a session's first normal turn. */
export function buildSessionTitleSource(
  text: string,
  quote: string,
  attachmentNames: readonly string[],
): string {
  const names = attachmentNames.map((name) => name.trim()).filter(Boolean);
  const attachmentPart =
    attachmentNames.length === 0
      ? ''
      : names.length > 0
        ? `Attachments:\n${names.join('\n')}`
        : 'Attachment';
  const parts = [
    text.trim(),
    quote.trim() ? `Quoted context:\n${quote.trim()}` : '',
    attachmentPart,
  ].filter(Boolean);

  return fitSourceParts(parts);
}
