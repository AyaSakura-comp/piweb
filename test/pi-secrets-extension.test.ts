import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PI_SECRETS_EXTENSION } from '../src/agent/secret-handoff.js';

// The user's worry, 2026-11-12: 「只是我不確定 pi agent 那邊該怎麼處理因為他那邊
// jsonl 應該也會放類似的東西…」. This runs the real Pi CLI with piweb's extension
// against a scripted model, and reads what Pi wrote to its session file and what
// it sent to the model. Made-up details only.

const USERNAME = 'octo-user-7731';
const PASSWORD = `pa$$ w0rd"q'x-9182`;

const PI_BIN = [process.env.PIWEB_TEST_PI_BIN, resolve(homedir(), 'src/pi-agent/packages/coding-agent/dist/cli.js')].find(
  (path): path is string => Boolean(path && existsSync(path)),
);

const tempDirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Turn = { toolCalls?: Array<{ name: string; args: Record<string, unknown> }>; text?: string };

/** An OpenAI-compatible chat endpoint that plays `turns` in order and keeps every request body. */
async function scriptedModel(turns: Turn[]) {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      bodies.push(body);
      const turn = turns[Math.min(bodies.length - 1, turns.length - 1)];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: unknown, finish: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({
            id: `c${bodies.length}`,
            object: 'chat.completion.chunk',
            created: 0,
            model: 'fake-model',
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`,
        );
      if (turn.toolCalls) {
        chunk({
          role: 'assistant',
          content: null,
          tool_calls: turn.toolCalls.map((call, index) => ({
            index,
            id: `call_${bodies.length}_${index}`,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        });
        chunk({}, 'tool_calls');
      } else {
        chunk({ role: 'assistant', content: turn.text ?? 'done' });
        chunk({}, 'stop');
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { port: (server.address() as { port: number }).port, bodies };
}

function runPi(args: string[], env: Record<string, string>, cwd: string): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    const proc = spawn(process.execPath, [PI_BIN!, ...args], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => proc.kill('SIGKILL'), 60_000);
    proc.on('exit', (code) => {
      clearTimeout(timer);
      done({ code, out });
    });
  });
}

describe.skipIf(!PI_BIN)('piweb-secrets inside a real Pi session', () => {
  it('lets tools use the details while Pi stores and sends only their names', async () => {
    const root = mkdtempSync(join(tmpdir(), 'piweb-pi-secrets-'));
    tempDirs.push(root);
    const work = join(root, 'work');
    const agentDir = join(root, 'agent');
    const sessionDir = join(root, 'sessions');
    mkdirSync(work);
    mkdirSync(agentDir);
    const secretsFile = join(root, 'runtime.json');
    writeFileSync(
      secretsFile,
      JSON.stringify({ version: 1, secrets: [{ name: 'GitHub', base: 'PIWEB_SECRET_GITHUB', username: USERNAME, password: PASSWORD }] }),
      { mode: 0o600 },
    );

    const model = await scriptedModel([
      {
        toolCalls: [
          // bash: the shell expands the names, the command keeps them.
          {
            name: 'bash',
            args: {
              command:
                'printf "%s\\n%s" "$PIWEB_SECRET_GITHUB_USER" "$PIWEB_SECRET_GITHUB_PASS" > bash-out.txt && cat bash-out.txt',
            },
          },
          // another tool: the name is filled in when it runs.
          { name: 'write', args: { path: 'form.txt', content: 'user=${PIWEB_SECRET_GITHUB_USER} pass=$PIWEB_SECRET_GITHUB_PASS' } },
        ],
      },
      // reading the file back: the result is scrubbed before Pi keeps it.
      { toolCalls: [{ name: 'read', args: { path: 'form.txt' } }] },
      { text: 'Logged in.' },
    ]);
    writeFileSync(
      join(agentDir, 'models.json'),
      JSON.stringify({
        providers: {
          fake: {
            baseUrl: `http://127.0.0.1:${model.port}/v1`,
            api: 'openai-completions',
            apiKey: 'not-needed',
            models: [{ id: 'fake-model', name: 'Fake', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1000 }],
          },
        },
      }),
    );
    writeFileSync(join(agentDir, 'settings.json'), '{}');

    const run = await runPi(
      [
        '--session-dir', sessionDir,
        '--model', 'fake/fake-model',
        '--no-extensions', '--no-skills', '--no-prompt-templates',
        '--extension', PI_SECRETS_EXTENSION,
        '-p', 'Log in to GitHub with $PIWEB_SECRET_GITHUB_USER / $PIWEB_SECRET_GITHUB_PASS.',
      ],
      { PI_CODING_AGENT_DIR: agentDir, PIWEB_SECRETS_FILE: secretsFile, PI_SKIP_VERSION_CHECK: '1' },
      work,
    );
    expect(run.out).toContain('Logged in.');
    expect(model.bodies).toHaveLength(3);

    // The tools really got the values...
    expect(readFileSync(join(work, 'bash-out.txt'), 'utf8')).toBe(`${USERNAME}\n${PASSWORD}`);
    expect(readFileSync(join(work, 'form.txt'), 'utf8')).toBe(`user=${USERNAME} pass=${PASSWORD}`);

    // ...but Pi's session file holds only the names...
    const files = readdirSync(sessionDir).filter((name) => name.endsWith('.jsonl'));
    expect(files).toHaveLength(1);
    const jsonl = readFileSync(join(sessionDir, files[0]), 'utf8');
    const forms = (value: string) => [value, JSON.stringify(value).slice(1, -1)];
    for (const value of [...forms(USERNAME), ...forms(PASSWORD)]) expect(jsonl.includes(value), value).toBe(false);
    expect(jsonl).toContain('$PIWEB_SECRET_GITHUB_PASS');
    expect(jsonl).toContain('${PIWEB_SECRET_GITHUB_USER}');

    // ...and so did everything sent to the model, tool results included.
    for (const body of model.bodies)
      for (const value of [...forms(USERNAME), ...forms(PASSWORD)]) expect(body.includes(value), value).toBe(false);
    expect(model.bodies[1]).toContain('$PIWEB_SECRET_GITHUB_USER\\n$PIWEB_SECRET_GITHUB_PASS');
    expect(model.bodies[2]).toContain('user=$PIWEB_SECRET_GITHUB_USER pass=$PIWEB_SECRET_GITHUB_PASS');
  }, 90_000);

  it('leaves names in any other tool, which reads the values from the environment itself (like browser_intent)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'piweb-pi-secrets-'));
    tempDirs.push(root);
    const agentDir = join(root, 'agent');
    mkdirSync(agentDir);
    // A directory named like the account: `ls` would list it if the name were filled in.
    mkdirSync(join(root, USERNAME));
    writeFileSync(join(root, USERNAME, 'inside.txt'), 'x');
    const secretsFile = join(root, 'runtime.json');
    writeFileSync(
      secretsFile,
      JSON.stringify({ version: 1, secrets: [{ name: 'GitHub', base: 'PIWEB_SECRET_GITHUB', username: USERNAME, password: PASSWORD }] }),
      { mode: 0o600 },
    );
    const model = await scriptedModel([
      {
        toolCalls: [
          { name: 'probe', args: { goal: 'log in with $PIWEB_SECRET_GITHUB_USER / $PIWEB_SECRET_GITHUB_PASS' } },
          { name: 'ls', args: { path: '${PIWEB_SECRET_GITHUB_USER}' } },
        ],
      },
      { text: 'ok' },
    ]);
    writeFileSync(
      join(agentDir, 'models.json'),
      JSON.stringify({
        providers: {
          fake: {
            baseUrl: `http://127.0.0.1:${model.port}/v1`,
            api: 'openai-completions',
            apiKey: 'not-needed',
            models: [{ id: 'fake-model', name: 'Fake', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1000 }],
          },
        },
      }),
    );
    writeFileSync(join(agentDir, 'settings.json'), '{}');
    const run = await runPi(
      [
        '--no-session', '--model', 'fake/fake-model', '--no-extensions', '--no-skills', '--no-prompt-templates',
        '--tools', 'read,bash,edit,write,ls,probe',
        '--extension', PI_SECRETS_EXTENSION,
        '--extension', resolve(import.meta.dirname, 'fixtures/pi-probe-extension.ts'),
        '-p', 'x',
      ],
      { PI_CODING_AGENT_DIR: agentDir, PIWEB_SECRETS_FILE: secretsFile, PI_SKIP_VERSION_CHECK: '1' },
      root,
    );
    expect(run.out).toContain('ok');
    const results = model.bodies[1];
    // The tool got the names, and found the value in the environment.
    expect(results).toContain(`kept-names=true env=set:${PASSWORD.length}`);
    expect(results).toContain('Path not found');
    expect(results).not.toContain('inside.txt');
    expect(results).not.toContain(USERNAME);
  }, 90_000);

  it('keeps what it read when the file goes between turns (a turn Pi starts by itself)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'piweb-pi-secrets-'));
    tempDirs.push(root);
    const agentDir = join(root, 'agent');
    mkdirSync(agentDir);
    const secretsFile = join(root, 'runtime.json');
    writeFileSync(
      secretsFile,
      JSON.stringify({ version: 1, secrets: [{ name: 'GitHub', base: 'PIWEB_SECRET_GITHUB', username: USERNAME, password: PASSWORD }] }),
      { mode: 0o600 },
    );
    const model = await scriptedModel([
      // The worker removes the file when its turn ends; here the tool does it.
      { toolCalls: [{ name: 'bash', args: { command: 'rm "$PIWEB_SECRETS_FILE" && echo removed' } }] },
      { toolCalls: [{ name: 'bash', args: { command: 'printf "%s" "$PIWEB_SECRET_GITHUB_USER" > later.txt && cat later.txt' } }] },
      { text: 'ok' },
    ]);
    writeFileSync(
      join(agentDir, 'models.json'),
      JSON.stringify({
        providers: {
          fake: {
            baseUrl: `http://127.0.0.1:${model.port}/v1`,
            api: 'openai-completions',
            apiKey: 'not-needed',
            models: [{ id: 'fake-model', name: 'Fake', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1000 }],
          },
        },
      }),
    );
    writeFileSync(join(agentDir, 'settings.json'), '{}');
    const run = await runPi(
      ['--no-session', '--model', 'fake/fake-model', '--no-extensions', '--no-skills', '--no-prompt-templates', '--extension', PI_SECRETS_EXTENSION, '-p', 'x'],
      { PI_CODING_AGENT_DIR: agentDir, PIWEB_SECRETS_FILE: secretsFile, PI_SKIP_VERSION_CHECK: '1' },
      root,
    );
    expect(run.out).toContain('ok');
    expect(existsSync(secretsFile)).toBe(false);
    expect(readFileSync(join(root, 'later.txt'), 'utf8')).toBe(USERNAME);
    expect(model.bodies[2]).toContain('$PIWEB_SECRET_GITHUB_USER');
    expect(model.bodies[2]).not.toContain(USERNAME);
  }, 90_000);

  it('does nothing without a details file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'piweb-pi-secrets-'));
    tempDirs.push(root);
    const agentDir = join(root, 'agent');
    mkdirSync(agentDir);
    const model = await scriptedModel([{ toolCalls: [{ name: 'bash', args: { command: 'printf "[%s]" "$PIWEB_SECRET_GITHUB_PASS"' } }] }, { text: 'ok' }]);
    writeFileSync(
      join(agentDir, 'models.json'),
      JSON.stringify({
        providers: {
          fake: {
            baseUrl: `http://127.0.0.1:${model.port}/v1`,
            api: 'openai-completions',
            apiKey: 'not-needed',
            models: [{ id: 'fake-model', name: 'Fake', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1000 }],
          },
        },
      }),
    );
    writeFileSync(join(agentDir, 'settings.json'), '{}');
    const run = await runPi(
      ['--no-session', '--model', 'fake/fake-model', '--no-extensions', '--no-skills', '--no-prompt-templates', '--extension', PI_SECRETS_EXTENSION, '-p', 'x'],
      { PI_CODING_AGENT_DIR: agentDir, PIWEB_SECRETS_FILE: join(root, 'missing.json'), PI_SKIP_VERSION_CHECK: '1' },
      root,
    );
    expect(run.out).toContain('ok');
    expect(model.bodies[1]).toContain('[]');
  }, 90_000);
});
