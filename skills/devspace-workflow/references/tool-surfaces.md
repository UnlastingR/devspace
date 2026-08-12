# DevSpace Tool Surfaces

Load only the section relevant to the tools exposed by the current connection.

## Shared workspace rules

Call `open_workspace` once, then pass its `workspaceId` to all later tools.
Use checkout mode for the existing directory and worktree mode for intentional
isolation. A worktree call always creates a new workspace; repeated checkout
calls may be recovered by supported hosts, but explicit ID reuse is the
portable workflow.

Read direct files with `read`. Use paths relative to the workspace unless
reading a skill path advertised by `open_workspace`. Reading a skill's
`SKILL.md` activates access to that skill's referenced files; it does not grant
access to arbitrary paths outside the workspace.

If `open_workspace` reports a linked Paseo workspace, continue using the
DevSpace `workspaceId` for tools. Treat the Paseo ID as observability metadata.
Call `archive_workspace` only on the user's explicit request to close or archive
a finished managed worktree; it preserves the directory and makes the
DevSpace ID inactive.

## Minimal and full modes

Use:

- `read` for direct file reads.
- `edit` for targeted replacements.
- `write` only for a new file or a deliberate complete rewrite.
- `bash` for quick foreground terminal-native inspection.
- `exec_command` for tests, builds, reviews, package scripts, and any command
  with uncertain duration.
- `write_stdin` to poll or interact with the process session returned by
  `exec_command`.
- `grep`, `glob`, and `ls` when present in full mode. In minimal mode, use `rg`,
  `find`, and `ls` through `bash` for equivalent read-only inspection.

Do not write files with shell redirection, heredocs, `tee`, `sed -i`,
language-runtime scripts, or generated patch scripts. These hide mutations from
the file-tool and review contracts.

`bash` defaults to a 30-second timeout and caps it at 300 seconds. Do not raise
that timeout for potentially slow work; start a tracked process instead. When
`exec_command` returns a `sessionId`, keep polling that same session with
`write_stdin` until `running` is false. Prefer yield windows of 10 seconds or
less so the host receives regular progress. A `bash` command that unexpectedly
runs past 10 seconds automatically returns a tracked session; poll it with
`write_stdin`. Its `timeout` remains the independent hard runtime limit. On
POSIX systems, `bash` terminates background descendants after the foreground
shell exits. Use `allowBackground: true` only when the user explicitly wants
an untracked, detached local process; this explicitly bypasses automatic
session handoff. Do not detach from ordinary `bash` on Windows.

## Codex-compatible mode

Use:

- `read` for direct file reads.
- `apply_patch` for every file mutation.
- `exec_command` for inspection, tests, builds, and long-running commands.
- `write_stdin` to poll a returned process session, send input, resize a PTY,
  or send Ctrl-C (`\u0003`).

Set `tty: true` only for commands that actually require a terminal. When
`exec_command` returns a `sessionId`, keep polling that same session rather
than starting duplicate commands. Prefer yield windows of 10 seconds or less.
Treat completion, exit code, and output as separate facts.

## Artifacts

Use `download_artifact` only when it is exposed and the user supplies or
generates a native file that is not already on the DevSpace host. Pass the
existing `workspaceId`, the native file value, and a suitable relative
destination. The tool refuses overwrite; inspect or edit existing destinations
with normal workspace tools.

Do not reconstruct binary files through text tools, invent host paths for
attachments, or pass signed URLs and native file objects to shell commands.

## Review completion

If `show_changes` is exposed, call it once after the last file mutation in the
turn. It represents the combined review checkpoint. If it is absent, rely on
the mutation-tool widgets and inspect the diff through available tools when
needed; do not call a nonexistent aggregate review tool.

Before answering, distinguish:

- source-checkout verification from packaged `npm`/`npx` verification;
- direct MCP tests from behavior observed in ChatGPT;
- command success from a visible UI or deployment result;
- checkout behavior from managed-worktree behavior.
