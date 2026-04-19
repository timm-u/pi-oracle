# pi-oracle

Oracle advisor extension for [pi coding agent](https://github.com/badlogic/pi-mono).

It adds an `oracle` tool that the main agent can call when it wants a second, high-reasoning engineering opinion for code reviews, architecture decisions, tricky debugging, implementation plans, and trade-off analysis.

The Oracle runs in an isolated nested `pi --mode json --no-session` process. It is advisory only: it can read/search local files and consult the web, but it does not edit files or run shell commands.

## Prerequisites

- pi `0.67.68` or newer
- A working model in pi for the nested Oracle
- Optional: [OpenAI Codex CLI](https://github.com/openai/codex) for higher-quality nested web search

By default, the Oracle uses:

```text
openai-codex/gpt-5.4
```

If that model is not available in your pi setup, set `PI_ORACLE_MODEL` to another model that works in your install.

## Installation

### Option 1: Git package (recommended)

```bash
pi install git:github.com/timm-u/pi-oracle
```

Or add it directly to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "git:github.com/timm-u/pi-oracle"
  ]
}
```

Restart pi, or run:

```text
/reload
```

On startup, pi should list the extension as:

```text
timm-u/pi-oracle
```

### Option 2: Clone locally

```bash
git clone https://github.com/timm-u/pi-oracle.git ~/.pi/agent/extensions/pi-oracle
```

Then restart pi or run `/reload`.

### Option 3: Load directly for testing

```bash
pi -e /path/to/pi-oracle
```

## Usage

Ask naturally:

```text
Use the oracle to review this plan before I implement it.
```

```text
Ask the oracle why this streaming hook fails on reconnect. Look at src/chat/stream.ts and src/chat/stream.test.ts.
```

```text
Get an oracle opinion on whether this should be polling or webhooks.
```

The main agent can also call the tool directly:

```json
{
  "task": "Review the authentication architecture and suggest the simplest safe improvement.",
  "context": "We need backwards compatibility and want to avoid a big migration.",
  "files": ["src/auth/index.ts", "src/auth/jwt.ts"]
}
```

## What the Oracle Can Do

- Read specific files you pass to it
- Use read-only local tools: `read`, `grep`, `find`, and `ls`
- Search or read the web through nested tools
- Search and read local pi session history with `find_thread` and `read_thread`
- Return focused advice, plans, reviews, and trade-offs to the main agent

## What It Should Not Do

- Simple file reads or searches the main agent can do directly
- Routine web lookups the main agent can do directly
- Bulk code execution
- Direct code edits

## Configuration

Set environment variables before starting pi.

### Bash / zsh

```bash
export PI_ORACLE_MODEL="openai-codex/gpt-5.4"
export PI_ORACLE_THINKING="high"
```

### PowerShell

```powershell
$env:PI_ORACLE_MODEL = "openai-codex/gpt-5.4"
$env:PI_ORACLE_THINKING = "high"
```

Available settings:

| Variable | Default | Description |
| --- | --- | --- |
| `PI_ORACLE_MODEL` | `openai-codex/gpt-5.4` | Nested pi model used by the Oracle |
| `PI_ORACLE_THINKING` | `high` | Nested pi thinking level |
| `PI_ORACLE_TOOLS` | `read,grep,find,ls` | Read-only tools available to the Oracle |
| `PI_ORACLE_WEB_BACKEND` | `auto` | `auto`, `codex`, or `duckduckgo` |
| `PI_ORACLE_CODEX_SEARCH_MODEL` | `gpt-5.4-mini` | Model used by Codex CLI web search |
| `PI_ORACLE_CODEX_SEARCH_TIMEOUT_MS` | `120000` | Codex CLI web search timeout |

`PI_ORACLE_WEB_BACKEND=auto` tries Codex CLI first and falls back to the DuckDuckGo HTML parser. Use `codex` to require Codex-backed search, or `duckduckgo` to force the parser.

## Troubleshooting

### Extension does not show on startup

Run:

```bash
pi list
```

Confirm `git:github.com/timm-u/pi-oracle` appears in the installed packages. If you added it manually, confirm `~/.pi/agent/settings.json` contains:

```json
{
  "packages": [
    "git:github.com/timm-u/pi-oracle"
  ]
}
```

Then restart pi or run `/reload`.

### Oracle model is not found

Check that the configured model works in pi:

```bash
pi --model openai-codex/gpt-5.4 "say ok"
```

If it does not, choose another available model:

```bash
export PI_ORACLE_MODEL="openai-codex/gpt-5.4-mini"
```

### Duplicate `oracle` tool

If you previously copied the extension into `~/.pi/agent/extensions/oracle`, remove that local copy or disable it in settings:

```json
{
  "extensions": [
    "-extensions/oracle/index.ts"
  ]
}
```

Keep the Git package installed through `packages` so startup shows `timm-u/pi-oracle`.

### Web search falls back to DuckDuckGo

That is expected when Codex CLI is unavailable or fails. To force the fallback:

```bash
export PI_ORACLE_WEB_BACKEND="duckduckgo"
```

## Development

```bash
git clone https://github.com/timm-u/pi-oracle.git
cd pi-oracle
npm install
npm run check
pi -e .
```

## License

MIT
