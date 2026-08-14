import { afterEach, describe, expect, it } from 'vitest';

import { closeAllRpcSessions, getRpcSession } from '../src/agent/rpc-session.js';

afterEach(() => closeAllRpcSessions());

describe('persistent RPC session settings', () => {
  it('replaces an idle session when its per-session thinking level changes', () => {
    const low = getRpcSession('web_thinking', {
      model: 'local-llama/qwen3.6-35b-q4',
      thinking: 'low',
      cwd: '/tmp',
    });

    const high = getRpcSession('web_thinking', {
      model: 'local-llama/qwen3.6-35b-q4',
      thinking: 'high',
      cwd: '/tmp',
    });

    expect(high).not.toBe(low);
  });
});
