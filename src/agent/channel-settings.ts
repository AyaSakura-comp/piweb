import { spawn } from 'node:child_process';
import { config } from '../config.js';
import {
  isThinkingLevel,
  listAvailableModels,
  resolveModelReference,
  resolveThinkingForModel,
  type AvailableModelInfo,
} from './model-catalog.js';
import { resolvePiSpawn } from './invoke.js';
import type { RegisteredChannel, ThinkingLevel } from '../types.js';

export interface EffectiveChannelSettings {
  rawModelRef: string;
  displayModel: string;
  modelInfo: AvailableModelInfo | undefined;
  modelSource: 'override' | 'default' | 'pi runtime default';
  requestedThinking: ThinkingLevel;
  effectiveThinking: ThinkingLevel;
  hasManagedThinking: boolean;
  thinkingSource: 'override' | 'default' | 'pi runtime default';
  thinkingAdjusted: boolean;
  thinkingAdjustmentMessage?: string;
  effectiveCwd: string;
  cwdSource: 'override' | 'default';
}

export interface PiRuntimeDefaults {
  modelRef: string;
  thinking: ThinkingLevel;
}

/**
 * Resolve a fresh Pi runtime snapshot without creating or continuing history.
 *
 * Life must not trust settings captured by its warm `--continue` process: the
 * configured Pi binary can register providers and alter defaults at startup.
 * This probe uses the same cwd, environment, configured model/thinking and
 * extra flags as a real turn, then asks that runtime for get_state over RPC.
 */
