# Configuration Reference

DevSpace can be configured through `devspace init`, persisted config files, or
environment variables.

The default files are:

```text
~/.devspace/config.json
~/.devspace/auth.json
```

Use another config directory with:

```bash
DEVSPACE_CONFIG_DIR=/path/to/config npx @waishnav/devspace serve
```

## Commands

```bash
npx @waishnav/devspace init
npx @waishnav/devspace serve
npx @waishnav/devspace doctor
npx @waishnav/devspace config get
npx @waishnav/devspace config set publicBaseUrl https://devspace.example.com
```

## Core Environment Variables

| Variable | Purpose |
| --- | --- |
| `HOST` | Local bind host. Defaults to `127.0.0.1`. |
| `PORT` | Local port. Defaults to `7676`. |
| `DEVSPACE_ALLOWED_ROOTS` | Comma-separated local roots that workspaces may open. |
| `DEVSPACE_PUBLIC_BASE_URL` | Public origin for the server, without `/mcp`. |
| `DEVSPACE_ALLOWED_HOSTS` | Optional Host header allowlist override. |
| `DEVSPACE_OAUTH_OWNER_TOKEN` | Owner password for OAuth approval. Must be at least 16 characters. |
| `DEVSPACE_WORKTREE_ROOT` | Directory for managed Git worktrees. Defaults to `~/.devspace/worktrees`. |
| `DEVSPACE_STATE_DIR` | Directory for SQLite state. Defaults to `~/.local/share/devspace`. |
| `DEVSPACE_MCP_SESSION_IDLE_TIMEOUT_SECONDS` | Close abandoned MCP sessions after this idle period. Defaults to `1800`. |
| `DEVSPACE_MCP_MAX_SESSIONS` | Maximum retained MCP sessions. Defaults to `128`; least-recently-used sessions close first. |
| `DEVSPACE_PASEO_URL` | Optional Paseo daemon WebSocket endpoint. When set, newly created managed worktrees are registered as external Paseo workspaces. |
| `DEVSPACE_PASEO_PASSWORD` | Optional Paseo daemon password. Keep this in the environment or `auth.json`, not `config.json`. |
| `DEVSPACE_PASEO_TIMEOUT_SECONDS` | Paseo connect and workspace API timeout. Defaults to `15`. |

The same lifecycle settings may be persisted in `~/.devspace/config.json` as
`mcpSessionIdleTimeoutSeconds` and `mcpMaxSessions`. Active requests refresh a
session's idle timestamp. These limits bound clients that reconnect or
initialize frequently without closing their old transports.

## Paseo Workspace Integration

Set a Paseo daemon endpoint to mirror DevSpace-managed worktrees into Paseo:

```bash
DEVSPACE_PASEO_URL="ws://127.0.0.1:6767/ws" \
npx @waishnav/devspace serve
```

Bare `host:port`, HTTP, HTTPS, WS, and WSS endpoints are accepted; an omitted
path becomes `/ws`. The equivalent persisted settings are `paseoUrl` and
`paseoTimeoutSeconds` in `~/.devspace/config.json`, with `paseoPassword` in
`~/.devspace/auth.json`.

After creating a managed worktree, DevSpace calls the Paseo WebSocket API and
registers the exact directory as an external workspace. Registration is
path-idempotent: if Paseo already has an active workspace for the same real
path, DevSpace reuses it. Paseo therefore displays and watches the worktree but
does not claim ownership of its directory. A Paseo outage is returned as a
warning and does not make `open_workspace` fail.

`archive_workspace` is an explicit completion operation for managed worktrees.
It marks the DevSpace workspace inactive and archives the linked Paseo
workspace, while preserving the Git worktree directory and all files. It
refuses to run while a tracked process session is active. Do not call it at the
end of an ordinary turn; use it only when the user explicitly asks to close or
archive the workspace.

## Native Artifact Download

Native-file download is disabled by default. Enable it when ChatGPT needs to hand
an attached or generated file into an already-open workspace:

```bash
DEVSPACE_ARTIFACTS=1 npx @waishnav/devspace serve
```

