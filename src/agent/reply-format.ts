import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What piweb asks of a Pi agent's replies.
 *
 * Places on a map (2026-11-28, 「如果有偵測到地址，他就會 embedded google map
 * pin 著，如果有多個地址就一起 pin in same map」 then 「你可以用 system prompt
 * drive agent 回覆的時候要滿足某種特別的格式，他就會把多個地址包起來」): the
 * agent lists the places it named in a ```map block, and public/markdown.js
 * draws that block as one Google Map with a pin per line.
 *
 * Pi agents only (「Pi agent 就好」): Claude Code and agy sessions are not asked.
 * Pi gets it through the extension below; Pi's own --append-system-prompt would
 * replace ~/.pi/agent/APPEND_SYSTEM.md instead of adding to it.
 */
export const PLACE_MAP_GUIDANCE =
  'Places on a map: when your reply gives the address or location of physical places someone may go to ' +
  '(venues, shops, event sites, street addresses), end the reply with a fenced code block whose language is ' +
  '`map`, one place per line (up to 10), each written as you would search it in Google Maps: the full street ' +
  'address, or the place\'s full name with its city (for example "中埔穀倉農創園區 嘉義縣中埔鄉"). Piweb shows ' +
  'the block as one embedded Google Map with every line pinned on it. Keep naming the places in your text as ' +
  'usual; the block only adds the map. No physical place, no block.';

/**
 * The Pi extension that appends {@link PLACE_MAP_GUIDANCE} to the system
 * prompt. Loaded from this checkout's source (Pi compiles TypeScript
 * extensions itself), the same path from src/agent and from dist/agent.
 */
export const PI_REPLY_FORMAT_EXTENSION = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../pi-extensions/piweb-reply-format.ts',
);

/** What a Pi process is started with so its replies follow piweb's formats. */
export function piReplyFormatSpawn(): { args: string[]; env: Record<string, string> } {
  return {
    args: ['--extension', PI_REPLY_FORMAT_EXTENSION],
    env: { PIWEB_REPLY_GUIDANCE: PLACE_MAP_GUIDANCE },
  };
}
