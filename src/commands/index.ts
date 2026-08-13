/**
 * Command implementations, ported from piscord's Discord slash commands.
 *
 * These are transport-agnostic: each takes a channel + parsed args and returns
 * text. piscord's versions were welded to `ChatInputCommandInteraction` (reply/
 * deferReply/editReply), which is why this is a port rather than a re-export.
 *
 * They run in the WORKER process, not the web server: `/pi status` spawns pi
 * over RPC for token stats, `/pi stop` needs the worker's in-memory
 * AbortController, `/pi new` must not race an in-flight run, and `/gpt-usage`
 * reads the host's pi OAuth credentials. The web server enqueues intents into control_queue
 * and the worker calls these.
 */

import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as pathResolve } from 'node:path';
import {
  getChannelSessionStatus,
  UNTIL_DONE_MARKER,
  type ChannelSessionStatus,
  type SessionContextUsage,
  type SessionTokenUsage,
} from '../agent/invoke.js';
import {
  clearChannelCwdOverride,
  clearChannelModelOverride,
  clearChannelThinkingOverride,
  clearPendingMessages,
  enqueueMessage,
  getChannel,
  setChannelCwdOverride,
  setChannelModelOverride,
  setChannelThinkingOverride,
} from '../db.js';
import { logger } from '../logger.js';
import {
  isThinkingLevel,
  listAvailableModels,
  resolveModelReference,
  resolveThinkingForModel,
} from '../agent/model-catalog.js';
import {
  buildThinkingAdjustmentMessage,
  computeEffectiveChannelSettings,
  getDesiredThinkingLevel,
  type EffectiveChannelSettings,
} from '../agent/channel-settings.js';
import { abortChannelTask, isChannelProcessing } from '../agent/queue.js';
import { rotateChannelSessionDir } from '../session/path.js';
import type { RegisteredChannel } from '../types.js';
import { getGptUsageText } from '../gpt-usage.js';

export interface CommandResult {
  ok: boolean;
  text: string;
}

export { COMMANDS, type CommandSpec } from './catalog.js';

/**
 * Execute a command for a channel.
 *
 * `command` is the space-joined name from COMMANDS ("pi model"); `args` carries
 * the single argument that command takes, if any.
 */
export async function runCommand(
  channel: RegisteredChannel,
  command: string,
  args: Record<string, string> = {},
): Promise<CommandResult> {
  try {
    switch (command) {
      case 'pi status':
        return await cmdStatus(channel);
      case 'pi model':
        return cmdModelSet(channel, args.model ?? '');
      case 'pi reset-model':
        return cmdModelReset(channel);
      case 'pi thinking':
        return cmdThinkingSet(channel, args.level ?? '');
      case 'pi new':
        return cmdNew(channel, args);
      case 'pi stop':
      case 'until stop':
        return cmdStop(channel);
      case 'pi cwd':
        return cmdCwdSet(channel, args.path ?? '');
      case 'pi reset-cwd':
        return cmdCwdReset(channel);
      case 'pi gpt-usage':
      case 'gpt-usage':
        return await cmdGptUsage();
      case 'until goal':
        return cmdUntilGoal(channel, args.text ?? '');
      case 'until status':
        return cmdUntilStatus(channel);
      default:
        return { ok: false, text: `Unknown command: ${command}` };
    }
  } catch (err: any) {
    logger.error({ err: err.message, command }, 'Command failed');
    return { ok: false, text: `⚠️ ${err.message}` };
  }
}

// ── session lifecycle ──

function cmdNew(channel: RegisteredChannel, args: Record<string, string> = {}): CommandResult {
  // Rotating the session directory under a live run would strand the pi
  // subprocess writing into an archived path, so refuse rather than corrupt it.
  if (isChannelProcessing(channel.jid)) {
    return {
      ok: false,
      text: 'This session is currently processing a message. Stop it or wait, then run `/pi new` again.',
    };
  }

  // The `pi new` auto-issued when a session is created must NOT clear the
  // queue. A brand-new session has nothing legitimate to discard, and a message
  // sent in the moments before the control loop picks it up would be silently
  // deleted — the user sees their message vanish with no reply and no error.
  // An explicit /pi new still clears, which is the point of it.
  const cleared = args.keepQueue === 'true' ? 0 : clearPendingMessages(channel.jid);
  const archivedSession = rotateChannelSessionDir(channel.folder);

  logger.info(
    { jid: channel.jid, cleared, archived: Boolean(archivedSession) },
    'Channel session reset',
  );

  const notes = ['Started a fresh pi session.'];
  if (cleared > 0) {
    notes.push(`Cleared ${cleared} queued ${cleared === 1 ? 'message' : 'messages'}.`);
  }
  if (archivedSession) {
    notes.push('Archived the previous session on disk.');
  }

  return { ok: true, text: notes.join(' ') };
}

