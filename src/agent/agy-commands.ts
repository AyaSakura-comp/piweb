export interface AgyCommand {
  id: string;
  command: string;
  taskId?: string;
  state: 'running' | 'returned' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  agent: 'not-observed' | 'output-received' | 'continued';
  output: string;
  exitCode?: number;
  nextAction?: string;
  startedAt: number;
  updatedAt: number;
}

/** Evidence-only projection: launch acknowledgement is not process completion. */
export function createAgyCommandTracker(turnId: string) {
  const commands = new Map<number, AgyCommand>();
  function consume(raw: any): AgyCommand[] {
    const step = raw?.step_update;
    if (raw?.event !== 'step_update' || !step) return [];
    const updates: AgyCommand[] = [];
    const now = Date.now();
    const name = step.tool_name || step.tool_info?.name;
    if (
      step.state === 'ACTIVE' &&
      (step.step_type === 'tool' || step.step_type === 'agent_response')
    ) {
      for (const command of commands.values()) {
        if (command.agent !== 'output-received') continue;
        command.agent = 'continued';
        command.nextAction = name || 'assistant response';
        command.updatedAt = now;
        updates.push({ ...command });
      }
    }
    if (step.step_type !== 'tool') return updates;
    if (name === 'run_command' && step.state === 'ACTIVE' && Number.isInteger(step.step_index)) {
      if (commands.has(step.step_index)) return updates;
      const command: AgyCommand = {
        id: `${turnId}:${step.step_index}`,
        command: String(step.tool_info?.parameters?.CommandLine || '(command unavailable)').slice(
          0,
          4000,
        ),
        state: 'running',
        agent: 'not-observed',
        output: '',
        startedAt: now,
        updatedAt: now,
      };
      commands.set(step.step_index, command);
      updates.push({ ...command });
    }
    if (step.state !== 'DONE') return updates;
    const output = step.tool_info?.output;
    if (typeof output !== 'string') return updates;
    let command = name === 'run_command' ? commands.get(step.step_index) : undefined;
    if (
      name === 'command_status' ||
      (name === 'manage_task' && step.tool_info?.parameters?.Action === 'status')
    ) {
      const params = Object.values(step.tool_info?.parameters || {});
      command = [...commands.values()].find((c) => c.taskId && params.includes(c.taskId));
    }
    if (!command) return updates;
    command.output = output.slice(-12000);
    command.updatedAt = now;
    const task = /(?:background task with task id:|Background command ID:)\s*([\w./-]+)/i.exec(
      output,
    )?.[1];
    // run_command stream output can be raw stdout; never interpret echoed prose
    // as the process exit code. Only status tools supply completion metadata.
    const statusHeader = output.split(/\n(?:Log output:|Output:|Stdout:)/)[0];
    const code =
      name !== 'run_command' ? /exited with code\s+(-?\d+)/i.exec(statusHeader)?.[1] : undefined;
    if (task) {
      command.taskId = task;
      command.state = 'running';
    } else if (name === 'manage_task' && /^Status: CANCELED\s*$/m.test(statusHeader)) {
      command.state = 'cancelled';
      command.agent = 'output-received';
    } else if (code !== undefined) {
      command.exitCode = Number(code);
      command.state = command.exitCode === 0 ? 'succeeded' : 'failed';
      command.agent = 'output-received';
    } else if (name === 'run_command') {
      command.state = 'returned';
      command.agent = 'output-received';
    }
    updates.push({ ...command });
    return updates;
  }
  function finish(): AgyCommand[] {
    return [...commands.values()]
      .filter((c) => c.state === 'running')
      .map((c) => {
        c.state = 'unknown';
        c.updatedAt = Date.now();
        return { ...c };
      });
  }
  function observeTranscript(rows: any[]): AgyCommand[] {
    const updates: AgyCommand[] = [];
    for (const row of rows) {
      const command = commands.get(row.step_index);
      if (!command || row.type !== 'GENERIC' || typeof row.content !== 'string') continue;
      const header = row.content.split(/\n(?:Output:|Stdout:)/)[0];
      const exit = /^The command exited with code (-?\d+)\./m.exec(header)?.[1];
      if (row.status === 'DONE' && exit !== undefined) {
        command.exitCode = Number(exit);
        command.state = command.exitCode === 0 ? 'succeeded' : 'failed';
        command.output = row.content.slice(-12000);
        command.updatedAt = Date.now();
        if (command.agent !== 'continued') command.agent = 'output-received';
        updates.push({...command});
        continue;
      }
      if (command.state !== 'running' || command.taskId) continue;
      const taskId = /background task with task id:\s*([\w-]+\/task-\d+)/i.exec(row.content)?.[1];
      if (!taskId) continue;
      command.taskId = taskId;
      command.output = row.content.slice(-12000);
      command.updatedAt = Date.now();
      updates.push({ ...command });
    }
    return updates;
  }
  function pending(): string[] {
    return [...commands.values()]
      .filter((c) => c.state === 'running' && c.taskId)
      .map((c) => c.taskId!);
  }
  return { consume, finish, observeTranscript, pending };
}
