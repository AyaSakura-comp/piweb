import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PI_REPLY_FORMAT_EXTENSION, PLACE_MAP_GUIDANCE, piReplyFormatSpawn } from '../src/agent/reply-format.js';

// The user, 2026-11-28: 「你可以用 system prompt drive agent 回覆的時候要滿足某種
// 特別的格式，他就會把多個地址包起來」, then 「Pi agent 就好」. Pi sessions are told
// to list a reply's places in a ```map block (the web UI pins them on one Google
// Map). This runs the real Pi CLI against a scripted model and reads the system
// prompt Pi sent: the guidance is there, once, after the user's own
// ~/.pi/agent/APPEND_SYSTEM.md, which Pi's --append-system-prompt would have
// replaced.

const PI_BIN = [process.env.PIWEB_TEST_PI_BIN, resolve(homedir(), 'src/pi-agent/packages/coding-agent/dist/cli.js')].find(
  (path): path is string => Boolean(path && existsSync(path)),
);
const USER_APPEND = 'Owner rule 7731: answer in Traditional Chinese.';

const tempDirs: string[] = [];
const servers: Server[] = [];
const originalEnv = { ...process.env };
afterEach(async () => {
  await (await import('../src/agent/rpc-session.js')).closeAllRpcSessions();
  vi.resetModules();
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An OpenAI-compatible endpoint that answers every request with `text` and keeps the bodies. */
async function scriptedModel(text: string) {
  const bodies: any[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      bodies.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: unknown, finish: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({ id: `c${bodies.length}`, object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      chunk({ role: 'assistant', content: text });
      chunk({}, 'stop');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { port: (server.address() as { port: number }).port, bodies };
}

/** A Pi agent dir on the scripted model, with the owner's own APPEND_SYSTEM.md. */
function agentHome(port: number) {
  const root = mkdtempSync(join(tmpdir(), 'piweb-pi-format-'));
  tempDirs.push(root);
  const agentDir = join(root, 'agent');
  mkdirSync(agentDir);
  writeFileSync(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        fake: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: 'openai-completions',
          apiKey: 'not-needed',
          models: [{ id: 'fake-model', name: 'Fake', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1000 }],
        },
      },
    }),
  );
  writeFileSync(join(agentDir, 'settings.json'), '{}');
  writeFileSync(join(agentDir, 'APPEND_SYSTEM.md'), USER_APPEND);
  return { root, agentDir };
}

const systemPromptOf = (body: any): string =>
  body.messages.find((message: any) => message.role === 'system' || message.role === 'developer')?.content ?? '';
const count = (text: string, part: string) => text.split(part).length - 1;

function runPi(args: string[], env: Record<string, string>, cwd: string): Promise<string> {
  return new Promise((done) => {
    const proc = spawn(process.execPath, [PI_BIN!, ...args], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => proc.kill('SIGKILL'), 60_000);
    proc.on('exit', () => {
      clearTimeout(timer);
      done(out);
    });
  });
}

describe.skipIf(!PI_BIN)('piweb-reply-format inside a real Pi session', () => {
  it('adds the map guidance after the owner\'s APPEND_SYSTEM.md, and nothing without piweb', async () => {
    const model = await scriptedModel('ok');
    const { root, agentDir } = agentHome(model.port);
    const spawnWith = piReplyFormatSpawn();
    const base = ['--no-session', '--model', 'fake/fake-model', '--no-extensions', '--no-skills', '--no-prompt-templates'];
    const env = { PI_CODING_AGENT_DIR: agentDir, PI_SKIP_VERSION_CHECK: '1' };

    expect(await runPi([...base, ...spawnWith.args, '-p', 'Where is the market?'], { ...env, ...spawnWith.env }, root)).toContain('ok');
    // Pi started outside piweb: the extension is loaded but has nothing to add.
    expect(await runPi([...base, ...spawnWith.args, '-p', 'Where is the market?'], env, root)).toContain('ok');

    const [withPiweb, without] = model.bodies.map(systemPromptOf);
    expect(withPiweb).toContain(USER_APPEND);
    expect(count(withPiweb, PLACE_MAP_GUIDANCE)).toBe(1);
    expect(withPiweb.indexOf(PLACE_MAP_GUIDANCE)).toBeGreaterThan(withPiweb.indexOf(USER_APPEND));
    expect(without).toContain(USER_APPEND);
    expect(without).not.toContain(PLACE_MAP_GUIDANCE);
  }, 90_000);

  it('reaches every turn of a piweb RPC session, once each', async () => {
    const model = await scriptedModel('好');
    const { root, agentDir } = agentHome(model.port);
    Object.assign(process.env, {
      PI_BIN,
      PI_CWD: root,
      SESSIONS_DIR: join(root, 'sessions'),
      PI_CODING_AGENT_DIR: agentDir,
      PI_SKIP_VERSION_CHECK: '1',
    });
    vi.resetModules();
    const rpc = await import('../src/agent/rpc-session.js');
    const session = rpc.getRpcSession('web_map', { model: 'fake/fake-model', cwd: root });
    await session.prompt('這週末台南有什麼市集？');
    await session.prompt('那嘉義呢？');

    expect(model.bodies).toHaveLength(2);
    for (const body of model.bodies) {
      const system = systemPromptOf(body);
      expect(system).toContain(USER_APPEND);
      expect(count(system, PLACE_MAP_GUIDANCE)).toBe(1);
    }
    expect(PI_REPLY_FORMAT_EXTENSION).toMatch(/pi-extensions\/piweb-reply-format\.ts$/);
  }, 90_000);
});