This feature currently supports Linux. It is not registered on macOS, Windows,
or BSD because the secure publication path depends on traversable,
descriptor-anchored directory paths provided by Linux procfs.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEVSPACE_ARTIFACTS` | `0` | Expose `download_artifact` for trusted native files. |
| `DEVSPACE_ARTIFACT_MAX_FILE_BYTES` | `104857600` | Maximum streamed size of one file (100 MiB). |

The same settings may be persisted in `~/.devspace/config.json` as
`artifactsEnabled` and `artifactMaxFileBytes`.

`download_artifact` accepts the native file object supplied by the MCP connector,
a `workspaceId` returned by `open_workspace`, and a relative workspace `path`.
DevSpace safely creates missing parent directories, refuses to overwrite an
existing destination, and returns only the normalized workspace-relative path.
It does not accept conflict modes, expected hashes, arbitrary URL strings, local
paths, embedded credentials, or extra object fields.

There is no artifact root, total quota, TTL, pinning, persistent database record,
or background artifact cleanup service. See [Native File Download](artifact-exchange.md)
for the supported connector shape and security boundaries.

## OAuth

DevSpace uses a single-user OAuth approval flow.

| Variable | Default |
| --- | --- |
| `DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` |
| `DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000` |
| `DEVSPACE_OAUTH_SCOPES` | `devspace` |
| `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` | `chatgpt.com,oauth-redirect.googleusercontent.com,oauth-redirect-sandbox.googleusercontent.com,localhost,127.0.0.1` |

MCP clients discover metadata from:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
```

Gemini Spark's current account-linking client may send its JSON dynamic client
registration request to the issuer root with a non-JSON media type instead of
using the advertised registration endpoint. DevSpace recognizes that narrow
`OpenAuth` request shape, normalizes it as an RFC 7591 JSON request, and routes
it to the same standard registration handler.

## Tool Modes

`DEVSPACE_TOOL_MODE` controls the tool surface.

| Value | Behavior |
| --- | --- |
| `minimal` | Default. Exposes `open_workspace`, `read`, `write`, `edit`, `bash`, `exec_command`, `process_status`, and `write_stdin`. Clients use `bash` with tools such as `rg`, `find`, and `ls` for quick inspection. |
| `full` | Exposes the minimal tools plus dedicated `grep`, `glob`, and `ls` tools. |
| `codex` | Experimental. Exposes `open_workspace`, `read`, `apply_patch`, `exec_command`, `process_status`, and `write_stdin`. Existing mutation and shell tools are hidden. |

`DEVSPACE_MINIMAL_TOOLS` remains a backward-compatible alias when
`DEVSPACE_TOOL_MODE` is unset: `1` selects `minimal` and `0` selects `full`.
The `codex` mode must be selected through `DEVSPACE_TOOL_MODE` and always uses
its fixed short tool names regardless of `DEVSPACE_TOOL_NAMING`.

Tracked commands run without a PTY by default. Set `tty: true` on
`exec_command` for interactive terminal programs. PTY support uses the optional
`node-pty` dependency; `write_stdin` can send input, poll output, and resize PTY
sessions.

Use `bash` only for quick foreground commands. Use `exec_command` for tests,
builds, reviews, package scripts, and commands with uncertain duration. Every
tracked command returns a stable `sessionId`. Commands still running after the
short server-controlled handoff continue independently; polling is not needed
to keep them alive. Use `write_stdin` only to wait briefly, send input, resize a
PTY, or interrupt a live process.

Use `process_status` as the read path. Omit `sessionId` to list recent processes
for a workspace after a host interruption or lost tool result; provide one to
read its retained transcript and final status. Production servers persist final
results for up to seven days, bounded to the latest 50 completed processes per
workspace. A process that was running when DevSpace stopped is retained as
`interrupted`, never inferred to have completed successfully.

As a transport safeguard, ordinary `bash` calls use the same tracked process
lifecycle internally. A command that is still running after about two seconds
returns its `sessionId` instead of holding one MCP request open and continues in
the server. The `timeout` field remains the independent hard runtime limit.
Setting `allowBackground: true` explicitly opts into the untracked detached
behavior and therefore does not use this automatic handoff.

On POSIX systems, `bash` terminates descendants left behind when its foreground
shell exits. Set `allowBackground: true` only for an intentionally untracked,
detached process. Do not detach from ordinary `bash` on Windows.

