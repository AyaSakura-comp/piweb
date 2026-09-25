import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface ClaudeCommand {
  id: string;
  command: string;
  taskId?: string;
  outputFile?: string;
  role: 'claude-command';
  state: 'running' | 'returned' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  agent: 'not-observed' | 'output-received' | 'continued';
  output: string;
  exitCode?: number;
  nextAction?: string;
  timeoutMs?: number;
  startedAt: number;
  updatedAt: number;
}

export function readOutputTail(filePath: string, maxBytes = 12000): string {
  try {
    if (!existsSync(filePath)) return '';
    const stat = statSync(filePath);
    if (!stat.isFile()) return '';
    if (stat.size <= maxBytes) return readFileSync(filePath, 'utf8');
    const buffer = Buffer.alloc(maxBytes);
    const fd = openSync(filePath, 'r');
    try {
      readSync(fd, buffer, 0, maxBytes, stat.size - maxBytes);
      return buffer.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

export function findTaskOutputFile(sessionId: string, taskId: string, cwd?: string): string | undefined {
  const claudeTmp = '/tmp/claude-1000';
  if (!existsSync(claudeTmp)) return undefined;

  // 1. If cwd is specified, try the direct slug
  if (cwd) {
    const slug = cwd.replace(/\//g, '-');
    const direct = join(claudeTmp, slug, sessionId, 'tasks', `${taskId}.output`);
    if (existsSync(direct)) return direct;
  }

  // 2. Scan project folders in /tmp/claude-1000
  try {
    const entries = readdirSync(claudeTmp);
    for (const entry of entries) {
      const candidate = join(claudeTmp, entry, sessionId, 'tasks', `${taskId}.output`);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    /* ignore */
  }

  return undefined;
}

export function extractTaskNotificationXml(record: any): string | null {
  if (!record || typeof record !== 'object') return null;

  const msgContent = record.message?.content;
  if (typeof msgContent === 'string' && msgContent.includes('<task-notification>')) {
    return msgContent;
  }
  if (Array.isArray(msgContent)) {
    for (const part of msgContent) {
      if (typeof part === 'string' && part.includes('<task-notification>')) return part;
      if (typeof part?.text === 'string' && part.text.includes('<task-notification>')) return part.text;
    }
  }

  if (typeof record.content === 'string' && record.content.includes('<task-notification>')) {
    return record.content;
  }

  const attPrompt = record.attachment?.prompt;
  if (typeof attPrompt === 'string' && attPrompt.includes('<task-notification>')) {
    return attPrompt;
  }

  if (Array.isArray(record.rendered)) {
    for (const r of record.rendered) {
      if (typeof r?.content === 'string' && r.content.includes('<task-notification>')) {
        return r.content;
      }
    }
  }

  return null;
}

export function createClaudeCommandTracker(sessionId: string, options?: { cwd?: string }) {
  const commands = new Map<string, ClaudeCommand>();
  const pendingCalls = new Map<string, { name: string; input: any }>();

  function observe(record: any): ClaudeCommand[] {
    if (!record || typeof record !== 'object' || record.isSidechain) return [];
    const updates: ClaudeCommand[] = [];
    const now = Date.now();

    // 1. Assistant calls tool or produces response
    if (record.type === 'assistant') {
      const parts = Array.isArray(record.message?.content) ? record.message.content : [];
      for (const part of parts) {
        if (part?.type === 'tool_use' && part.id) {
          pendingCalls.set(part.id, { name: part.name, input: part.input || {} });
        }
      }
      for (const command of commands.values()) {
        if (command.agent === 'output-received') {
          command.agent = 'continued';
          command.nextAction = 'assistant response';
          command.updatedAt = now;
          updates.push({ ...command });
        }
      }
    }

    // 2. User tool results or task notifications
    if (record.type === 'user' || record.type === 'queue-operation' || record.type === 'attachment') {
      const parts = Array.isArray(record.message?.content) ? record.message.content : [];
      for (const part of parts) {
        if (part?.type === 'tool_result' && part.tool_use_id) {
          const call = pendingCalls.get(part.tool_use_id);
          const content = typeof part.content === 'string' ? part.content : '';
          const result = record.toolUseResult || {};

          // Check for Bash background task
          const bgTaskId =
            result.backgroundTaskId ||
            /Command running in background with ID:\s*([A-Za-z0-9_-]+)/i.exec(content)?.[1];
          const rawOutputFile =
            /Output is being written to:\s*([^\s,;]+)/i.exec(content)?.[1]?.replace(/[.,;]+$/, '');
          const outputFile =
            rawOutputFile ||
            (bgTaskId ? findTaskOutputFile(sessionId, bgTaskId, options?.cwd) : undefined);

          // Check for Monitor task
          const monitorTaskId =
            result.taskId ||
            /Monitor started \(task\s*([A-Za-z0-9_-]+)/i.exec(content)?.[1];

          const taskId = bgTaskId || monitorTaskId;
          if (taskId) {
            const commandText =
              call?.name === 'Monitor'
                ? (call?.input?.description || call?.input?.command || 'Monitor')
                : (call?.input?.command || call?.input?.description || (monitorTaskId ? `Monitor: ${call?.input?.command || 'watch'}` : 'Background task'));
            const fileTail = outputFile ? readOutputTail(outputFile) : '';
            const command: ClaudeCommand = {
              id: taskId,
              command: String(commandText).slice(0, 4000),
              taskId,
              outputFile: outputFile || (taskId ? findTaskOutputFile(sessionId, taskId, options?.cwd) : undefined),
              role: 'claude-command',
              state: 'running',
              agent: 'output-received',
              output: fileTail || content || 'Command running in background...',
              timeoutMs: call?.input?.timeout_ms,
              startedAt: now,
              updatedAt: now,
            };
            commands.set(taskId, command);
            updates.push({ ...command });
          }
        }
      }

      // Check for <task-notification>
      const xml = extractTaskNotificationXml(record);
      if (xml) {
        const taskId = /<task-id>([^<]+)<\/task-id>/i.exec(xml)?.[1];
        if (taskId) {
          let command = commands.get(taskId);
          if (!command) {
            const summary = /<summary>([\s\S]*?)<\/summary>/i.exec(xml)?.[1] || '';
            command = {
              id: taskId,
              command: summary || `Task ${taskId}`,
              taskId,
              role: 'claude-command',
              state: 'running',
              agent: 'output-received',
              output: '',
              startedAt: now,
              updatedAt: now,
            };
            commands.set(taskId, command);
          }

          const status = /<status>([^<]+)<\/status>/i.exec(xml)?.[1];
          const summary = /<summary>([\s\S]*?)<\/summary>/i.exec(xml)?.[1] || '';
          const outputFile =
            /<output-file>([^<]+)<\/output-file>/i.exec(xml)?.[1] ||
            command.outputFile ||
            findTaskOutputFile(sessionId, taskId, options?.cwd);
          const event = /<event>([\s\S]*?)<\/event>/i.exec(xml)?.[1];

          if (outputFile) command.outputFile = outputFile;
          const fileTail = outputFile ? readOutputTail(outputFile) : '';

          if (status === 'completed') {
            command.state = 'succeeded';
            const exitMatch = /exit code\s+(-?\d+)/i.exec(summary);
            if (exitMatch) command.exitCode = Number(exitMatch[1]);
            if (command.exitCode !== undefined && command.exitCode !== 0) {
              command.state = 'failed';
            }
            command.output = fileTail || summary || 'Completed';
          } else if (status === 'failed') {
            command.state = 'failed';
            command.output = fileTail || summary || 'Failed';
          } else if (status === 'stopped') {
            command.state = 'cancelled';
            command.output = fileTail || summary || 'Cancelled';
          } else if (event) {
            command.state = 'running';
            command.output = fileTail || (summary ? `${summary}\n${event}` : event);
          } else if (summary) {
            command.output = fileTail || summary;
          }

          command.agent = 'output-received';
          command.updatedAt = now;
          updates.push({ ...command });
        }
      }
    }

    return updates;
  }

  function pollActiveOutputs(): ClaudeCommand[] {
    const updates: ClaudeCommand[] = [];
    const now = Date.now();
    for (const command of commands.values()) {
      if (command.state !== 'running') continue;
      let file = command.outputFile;
      if (!file && command.taskId) {
        file = findTaskOutputFile(sessionId, command.taskId, options?.cwd);
        if (file) command.outputFile = file;
      }
      if (!file || !existsSync(file)) continue;
      const tail = readOutputTail(file);
      if (tail && tail !== command.output) {
        command.output = tail;
        command.updatedAt = now;
        updates.push({ ...command });
      }
    }
    return updates;
  }

  function getCommands(): ClaudeCommand[] {
    return [...commands.values()];
  }

  function finish(): ClaudeCommand[] {
    return [...commands.values()]
      .filter((c) => c.state === 'running')
      .map((c) => {
        c.state = 'unknown';
        c.updatedAt = Date.now();
        return { ...c };
      });
  }

  return {
    observe,
    pollActiveOutputs,
    getCommands,
    finish,
  };
}
