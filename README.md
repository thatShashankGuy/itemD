# TypeScript Coding Harness

A small, framework-free coding harness built to make the runtime around a model explicit and understandable.

The project is being written one learning slice at a time. Each slice should remain runnable before the next capability is introduced.

## Goal

Build a single-file coding agent that can:

1. Accept a natural-language coding task.
2. Ask a Gemini model what to do next.
3. Read files, edit files, and run shell commands.
4. Return every tool result—including failures—to the model.
5. Repeat until the model explicitly reports completion or a maximum step limit is reached.
6. Record enough detail to understand and replay the run.

The model proposes actions. Deterministic harness code validates and executes them.

## Design constraints

- TypeScript with erasable syntax supported directly by Node.js.
- One implementation file: `main.ts`.
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

- [ ] **Slice 4 — Gemini model call**
  - Add the system prompt and message-history array.
  - Call Gemini with `fetch` and no SDK.
  - Parse text and function-call responses at the trust boundary.

- [ ] **Slice 5 — Agent loop**
  - Repeatedly call the model, execute tools, and append observations.
  - Return tool failures to the model so it can recover.
  - Enforce a maximum step count.
  - Stop on a clear done response.

- [ ] **Slice 6 — Tracing and replay**
  - Log every model call, tool call, result, duration, and error.
  - Store traces as local JSON Lines files.
  - Add a simple replay command for debugging.

## Current files

- `main.ts` — the single implementation file.
- `README.md` — project goals, constraints, and progress.
- `current-slice.tmp` — ignored learning notes for the active slice. It is overwritten when moving to the next slice.
- `.env` — ignored local configuration such as `GEMINI_API_KEY`.

## Current slice

Slice 3 is complete. The next checkpoint is Slice 4: connecting one Gemini model call through `fetch` while keeping model-specific response parsing separate from tool execution.

The ignored `current-slice.tmp` still contains the Slice 3 learning reference and will be overwritten when Slice 4 begins.

## Running the current harness

Read a workspace file:

```bash
node main.ts '{"type":"read_file","path":"package.json"}'
```

Run an allowed command:

```bash
node main.ts '{"type":"shell","executable":"git","args":["status","--short"]}'
```

Observe a policy denial:

```bash
node main.ts '{"type":"shell","executable":"git","args":["reset","--hard"]}'
```

## Non-goals for now

This project intentionally avoids agent frameworks, MCP, RAG, vector databases, persistent memory, browser automation, subagents, containers, and a web interface. Those features would obscure the small runtime being studied.
