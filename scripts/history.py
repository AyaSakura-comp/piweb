#!/usr/bin/env python3
"""
Query piweb conversation history.

Two stores, and they answer different questions (see README):
  * web_events  — what the UI shows: user turns, pi replies, thinking, tool
                  calls, command output. This is what you usually want.
  * sessions/*.jsonl — pi's own session format, i.e. what the agent actually
                  remembers. Use `context` for that.

Uses only the stdlib (this host has no sqlite3 CLI), and opens the database
read-only so it can never disturb the running worker.

  history.py sessions                    list sessions
  history.py show <name|jid> [-n 50]     print a transcript
  history.py search <text> [--kind ...]  search across all sessions
  history.py context <name|jid>          pi's own session file (raw JSONL)
  history.py stats                       row counts / disk usage
"""

import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path

DATA = Path(os.environ.get("PIWEB_DATA", Path.home() / ".local/share/piweb"))
DB = Path(os.environ.get("DB_PATH", DATA / "gateway.db"))
SESSIONS = Path(os.environ.get("SESSIONS_DIR", DATA / "sessions"))

KIND_MARK = {
    "message": "",
    "thinking": "[thinking]",
    "tool": "[tool]",
    "tool_result": "[result]",
    "system": "[system]",
    "error": "[error]",
}


def connect() -> sqlite3.Connection:
    if not DB.exists():
        sys.exit(f"database not found: {DB}")
    # Read-only URI: querying must never interfere with the live worker, and a
    # stray write here could corrupt an in-flight run.
    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def resolve_jid(conn: sqlite3.Connection, needle: str) -> str:
    """Accept a jid, a bare id, or a (partial, case-insensitive) session name."""
    rows = conn.execute("select jid, name from channels").fetchall()
    for row in rows:
        if needle in (row["jid"], row["jid"].removeprefix("web:")):
            return row["jid"]
    matches = [r for r in rows if needle.lower() in r["name"].lower()]
    if len(matches) == 1:
        return matches[0]["jid"]
    if not matches:
        sys.exit(f"no session matching {needle!r} (try: history.py sessions)")
    names = ", ".join(f"{m['name']} ({m['jid']})" for m in matches)
    sys.exit(f"{needle!r} is ambiguous: {names}")


def cmd_sessions(args, conn):
    rows = conn.execute(
        """
        select c.jid, c.name, c.folder, c.created_at,
               (select count(*) from web_events e where e.channel_jid = c.jid) as events,
               (select max(created_at) from web_events e where e.channel_jid = c.jid) as last
          from channels c order by c.created_at
        """
    ).fetchall()
    if not rows:
        print("no sessions")
        return
    print(f"{'NAME':<24} {'JID':<16} {'EVENTS':>6}  LAST ACTIVITY")
    for r in rows:
        print(f"{r['name'][:24]:<24} {r['jid']:<16} {r['events']:>6}  {r['last'] or '-'}")


def cmd_show(args, conn):
    jid = resolve_jid(conn, args.session)
    rows = conn.execute(
        "select * from web_events where channel_jid = ? order by rowid desc limit ?",
        (jid, args.n),
    ).fetchall()
    for r in reversed(rows):
        render(r, full=args.full)


def cmd_search(args, conn):
    sql = "select * from web_events where content like ?"
    params: list = [f"%{args.text}%"]
    if args.kind:
        sql += f" and kind in ({','.join('?' * len(args.kind))})"
        params += args.kind
    if args.session:
        sql += " and channel_jid = ?"
        params.append(resolve_jid(conn, args.session))
    sql += " order by rowid desc limit ?"
    params.append(args.n)

    rows = conn.execute(sql, params).fetchall()
    names = {r["jid"]: r["name"] for r in conn.execute("select jid, name from channels")}
    if not rows:
        print("no matches")
        return
    for r in reversed(rows):
        print(f"── {names.get(r['channel_jid'], r['channel_jid'])} ─ {r['created_at']}")
        render(r, full=args.full)


