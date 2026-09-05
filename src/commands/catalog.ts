/**
 * Command catalog — pure data, deliberately dependency-free.
 *
 * The web tier needs this for slash autocomplete and request validation, but it
 * must NOT pull in the implementations: those import the pi agent packages
 * (via model-catalog), which are peer deps that only exist on the host worker.
 * Importing runCommand from the web server made the container die at startup
 * with ERR_MODULE_NOT_FOUND for '@earendil-works/pi-coding-agent'.
 */

export interface CommandSpec {
  name: string;
  description: string;
  /** 'model' → autocomplete from pi's model list; 'thinking' → fixed levels; 'text'/'path' → free text */
  arg?: { name: string; kind: 'model' | 'thinking' | 'text' | 'path'; required: boolean };
}

export const COMMANDS: CommandSpec[] = [
  { name: 'pi status', description: 'Show model, thinking, cwd, session and token usage' },
  {
    name: 'pi model',
    description: 'Set the model for this session',
    arg: { name: 'model', kind: 'model', required: true },
  },
  { name: 'pi reset-model', description: "Reset to the gateway's default model" },
  {
    name: 'pi thinking',
    description: 'Set the thinking level',
    arg: { name: 'level', kind: 'thinking', required: true },
  },
  { name: 'pi new', description: 'Start a fresh pi session (archives the old one)' },
  { name: 'pi stop', description: 'Abort the current task while preserving the session and queue' },
  {
    name: 'pi cwd',
    description: 'Set the working directory override',
    arg: { name: 'path', kind: 'path', required: true },
  },
  { name: 'pi reset-cwd', description: "Reset to the gateway's default working directory" },
  { name: 'pi gpt-usage', description: 'Show ChatGPT/Codex rate-limit usage' },
  {
    name: 'until goal',
    description: 'Run an autonomous goal until done and verified',
    arg: { name: 'text', kind: 'text', required: true },
  },
  { name: 'until status', description: 'Ask pi to report progress on the current goal' },
  {
    name: 'until stop',
    description: 'Abort the current task while preserving the session and queue',
  },
  { name: 'gpt-usage', description: 'Show ChatGPT/Codex rate-limit usage' },
  { name: 'agy-usage', description: 'Show Antigravity (Gemini) quota usage' },
  {
    name: 'task cron',
    description: 'Schedule a recurring agent prompt: name | cron | prompt',
    arg: { name: 'text', kind: 'text', required: true },
  },
  { name: 'task list', description: 'List scheduled prompts for this session' },
  { name: 'kv status', description: 'Show KV cache status, active tokens, and snapshot table' },
  {
    name: 'kv save',
    description: 'Save current session KV snapshot (optional custom name)',
    arg: { name: 'name', kind: 'text', required: false },
  },
  {
    name: 'kv restore',
    description: 'Restore session or named snapshot',
    arg: { name: 'name', kind: 'text', required: false },
  },
  { name: 'kv prune', description: 'Enforce LRU session count and storage quotas' },
  { name: 'kv help', description: 'Show KV cache manager help' },
  {
    name: 'kv',
    description: 'Manage llama.cpp slot KV cache snapshots and lifecycle',
    arg: { name: 'args', kind: 'text', required: false },
  },
];
