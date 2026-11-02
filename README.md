# claude-session-monitor

A live dashboard of all your local [Claude Code](https://claude.com/claude-code) sessions. See at a glance which sessions are working, which are idle, and — most importantly — which are **waiting on your input**. Click any session to jump straight to its terminal window.

Zero dependencies. One file. Node standard library only.

## Why

When you run several Claude Code sessions at once, it's easy to lose track of which one has stopped and is waiting for you to answer. This watches all of them and surfaces the ones that need you.

## Install

Run it without installing:

```sh
npx claude-code-session-monitor
```

Or install globally:

```sh
npm install -g claude-code-session-monitor
claude-session-monitor
```

(The global install provides both `claude-code-session-monitor` and the shorter `claude-session-monitor` command.)

Or clone and run:

```sh
git clone https://github.com/imabhinavagarwal/claude-session-monitor.git
cd claude-session-monitor
node session-monitor.js
```

## Usage

```sh
claude-session-monitor            # web dashboard at http://localhost:4317
claude-session-monitor --tui      # terminal UI in the current shell
claude-session-monitor --check    # self-test, then exit
```

The web dashboard:

- Groups sessions into **needs your input**, **running / idle**, and a collapsed **older idle** section.
- Shows a tab-title badge (e.g. `(2) Claude Sessions`) so you notice waiting sessions from another tab.
- Fires a desktop notification and a short beep when a session newly starts waiting on you (grant notification permission when prompted; the browser may keep the beep muted until you interact with the tab once).
- Lets you sort by most-recent activity or by project, and click a session to focus its window.
- Shows a banner if it loses contact with the local server instead of silently showing stale data.

## How status is determined

The monitor reads your local session transcripts under `~/.claude/projects/*.jsonl` and infers status from the last entry and the file's modification time, confirmed against live processes:

- **working** — active within the last 90 seconds.
- **needs input** — the last turn was Claude's and the session has gone quiet, i.e. it is waiting on you.
- **idle** — quiet for longer.

Only sessions touched in the last 24 hours are listed.

## Click-to-focus

Clicking a session tries to raise the exact terminal window it runs in. How precise this is depends on the terminal (macOS):

| Terminal | Behavior |
| --- | --- |
| [cmux](https://cmux.io) | Focuses the exact tab. Best experience — launch the monitor from inside cmux. |
| iTerm2 / Terminal.app | Focuses the exact tab (requires macOS Automation permission the first time). |
| Warp and others | Raises the app (no per-tab API available). |

## Privacy

Everything runs locally. The monitor reads your own session files on your machine and serves the dashboard on `localhost` only. It makes no outbound network requests and sends nothing anywhere.

## Requirements

- Node.js 18 or newer.
- Click-to-focus is macOS-only; the dashboard itself works anywhere Node runs.

## Feedback

Found a bug or have an idea? [Open an issue](https://github.com/imabhinavagarwal/claude-session-monitor/issues/new/choose) — bug reports and feature requests both have a quick template. For open-ended questions or ideas, use [Discussions](https://github.com/imabhinavagarwal/claude-session-monitor/discussions).

## License

[MIT](LICENSE) © Abhinav Agarwal
