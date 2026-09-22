import { expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('../src/agent/agy-task-transcript.js', () => ({
  readAgyTaskTranscript: () => [
    {
      step_index: 2,
      type: 'GENERIC',
      status: 'RUNNING',
      content: 'background task with task id: parent/task-2',
    },
  ],
}));
const fake = vi.hoisted(() => ({ root: '' }));
vi.mock('../src/session/path.js', async (original) => ({
  ...(await original<typeof import('../src/session/path.js')>()),
  resolveChannelSessionDir: () => fake.root,
}));
it('keeps one CLI alive, reconciles only disclosed tasks, then returns a final result', async () => {
  fake.root = mkdtempSync(join(tmpdir(), 'agy-input-'));
  const executable = join(fake.root, 'agy');
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const rl=require('node:readline').createInterface({input:process.stdin});
const emit=x=>console.log(JSON.stringify(x));
const step=(index,name,state,output,parameters={})=>emit({event:'step_update',step_update:{step_index:index,step_type:'tool',tool_name:name,state,tool_info:{output,parameters}}});
let count=0;
emit({event:'init',conversation_id:'12345678-1234-1234-1234-123456789012'});
rl.on('line',line=>{
 const input=JSON.parse(line);
 if(input.event!=='user'||!input.message.content) process.exit(5);
 if(++count===1){step(2,'run_command','ACTIVE',undefined,{CommandLine:'original-once'});emit({event:'result',result:{status:'SUCCESS',response:'I will report later'}});}
 else {
 if(count>2||!input.message.content.includes('parent/task-2')||input.message.content.includes('original-once')) process.exit(6);
 step(4,'manage_task','DONE','Status: CANCELED\\nLog output: partial',{Action:'status',TaskId:'parent/task-2'});
 step(5,'view_file','ACTIVE','');
 emit({event:'result',result:{status:'SUCCESS',response:'Task cancelled; partial output reported.'}});
 }
});
`,
    { mode: 0o700 },
  );
  const { config } = await import('../src/config.js');
  const saved = config.agyBin;
  config.agyBin = executable;
  try {
    const { invokeAgy } = await import('../src/agent/agy.js');
    const events: any[] = [];
    const result = await invokeAgy('channel', 'Start original-once', {
      onEvent: (e) => {
        events.push(e);
      },
      isCurrent: () => true,
    });
    expect(result).toMatchObject({ ok: true, text: 'Task cancelled; partial output reported.' });
    const commands = events.filter((e) => e.type === 'agy_command_update').map((e) => e.command);
    expect(
      commands.filter(
        (c) => c.command === 'original-once' && c.agent === 'not-observed' && c.output === '',
      ),
    ).toHaveLength(1);
    expect(commands.at(-1)).toMatchObject({
      state: 'cancelled',
      agent: 'continued',
      nextAction: 'view_file',
    });
    const controller = new AbortController();
    controller.abort();
    expect(
      await invokeAgy('channel', 'must not launch', { signal: controller.signal }),
    ).toMatchObject({ aborted: true });
  } finally {
    config.agyBin = saved;
    rmSync(fake.root, { recursive: true, force: true });
  }
});
