# TypeScript Coding Harness

A small, framework-free coding harness built to make the runtime around a model explicit and understandable.

The project is being written one learning slice at a time. Each slice should remain runnable before the next capability is introduced.

## Goal

Build a single-file coding agent that can:

1. Accept a natural-language coding task.
2. Ask a DeepSeek model what to do next.
3. Read files, edit files, and run shell commands.
4. Return every tool result—including failures—to the model.
5. Repeat until the model explicitly reports completion or a maximum step limit is reached.
6. Record enough detail to understand and replay the run.

The model proposes actions. Deterministic harness code validates and executes them.

## Design constraints

- TypeScript with erasable syntax supported directly by Node.js.
- Core harness logic remains in `main.ts`; `tui.ts` is a thin terminal adapter.
- Plain functions and explicit types; no classes.
- Node.js built-ins and `fetch`; zero runtime dependencies.
- Three model-facing tools: `read_file`, `edit_file`, and `shell`.
- Tool arguments enter the harness as `unknown` and are validated at runtime.
- Expected failures are structured data, not thrown exceptions.
- Workspace and command safety are enforced in code, not only in the system prompt.
- A hard maximum step count prevents an unbounded agent loop.
- Model calls, tool calls, and tool results are written to a trace file.
- Completion requires an explicit done response from the model.

## Learning slices

- [x] **Slice 1 — Command runner**
  - Execute an executable with an argument array.
  - Capture stdout, stderr, exit code, signal, duration, and cwd.
  - Return command and spawn failures as structured data.

- [x] **Slice 2 — Explicit tools**
  - Define `read_file`, `edit_file`, and `shell` as typed data.
  - Validate untrusted input at runtime.
  - Dispatch each valid call through one function.
  - Return tool failures as structured results.

- [x] **Slice 3 — Safety and sanity**
  - Confine file operations to the workspace.
  - Reject traversal and symlink escapes.
  - Add a deterministic shell-command policy.
  - Add command timeouts and output limits.

- [x] **Slice 4 — DeepSeek model call**
  - Add the system prompt and message-history array.
  - Call DeepSeek with `fetch` and no SDK.
  - Parse text and function-call responses at the trust boundary.

- [x] **Slice 5 — Agent loop**
  - Repeatedly call the model, execute tools, and append observations.
  - Return tool failures to the model so it can recover.
  - Enforce a maximum step count.
  - Stop on a clear done response.

- [x] **Slice 6 — Tracing and replay**
  - Log every model call, tool call, result, duration, and error.
  - Store traces as local JSON Lines files.
  - Add a simple replay command for debugging.

## Current files

- `main.ts` — core harness implementation and command-line entrypoint.
- `tui.ts` — dependency-free interactive terminal interface.
- `README.md` — project goals, constraints, and progress.
- `current-slice.tmp` — ignored learning notes for the active slice. It is overwritten when moving to the next slice.
- `.env` — ignored local configuration such as `DEEPSEEK_API_KEY`.

## Current slice

Slice 6 is complete. Agent runs now record model calls, tool calls, results, durations, errors, and final status as replayable JSON Lines traces.

The ignored `current-slice.tmp` retains the Slice 6 learning reference and will be overwritten when the next slice begins.

## Running the current harness

Run a multi-turn coding task:

```bash
npm start -- "Read package.json and report the package name. Do not edit files."
```

The harness now executes validated tool requests, returns both successes and failures to the model, and repeats until the model responds with `DONE:` or reaches the 50-step limit.

Each run returns a trace ID. Replay it without making a model request or executing tools:

```bash
npm start -- --replay <trace-id>
```

Raw JSONL traces are stored under `.harness/traces/` and are excluded from Git.

Start the interactive terminal interface:

```bash
npm run tui
```

Enter a task directly, or use `/help`, `/replay <trace-id>`, `/clear`, and `/quit`. Each submitted task starts an independent agent run with its own trace.

Check syntax without making a model request:

```bash
npm run check
```

## Supported shell commands

The shell tool runs one executable with an argument array, and a deterministic
allowlist decides what may run:

| Executable | Allowed use |
| --- | --- |
| `git` | Read-only subcommands: `status`, `diff`, `log`, `show` |
| `ls`, `pwd`, `rg` | Inspect workspace files |
| `node` | `--version`, `--check`, `--test` |
| `npm` | `test` only |
| `python`, `python3` | `--version`, `-m pytest`, `-m unittest` |

Python support is deliberately as narrow as the Node policy: it covers version
reporting and the two standard test runners, so a Python project can be
inspected, edited, tested, and retested. `-c`, stdin, direct script execution,
and other `-m` modules (including `pip`) remain denied. This is an allowlist
against accidental host mutation, not a sandbox. Reads and edits already work
for `.py` files; nothing about file handling is TypeScript-specific.

## Non-goals for now

This project intentionally avoids agent frameworks, MCP, RAG, vector databases, persistent memory, browser automation, subagents, containers, and a web interface. Those features would obscure the small runtime being studied.
