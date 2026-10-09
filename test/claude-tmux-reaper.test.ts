import { describe, expect, it } from 'vitest';
import { reapOrphanClaudeTmuxSessions } from '../src/agent/claude-tmux-reaper.js';
import { tmuxSessionName } from '../src/agent/claude-tmux.js';

const OWNER = '/data/gateway.db';

function fakeTmux(sessions: Array<[string, string?]>) {
  const calls: string[][] = [];
  const live = new Map(sessions.map(([name, owner]) => [name, owner ?? '']));
  return {
    calls,
    live,
    tmux: async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'list-sessions') {
        if (live.size === 0) throw new Error('no server running');
        return [...live].map(([name, owner]) => `${name}\t${owner}`).join('\n') + '\n';
      }
      const name = args[2].replace(/^=/, '').replace(/:$/, '');
      if (!live.has(name)) throw new Error(`can't find session: ${name}`);
      if (args[0] === 'kill-session') live.delete(name);
      if (args[0] === 'set-option') live.set(name, args[4]);
      return '';
    },
  };
}

describe('Claude tmux reaper', () => {
  const active = tmuxSessionName('web_active');
  const trashed = tmuxSessionName('web_trashed');
  const purged = tmuxSessionName('web_purged');
  const foreign = tmuxSessionName('web_other_instance');

  it('closes trashed and purged sessions and keeps active ones', async () => {
    const tmux = fakeTmux([
      [active],
      [trashed],
      [purged, OWNER],
      [foreign, '/tmp/live-test/gateway.db'],
      [tmuxSessionName('web_never_seen')],
      ['claude'],
      ['31'],
    ]);
    const closed = await reapOrphanClaudeTmuxSessions({
      tmux: tmux.tmux,
      owner: OWNER,
      channels: () => [
        { folder: 'web_active' },
        { folder: 'web_trashed', deletedAt: '2026-10-09 12:00:00' },
      ],
    });

    expect(closed.sort()).toEqual([purged, trashed].sort());
    expect([...tmux.live.keys()].sort()).toEqual(
      [active, foreign, tmuxSessionName('web_never_seen'), 'claude', '31'].sort(),
    );
    // Active sessions are stamped so they are still recognised after a purge.
    expect(tmux.live.get(active)).toBe(OWNER);
    // Other instances' and non-Piweb sessions are never touched.
    expect(tmux.calls.filter((c) => c[0] !== 'list-sessions').map((c) => c[2])).not.toContain('=claude');
  });

  it('a stamped session is reaped once its channel row disappears', async () => {
    const tmux = fakeTmux([[active]]);
    let channels = [{ folder: 'web_active' }];
    const deps = { tmux: tmux.tmux, owner: OWNER, channels: () => channels };

    expect(await reapOrphanClaudeTmuxSessions(deps)).toEqual([]);
    channels = [];
    expect(await reapOrphanClaudeTmuxSessions(deps)).toEqual([active]);
  });

  it('is a no-op without a tmux server', async () => {
    const tmux = fakeTmux([]);
    const closed = await reapOrphanClaudeTmuxSessions({
      tmux: tmux.tmux,
      owner: OWNER,
      channels: () => {
        throw new Error('must not query channels');
      },
    });
    expect(closed).toEqual([]);
  });
});