## Widgets

`DEVSPACE_WIDGETS` controls ChatGPT Apps iframe usage.

| Value | Behavior |
| --- | --- |
| `full` | Default. Widget UI is attached to exposed workspace, file, edit, and shell tools. |
| `changes` | Enables the aggregate `show_changes` tool and attaches widget UI to `open_workspace` and `show_changes`. |
| `off` | Disables widget UI. |

## Skills

| Variable | Purpose |
| --- | --- |
| `DEVSPACE_SKILLS` | Set to `0` to hide skills. Enabled by default. |
| `DEVSPACE_SUBAGENTS` | Set to `1` to expose configured agent profiles as Subagents. Experimental and disabled by default. |
| `DEVSPACE_AGENT_DIR` | Defaults to `~/.codex`; its `skills` child is loaded for compatibility. |
| `DEVSPACE_SKILL_PATHS` | Optional comma-separated additional skill directories. |

DevSpace discovers standard Agent Skills from:

- `~/.agents/skills`
- project `.agents/skills`
- `~/.devspace/skills`

It also keeps compatibility with:

- the bundled `devspace-workflow` skill, which teaches host models how to use
  workspaces, tools, processes, artifacts, review checkpoints, and subagents
- the bundled `subagent-delegation` skill when `DEVSPACE_SUBAGENTS=1`, unless `~/.devspace/skills/subagent-delegation/SKILL.md` exists
- `DEVSPACE_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `DEVSPACE_SKILL_PATHS`

When Subagents are enabled, DevSpace discovers agent profiles
from:

- `~/.devspace/agents/*.md`
- project `.devspace/agents/*.md`

`open_workspace` returns a compact catalog containing profile names,
descriptions, providers, and optional models/thinking levels so the host model can choose an
agent without reading provider-specific launch details. `devspace agents ls`
lists existing subagent sessions for the current workspace, scoped by the
workspace environment injected into shell commands. The `subagent-delegation`
skill teaches the model to use only the minimal `devspace agents ls`,
`devspace agents run`, and `devspace agents show` workflow.

Starter profile templates are available under `examples/agents/`. Copy or adapt
them into one of the active profile directories before use.

Legacy project paths such as `.pi/skills` can be added through `DEVSPACE_SKILL_PATHS` when needed.

Example:

```bash
DEVSPACE_SKILL_PATHS="$HOME/.claude/skills,$HOME/company/skills" \
npx @waishnav/devspace serve
```

## Logging

| Variable | Default |
| --- | --- |
| `DEVSPACE_LOG_LEVEL` | `info` |
| `DEVSPACE_LOG_FORMAT` | `json` |
| `DEVSPACE_LOG_REQUESTS` | `1` |
| `DEVSPACE_LOG_ASSETS` | `0` |
| `DEVSPACE_LOG_TOOL_CALLS` | `1` |
| `DEVSPACE_LOG_SHELL_COMMANDS` | `0` |
| `DEVSPACE_TRUST_PROXY` | `0` |

Set `DEVSPACE_LOG_FORMAT=pretty` for local debugging.

Set `DEVSPACE_LOG_SHELL_COMMANDS=1` only when you intentionally want command
previews in logs.

Set `DEVSPACE_TRUST_PROXY=1` when DevSpace is intentionally deployed behind a
trusted reverse proxy such as Cloudflare Tunnel. The original forwarded client
address is then used for request logging and IP-based rate limiting; leave it
disabled when clients can connect directly to DevSpace.

## Env-Only Example

```bash
DEVSPACE_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)" \
DEVSPACE_ALLOWED_ROOTS="$HOME/personal,$HOME/work" \
DEVSPACE_PUBLIC_BASE_URL="https://devspace.example.com" \
DEVSPACE_WORKTREE_ROOT="$HOME/.devspace/worktrees" \
DEVSPACE_PASEO_URL="ws://127.0.0.1:6767/ws" \
DEVSPACE_ARTIFACTS="1" \
DEVSPACE_TOOL_MODE="minimal" \
DEVSPACE_WIDGETS="full" \
npx @waishnav/devspace serve
```

The environment assignments must be part of the same command invocation, or
exported first.