function cmdStop(channel: RegisteredChannel): CommandResult {
  const result = abortChannelTask(channel.jid);

  if (!result.aborted && result.cleared === 0) {
    return { ok: true, text: 'No active task or queued messages in this session.' };
  }

  const notes: string[] = [];
  if (result.aborted) notes.push('Aborted the current task.');
  if (result.cleared > 0) {
    notes.push(`Cleared ${result.cleared} queued ${result.cleared === 1 ? 'message' : 'messages'}.`);
  }

  return { ok: true, text: notes.join(' ') };
}

// ── until-done ──

function cmdUntilGoal(channel: RegisteredChannel, goalRaw: string): CommandResult {
  const goal = goalRaw.trim();
  if (!goal) return { ok: false, text: 'Please provide a goal.' };

  enqueueMessage({
    channelJid: channel.jid,
    sender: 'web',
    senderName: 'web',
    content: `${UNTIL_DONE_MARKER}${goal}`,
    timestamp: new Date().toISOString(),
  });

  return {
    ok: true,
    text: `🎯 Started an until-done goal:\n> ${goal}\n\npi will work autonomously and report back when it's done and verified. Use \`/until stop\` to abort.`,
  };
}

function cmdUntilStatus(channel: RegisteredChannel): CommandResult {
  enqueueMessage({
    channelJid: channel.jid,
    sender: 'web',
    senderName: 'web',
    content:
      'Report the current pi-until-done goal status: the goal, which tasks are done vs. remaining, ' +
      'and the latest verifyCommand result. If there is no active goal, say so briefly.',
    timestamp: new Date().toISOString(),
  });

  return { ok: true, text: '📊 Asked pi to report the current until-done status.' };
}

// ── model / thinking / cwd ──

function cmdModelSet(channel: RegisteredChannel, selectedRef: string): CommandResult {
  if (!selectedRef.trim()) return { ok: false, text: 'Please choose a model.' };

  const models = listAvailableModels({ forceRefresh: true });
  const selectedModel = resolveModelReference(selectedRef, models);
  if (!selectedModel) {
    return { ok: false, text: `Model is no longer available: ${selectedRef}` };
  }

  setChannelModelOverride(channel.jid, selectedModel.ref);

  const updated = getChannel(channel.jid)!;
  const desiredThinking = getDesiredThinkingLevel(updated);
  const thinkingResolution = resolveThinkingForModel(selectedModel, desiredThinking);

  // Only persist the clamped value if the channel already had an explicit override.
  if (updated.thinkingOverride) {
    setChannelThinkingOverride(updated.jid, thinkingResolution.effective);
  }

  const notes = [`Model set to ${selectedModel.ref}.`];
  if (thinkingResolution.adjusted) {
    notes.push(
      buildThinkingAdjustmentMessage(
        thinkingResolution.requested,
        thinkingResolution.effective,
        selectedModel,
      ),
    );
  }

  return { ok: true, text: notes.join('\n') };
}

function cmdModelReset(channel: RegisteredChannel): CommandResult {
  clearChannelModelOverride(channel.jid);

  const updated = getChannel(channel.jid)!;
  const effective = computeEffectiveChannelSettings(updated, { forceRefresh: true });
  const notes = ['Model reset to the gateway default.'];

  if (updated.thinkingOverride && effective.thinkingAdjusted) {
    setChannelThinkingOverride(updated.jid, effective.effectiveThinking);
  }

  if (effective.thinkingAdjusted) {
    const currentThinking = effective.hasManagedThinking
      ? effective.effectiveThinking
      : '(pi runtime default)';
    notes.push(`Current effective thinking is ${currentThinking}. ${effective.thinkingAdjustmentMessage}`);
  }

  return { ok: true, text: notes.join('\n') };
}

function cmdThinkingSet(channel: RegisteredChannel, rawLevel: string): CommandResult {
  if (!isThinkingLevel(rawLevel)) {
    return { ok: false, text: `Invalid thinking level: ${rawLevel}` };
  }

  const effective = computeEffectiveChannelSettings(channel, { forceRefresh: true });
  const resolution = resolveThinkingForModel(effective.modelInfo, rawLevel);

  setChannelThinkingOverride(channel.jid, resolution.effective);

  const notes = [`Thinking level set to ${resolution.effective}.`];
  if (resolution.adjusted) {
    notes.push(
      buildThinkingAdjustmentMessage(resolution.requested, resolution.effective, effective.modelInfo),
    );
  }

  return { ok: true, text: notes.join('\n') };
}

function cmdCwdSet(channel: RegisteredChannel, selectedPath: string): CommandResult {
  const raw = selectedPath.trim();
  if (!raw) return { ok: false, text: 'Please provide a path.' };

  let resolvedPath: string;
  if (raw === '~') {
    resolvedPath = homedir();
  } else if (raw.startsWith('~/')) {
    resolvedPath = pathResolve(homedir(), raw.slice(2));
  } else {
    resolvedPath = pathResolve(raw);
  }

  let pathExists = false;
  try {
    pathExists = existsSync(resolvedPath) && statSync(resolvedPath).isDirectory();
  } catch {
    // treated as "does not exist" below
  }

  setChannelCwdOverride(channel.jid, resolvedPath);

  const notes = [`Working directory set to ${resolvedPath}.`];
  if (!pathExists) {
    notes.push('⚠️ That path does not currently exist (or is not a directory) on the host.');
  }

  return { ok: true, text: notes.join('\n') };
}