export async function probePiRuntimeDefaults(
  channel: Pick<RegisteredChannel, 'jid' | 'folder'>,
  options: {
    signal?: AbortSignal;
    /** Test override; production probes retain the 15-second limit. */
    timeoutMs?: number;
    /** Test override; production gives Pi one second to honor SIGTERM. */
    terminateGraceMs?: number;
  } = {},
): Promise<PiRuntimeDefaults> {
  if (options.signal?.aborted) throw new Error('Life runtime-default probe aborted');

  const args = ['--mode', 'rpc', '--no-session'];
  if (config.piModel) args.push('--model', config.piModel);
  if (config.piThinking) args.push('--thinking', config.piThinking);
  if (config.piExtraFlags) args.push(...config.piExtraFlags.split(/\s+/).filter(Boolean));

  const timeoutMs = options.timeoutMs ?? 15_000;
  const terminateGraceMs = options.terminateGraceMs ?? 1_000;
  const { bin, args: spawnArgs } = resolvePiSpawn(config.piBin, args);
  return new Promise<PiRuntimeDefaults>((resolve, reject) => {
    const proc = spawn(bin, spawnArgs, {
      cwd: config.piCwd,
      env: {
        ...process.env,
        PIWEB_CHANNEL_JID: channel.jid,
        PIWEB_CHANNEL_FOLDER: channel.folder,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let closed = false;
    let killTimer: NodeJS.Timeout | undefined;
    let outcome: { error?: Error; value?: PiRuntimeDefaults } | undefined;

    const onAbort = () => {
      const error = new Error('Life runtime-default probe aborted');
      // A valid response only becomes success after the child closes. Abort
      // retains ownership through that teardown window and overrides the
      // pending success without starting a second termination sequence.
      if (outcome && !outcome.error && !closed) {
        outcome = { error };
        return;
      }
      requestCompletion(error);
    };
    const timer = setTimeout(
      () => requestCompletion(new Error('Timed out while resolving Life runtime defaults from Pi')),
      timeoutMs,
    );
    timer.unref();

    function settleAfterClose(): void {
      if (!closed || !outcome) return;
      if (killTimer) clearTimeout(killTimer);
      if (outcome.error) reject(outcome.error);
      else resolve(outcome.value!);
    }

    function requestCompletion(error?: Error, value?: PiRuntimeDefaults): void {
      if (outcome) return;
      outcome = { error, value };
      clearTimeout(timer);

      if (proc.exitCode === null && proc.signalCode === null) {
        try {
          proc.kill('SIGTERM');
        } catch {
          // A concurrent exit is observed by `close` below.
        }
        killTimer = setTimeout(() => {
          if (proc.exitCode !== null || proc.signalCode !== null) return;
          try {
            proc.kill('SIGKILL');
          } catch {
            // A concurrent exit is observed by `close` below.
          }
        }, Math.max(0, terminateGraceMs));
        killTimer.unref();
      }
      settleAfterClose();
    }

    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      let newline: number;
      while ((newline = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;

        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (
          message.type !== 'response' ||
          message.command !== 'get_state' ||
          message.id !== 'life-defaults'
        ) {
          continue;
        }
        if (!message.success) {
          requestCompletion(new Error(message.error || 'Pi could not resolve Life runtime defaults'));
          return;
        }

        const provider = message.data?.model?.provider;
        const model = message.data?.model?.id;
        const thinking = message.data?.thinkingLevel;
        if (
          typeof provider !== 'string' ||
          !provider.trim() ||
          typeof model !== 'string' ||
          !model.trim() ||
          !isThinkingLevel(thinking)
        ) {
          requestCompletion(new Error('Pi returned no authenticated default model for Life'));
          return;
        }
        requestCompletion(undefined, { modelRef: `${provider}/${model}`, thinking });
        return;
      }
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    proc.stdin.on('error', (error) => requestCompletion(error));
    proc.on('error', (error) => requestCompletion(error));
    proc.on('close', (code, signal) => {
      closed = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (!outcome) {
        const detail = stderr.trim();
        outcome = {
          error: new Error(
            `Pi default probe exited with ${code ?? signal ?? 'unknown status'}${
              detail ? `: ${detail}` : ''
            }`,
          ),
        };
      }
      settleAfterClose();
    });

    if (!outcome) {
      proc.stdin.end(`${JSON.stringify({ id: 'life-defaults', type: 'get_state' })}\n`);
    }
  });
}

export function getDesiredThinkingLevel(channel: RegisteredChannel): ThinkingLevel {
  if (channel.thinkingOverride) return channel.thinkingOverride;
  if (config.piThinking && isThinkingLevel(config.piThinking)) return config.piThinking;
  return 'off';
}

export async function computeEffectiveChannelSettings(
  channel: RegisteredChannel,
  options: {
    forceRefresh?: boolean;
    lifeDefaults?: PiRuntimeDefaults;
    signal?: AbortSignal;
  } = {},
): Promise<EffectiveChannelSettings> {
  const models = listAvailableModels({ forceRefresh: options.forceRefresh ?? false });
  const lifeDefaults =
    channel.kind === 'life'
      ? (options.lifeDefaults ??
        (await probePiRuntimeDefaults(channel, { signal: options.signal })))
      : undefined;

  const rawModelRef =
    channel.kind === 'life'
      ? lifeDefaults!.modelRef
      : channel.modelOverride || config.piModel || '';
  const modelInfo = rawModelRef ? resolveModelReference(rawModelRef, models) : undefined;
  const hasManagedThinking =
    channel.kind === 'life' ||
    Boolean(channel.thinkingOverride) ||
    Boolean(config.piThinking && isThinkingLevel(config.piThinking));
  const desiredThinking =
    channel.kind === 'life' && !channel.thinkingOverride
      ? lifeDefaults!.thinking
      : getDesiredThinkingLevel(channel);
  // get_state already reports Pi's capability-clamped Life default. An explicit
  // Life override uses the same model-aware clamping as an ordinary session.
  const thinkingResolution =
    channel.kind === 'life' && !channel.thinkingOverride
      ? { requested: desiredThinking, effective: desiredThinking, adjusted: false }
      : resolveThinkingForModel(modelInfo, desiredThinking);
  const effectiveCwd = channel.kind === 'life' ? config.piCwd : channel.cwdOverride || config.piCwd;
  const cwdSource: EffectiveChannelSettings['cwdSource'] =
    channel.kind !== 'life' && channel.cwdOverride ? 'override' : 'default';

  let modelSource: EffectiveChannelSettings['modelSource'];
  if (channel.kind === 'life') modelSource = 'default';
  else if (channel.modelOverride) modelSource = 'override';
  else if (config.piModel) modelSource = 'default';
  else modelSource = 'pi runtime default';

  let thinkingSource: EffectiveChannelSettings['thinkingSource'];
  if (channel.thinkingOverride) thinkingSource = 'override';
  else if (channel.kind === 'life') thinkingSource = 'default';
  else if (config.piThinking && isThinkingLevel(config.piThinking)) thinkingSource = 'default';
  else thinkingSource = 'pi runtime default';

  return {
    rawModelRef,
    displayModel: modelInfo?.ref || rawModelRef || '(pi runtime default)',
    modelInfo,
    modelSource,
    requestedThinking: thinkingResolution.requested,
    effectiveThinking: thinkingResolution.effective,
    hasManagedThinking,
    thinkingSource,
    thinkingAdjusted: thinkingResolution.adjusted,
    thinkingAdjustmentMessage: thinkingResolution.adjusted
      ? buildThinkingAdjustmentMessage(
          thinkingResolution.requested,
          thinkingResolution.effective,
          modelInfo,
        )
      : undefined,
    effectiveCwd,
    cwdSource,
  };
}

export function buildThinkingAdjustmentMessage(
  requested: ThinkingLevel,
  effective: ThinkingLevel,
  model: AvailableModelInfo | undefined,
): string {
  if (!model) {
    return `Requested ${requested}, but the current model could not be resolved. Effective level is ${effective}.`;
  }
  if (!model.reasoning && requested !== 'off') {
    return `${model.ref} does not support reasoning, so thinking was reduced from ${requested} to off.`;
  }
  if (requested === 'xhigh' && effective === 'high') {
    return `${model.ref} does not support xhigh, so thinking was reduced from xhigh to high.`;
  }
  return `Thinking was adjusted from ${requested} to ${effective}.`;
}