def cmd_context(args, conn):
    jid = resolve_jid(conn, args.session)
    folder = conn.execute("select folder from channels where jid = ?", (jid,)).fetchone()["folder"]
    directory = SESSIONS / folder
    if not directory.exists():
        sys.exit(f"no pi session on disk yet for {jid} ({directory})")

    files = sorted(directory.glob("*.jsonl"))
    if not files:
        sys.exit(f"no .jsonl under {directory}")
    latest = files[-1]
    print(f"# {latest}", file=sys.stderr)

    for line in latest.read_text().splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if args.raw:
            print(line)
            continue
        kind = event.get("type", "?")
        if kind != "message":
            print(f"({kind})")
            continue

        # The turn is nested under "message"; content is a list of typed parts
        # (text / thinking / toolCall / toolResult), not a plain string.
        message = event.get("message", {})
        role = message.get("role", "?")
        parts = message.get("content", [])
        if isinstance(parts, str):
            parts = [{"type": "text", "text": parts}]

        rendered = []
        for part in parts:
            if not isinstance(part, dict):
                continue
            ptype = part.get("type", "")
            if ptype == "text":
                rendered.append(part.get("text", ""))
            elif ptype == "thinking":
                rendered.append(f"<thinking> {part.get('thinking') or part.get('text') or ''}")
            elif ptype in ("toolCall", "tool_call"):
                call = part.get("toolCall", part)
                rendered.append(f"<tool {call.get('name', '?')}> {json.dumps(call.get('arguments'))[:200]}")
            elif ptype in ("toolResult", "tool_result"):
                inner = part.get("content")
                if isinstance(inner, list):
                    inner = " ".join(p.get("text", "") for p in inner if isinstance(p, dict))
                rendered.append(f"<result> {str(inner)[:200]}")
            else:
                rendered.append(f"<{ptype}>")

        body = " ".join(s.strip() for s in rendered if s).strip()
        print(f"[{role}] {body[:400] if not args.full else body}")


def cmd_stats(args, conn):
    for table in ("channels", "web_events", "message_log", "message_queue", "control_queue"):
        try:
            count = conn.execute(f"select count(*) from {table}").fetchone()[0]
            print(f"{count:>7}  {table}")
        except sqlite3.Error:
            pass
    print()
    for path in (DB, DB.with_name(DB.name + "-wal"), SESSIONS):
        if path.is_dir():
            size = sum(f.stat().st_size for f in path.rglob("*") if f.is_file())
        elif path.exists():
            size = path.stat().st_size
        else:
            continue
        print(f"{size/1024:>7.0f}K  {path}")


def render(row, full=False):
    mark = KIND_MARK.get(row["kind"], row["kind"])
    who = row["role"] or row["kind"]
    text = row["content"] if full else row["content"][:500]
    if not full and len(row["content"]) > 500:
        text += " …"
    stamp = row["created_at"][11:16]
    print(f"{stamp} {mark}{'' if not mark else ' '}{who}: {text}")
    if row["files"]:
        print(f"        files: {', '.join(json.loads(row['files']))}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("sessions", help="list sessions")

    show = sub.add_parser("show", help="print a transcript")
    show.add_argument("session")
    show.add_argument("-n", type=int, default=50, help="last N events (default 50)")
    show.add_argument("--full", action="store_true", help="do not truncate")

    search = sub.add_parser("search", help="search across history")
    search.add_argument("text")
    search.add_argument("-n", type=int, default=30)
    search.add_argument("--session")
    search.add_argument("--kind", nargs="+", choices=list(KIND_MARK))
    search.add_argument("--full", action="store_true")

    context = sub.add_parser("context", help="pi's own session file")
    context.add_argument("session")
    context.add_argument("--raw", action="store_true", help="emit raw JSONL")
    context.add_argument("--full", action="store_true", help="do not truncate")

    sub.add_parser("stats", help="row counts and disk usage")

    args = parser.parse_args()
    with connect() as conn:
        {"sessions": cmd_sessions, "show": cmd_show, "search": cmd_search,
         "context": cmd_context, "stats": cmd_stats}[args.cmd](args, conn)


if __name__ == "__main__":
    main()