function cmdCwdReset(channel: RegisteredChannel): CommandResult {
  clearChannelCwdOverride(channel.jid);
  return { ok: true, text: 'Working directory reset to the gateway default.' };
}

export function cmdThinkingReset(channel: RegisteredChannel): CommandResult {
  clearChannelThinkingOverride(channel.jid);
  return { ok: true, text: 'Thinking level reset to the gateway default.' };
}

// ── status ──

async function cmdStatus(channel: RegisteredChannel): Promise<CommandResult> {
  const effective = computeEffectiveChannelSettings(channel);
  const sessionStatus = await getChannelSessionStatus(channel.folder, effective.effectiveCwd);
  return { ok: true, text: buildStatusMessage(effective, sessionStatus) };
}

async function cmdGptUsage(): Promise<CommandResult> {
  try {
    const output = await getGptUsageText();
    return { ok: true, text: '```text\n' + output.trim() + '\n```' };
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed to check gpt-usage');
    return { ok: false, text: `⚠️ Failed to get GPT usage status: ${err.message}` };
  }
}

function buildStatusMessage(
  effective: EffectiveChannelSettings,
  sessionStatus: ChannelSessionStatus,
): string {
  const rows: Array<[string, string]> = [
    ['Model', formatModelValue(effective)],
    ['Thinking', formatThinkingValue(effective)],
    ['Working dir', formatWorkingDirValue(effective)],
  ];

  if (effective.thinkingAdjusted) {
    rows.push(['Fallback', formatThinkingFallback(effective)]);
  }

  rows.push(
    ['Reasoning', effective.modelInfo ? (effective.modelInfo.reasoning ? 'yes' : 'no') : 'unknown'],
    [
      'Session',
      sessionStatus.createdAt ? formatSessionCreatedAt(sessionStatus.createdAt) : 'not started',
    ],
    ['Tokens', formatTokenUsage(sessionStatus.tokens, sessionStatus.statsSource)],
    ['Context', formatContextUsage(sessionStatus.contextUsage)],
  );

  return '```text\n' + formatTwoColumnRows(rows) + '\n```';
}

function formatModelValue(effective: EffectiveChannelSettings): string {
  if (effective.modelSource === 'pi runtime default') return 'pi runtime default';
  return `${effective.displayModel} (${formatSettingSource(effective.modelSource)})`;
}

function formatThinkingValue(effective: EffectiveChannelSettings): string {
  if (!effective.hasManagedThinking || effective.thinkingSource === 'pi runtime default') {
    return 'pi runtime default';
  }
  return `${effective.effectiveThinking} (${formatSettingSource(effective.thinkingSource)})`;
}

function formatThinkingFallback(effective: EffectiveChannelSettings): string {
  if (effective.modelInfo && !effective.modelInfo.reasoning && effective.requestedThinking !== 'off') {
    return `${effective.requestedThinking} -> off (no reasoning)`;
  }
  if (effective.requestedThinking === 'xhigh' && effective.effectiveThinking === 'high') {
    return 'xhigh -> high (unsupported)';
  }
  return `${effective.requestedThinking} -> ${effective.effectiveThinking}`;
}

function formatWorkingDirValue(effective: EffectiveChannelSettings): string {
  return `${effective.effectiveCwd} (${effective.cwdSource === 'override' ? 'session' : 'gateway'})`;
}

function formatSettingSource(source: EffectiveChannelSettings['modelSource']): string {
  switch (source) {
    case 'override':
      return 'session';
    case 'default':
      return 'gateway';
    case 'pi runtime default':
      return 'pi';
  }
}

function formatSessionCreatedAt(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

function formatTokenUsage(
  tokens: SessionTokenUsage | undefined,
  statsSource: ChannelSessionStatus['statsSource'],
): string {
  if (!tokens) return statsSource === 'none' ? '0 total' : '?';

  const cache = tokens.cacheRead + tokens.cacheWrite;
  const details = [`${formatNumber(tokens.input)} in`, `${formatNumber(tokens.output)} out`];
  if (cache > 0) details.push(`${formatNumber(cache)} cache`);

  const showDetails = tokens.input > 0 || tokens.output > 0 || cache > 0;
  return `${formatNumber(tokens.total)} total${showDetails ? ` (${details.join(' / ')})` : ''}`;
}

function formatContextUsage(contextUsage: SessionContextUsage | undefined): string {
  if (!contextUsage) return '?';
  const tokens = contextUsage.tokens == null ? '?' : formatNumber(contextUsage.tokens);
  const window = contextUsage.contextWindow == null ? '?' : formatNumber(contextUsage.contextWindow);
  const percent = contextUsage.percent == null ? '?' : `${formatPercent(contextUsage.percent)}%`;
  return `${tokens} / ${window} (${percent})`;
}

function formatTwoColumnRows(rows: Array<[string, string]>): string {
  const width = rows.reduce((max, [label]) => Math.max(max, label.length), 0);
  return rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join('\n');
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value);
}
