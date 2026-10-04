# Claude Chat Viewer

Zero-dependency Node app that serves a single-page viewer for Claude Code
transcripts (`~/.claude/projects/<project>/<session>.jsonl`).

## Layout
- `server.js`: HTTP server plus JSON API (`/api/sessions`, `/api/search?q=`, `/api/session?id=<project>/<session>`). Summaries are cached by file mtime.
- `public/index.html`: the whole frontend (inline CSS and JS, no build step). Includes a small hand-written Markdown renderer.

## Conventions
- Keep it dependency-free; no bundler or framework.
- Session ids are `<project-dir>/<session-file-without-.jsonl>`; `sessionFile()` rejects path traversal. Keep that check when touching file access.
- All transcript text must go through `esc()` before being put in HTML.
- Subagent transcripts (`*/subagents/*.jsonl`) are intentionally not listed.

## Run / check
- `npm start` (default http://127.0.0.1:3456); `node --check server.js` for a syntax check.
