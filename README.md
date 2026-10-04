# Claude Chat Viewer

A local web app for browsing your Claude Code conversations. It automatically
discovers sessions in `~/.claude/projects`, with no dependencies and no uploads.

## Run

```sh
node server.js          # then open http://127.0.0.1:3456
# or
npm start
```

Requires Node 16+.

## Options

| Flag | Env var | Default |
| --- | --- | --- |
| `--dir <path>` | `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` (honors `CLAUDE_CONFIG_DIR`) |
| `--port <n>` | `PORT` | `3456` |
| `--host <addr>` | | `127.0.0.1` |

## Features

- Sessions grouped by project, newest first, with titles taken from the first prompt
- Full-text search across all sessions (matches are highlighted)
- Collapsible tool calls, tool results and thinking blocks, with show/hide toggles
- Subagent messages indented, context summaries shown inline
- Light/dark theme, Reload button to pick up new sessions

## Privacy

The server binds to localhost by default and serves only `.jsonl` files under the
projects directory. Transcripts can contain secrets, so think twice before using
`--host 0.0.0.0`.
