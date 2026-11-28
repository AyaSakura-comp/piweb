/**
 * piweb's reply formats inside a Pi session.
 *
 * piweb starts every Pi process with `--extension <this file>` and
 * PIWEB_REPLY_GUIDANCE holding what it asks of replies (src/agent/reply-format.ts:
 * list the places a reply names in a ```map block, which the web UI draws as one
 * Google Map). This appends that text to the system prompt of each agent run.
 *
 * Not Pi's --append-system-prompt: that flag replaces the user's
 * ~/.pi/agent/APPEND_SYSTEM.md instead of adding to it.
 *
 * No PIWEB_REPLY_GUIDANCE (Pi started outside piweb): the extension does nothing.
 */

// Pi's ExtensionAPI, narrowed to what this file uses (no import from Pi, so
// the file loads with whichever Pi build PI_BIN points at).
interface Api {
  on(
    event: 'before_agent_start',
    handler: (event: { systemPrompt: string }) => { systemPrompt: string } | undefined,
  ): void;
}

export default function piwebReplyFormat(pi: Api): void {
  const guidance = process.env.PIWEB_REPLY_GUIDANCE?.trim();
  if (!guidance) return;

  pi.on('before_agent_start', (event) => {
    if (event.systemPrompt.includes(guidance)) return undefined;
    return { systemPrompt: `${event.systemPrompt.trimEnd()}\n\n${guidance}` };
  });
}
