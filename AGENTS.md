# TypeScript Coding Harness — Agent Instructions

## Mission

Build a framework-light coding harness in TypeScript that makes the runtime around the model explicit: tool calls, command execution, permissions, workspace boundaries, context, Git, failures, tracing, and evaluation.

The north-star workflow is:

```text
harness "fix the failing tests"
  -> run tests
  -> inspect the failure and relevant source
  -> make a focused edit
  -> inspect the diff
  -> rerun tests
  -> report changed files, reasoning, and final test status
```

The model proposes actions. The harness validates and executes them. Preserve this boundary throughout the implementation.

## Engineering Principles

- Build the smallest working version before introducing abstractions.
- Own the agent loop; do not hide tool invocation, observations, state, or stop conditions behind a framework.
- Prefer TypeScript, Node.js built-ins, and boring infrastructure.
- Add a dependency only when it solves a demonstrated problem. Explain the reason in the change.
- Keep types explicit at all trust boundaries, especially model responses, tool arguments, tool results, permissions, and errors.
- Implement one learning phase at a time and leave the repository runnable after each phase.
- Favor narrow, reviewable changes over speculative architecture.

Do not introduce MCP, vector databases, RAG, multi-agent systems, subagents, browser control, persistent memory, a web UI, Kubernetes, distributed workers, or a heavy agent framework unless the current phase explicitly requires it.

## Initial Technology Choices

- TypeScript and Node.js for the implementation.
- `node:child_process` for command execution.
- `node:fs/promises` for file operations.
- `node:path` and filesystem metadata for workspace safety.
- A model SDK directly for structured model/tool interaction.
- Zod only if handwritten runtime validation becomes cumbersome.
- Vitest when automated tests and fixture repositories are introduced.
- Git commands behind typed operations for status, diffs, and changed files.

## Target Architecture

Keep these responsibilities distinct even when they initially live in only a few files:

```text
User task
  -> Agent runner
     -> Context builder -> Model
                          -> Structured tool request
     -> Tool registry and dispatcher
        -> Files | Git | Shell
        -> Workspace
     <- Structured observation
  -> History and next model turn
```

- The agent runner owns the loop, step limit, and stopping conditions.
- The context builder owns system instructions, the original task, and recent interactions.
- The model adapter translates SDK-specific responses into internal typed data.
- The tool registry validates and dispatches supported calls.
- Tools never bypass workspace or permission checks.
- History records calls and observations without becoming coupled to one model SDK.

## Development Sequence

Follow this order unless the user explicitly asks for a later capability:

1. **Command runner:** execute a command and capture stdout, stderr, exit code, duration, and working directory. A non-zero exit must be data, not a harness crash.
2. **Explicit tools:** add typed `read_file`, `write_file`, `list_files`, and `shell` calls with one dispatcher and structured validation errors.
3. **Single model action:** send instructions, tools, and a task; execute at most one requested tool; return its structured result; stop.
4. **Agent loop:** support repeated reason -> act -> observe turns, an explicit final answer, and a maximum step count.
5. **Context management:** retain the original task, encapsulate history behind a small API, and truncate oversized tool output deterministically.
6. **Coding workflow:** add `search_files`, `run_tests`, `git_status`, and `git_diff`; support inspect -> hypothesize -> edit -> diff -> test.
7. **Permission policy:** classify actions as `allow`, `deny`, or `require_confirmation`.
8. **Workspace security:** confine all file access and command working directories to the configured project root; address traversal and symlink escape.
9. **Reliability:** add timeouts, output limits, malformed-input handling, non-zero exit handling, process cleanup, and structured errors.
10. **Typed Git operations:** expose status, diff, and changed files without requiring arbitrary shell use.
11. **Isolation:** introduce a container execution environment only after local execution boundaries are understood and tested.
12. **Tracing:** record model calls, tool calls and results, duration, errors, and token usage when available.
13. **Evaluation:** create about ten intentionally broken fixture projects and measure outcome, calls, runtime, tokens, changed files, and final test status.
14. **Framework comparison:** only then compare the implementation with mature SDKs and agents.

Do not pre-build later phases while implementing an earlier one.

## Tool Contracts

Represent tool calls as discriminated unions. Keep external input unknown until it has been validated.

```ts
type ToolCall =
  | { type: "read_file"; path: string }
  | { type: "write_file"; path: string; content: string }
  | { type: "list_files"; path?: string }
  | { type: "shell"; command: string };

type ToolResult<T = string> =
  | { ok: true; output: T }
  | { ok: false; error: ToolError };
```

- Return expected failures as structured results.
- Do not throw for normal command failures or invalid model-supplied arguments.
- Include enough error detail for the model to recover, but do not leak secrets or unrestricted host information.
- Keep output bounded and report when truncation occurred.
- Log each tool request, policy decision, duration, and result status.

## Safety and Permissions

Default policy:

| Operation | Policy |
| --- | --- |
| Read a workspace file | Allow |
| List or search workspace files | Allow |
| Inspect Git status or diff | Allow |
| Run the configured test command | Allow |
| Write a workspace file | Allow and log |
| Git commit or push | Require confirmation |
| Network access | Require explicit policy or confirmation |
| `sudo`, destructive commands, or host-level mutation | Deny |

For every filesystem path:

1. Resolve it against the configured workspace root.
2. Normalize it and reject traversal outside that root.
3. Account for symlinks by checking the real target where it exists.
4. Reject ambiguous or unsafe targets rather than guessing.

Never implement safety as prompt text alone. Enforcement belongs in deterministic harness code.

## Command Execution Rules

- Use an explicit working directory inside the workspace.
- Capture stdout and stderr separately.
- Record exit code, duration, timeout state, and truncation state.
- Apply a timeout and output-size ceiling.
- Clean up child processes on timeout or harness cancellation.
- Avoid shell interpolation when an executable and argument array can be used.
- Treat command text and output as untrusted data.
- Do not permit commands to escape the workspace policy indirectly.

## Agent Loop Rules

- Preserve the original user task for the entire run.
- Use a hard maximum step count and report when it is reached.
- Stop only on a valid final response, an unrecoverable policy failure, cancellation, or the step limit.
- Append tool calls and their matching results to history in the model SDK's required structure.
- Make repeated failures visible to the model; do not silently retry forever.
- Keep context policy simple initially: system instructions, original task, and recent interactions.
- Truncate large observations predictably while retaining failure summaries and relevant tails.

## Git and Change Discipline

- Treat Git as an audit mechanism, not merely another shell command.
- Inspect status before work so pre-existing user changes remain distinguishable.
- Never overwrite, revert, or discard unrelated changes.
- Prefer focused edits that directly address the task.
- After editing, inspect the diff and rerun the most relevant checks.
- Report changed files and the final test state.
- Never commit or push without explicit confirmation.

## Testing and Evaluation

Add tests at the boundary being introduced in the current phase. Important cases include:

- successful and failing command execution;
- timeouts and excessive output;
- invalid and unknown tool calls;
- path traversal and symlink escape attempts;
- reads and writes at workspace boundaries;
- permission allow, deny, and confirmation decisions;
- loop completion and maximum-step termination;
- context truncation;
- Git status and diff parsing;
- cleanup after failures or cancellation.

Once the core workflow exists, build fixture repositories covering a simple failing function, edge cases, missing validation, TypeScript compilation, broken imports, async behavior, parsing, regressions, configuration, and multi-file bugs.

For evaluation runs, record:

- solved or not solved;
- final test status;
- model and tool call counts;
- runtime and token usage where available;
- files changed;
- errors and policy denials.

## Repository Shape

Start small:

```text
src/
  main.ts
  shell.ts
package.json
tsconfig.json
```

Split into `agent/`, `model/`, `tools/`, `workspace/`, `permissions/`, and `telemetry/` only when real responsibilities require those boundaries. Do not create empty architectural layers in advance.

## Working Agreement for Agents

When changing this repository:

1. Identify the current phase and its smallest useful acceptance criterion.
2. Inspect existing code, tests, and uncommitted changes before editing.
3. State assumptions when the repository does not yet define a choice.
4. Implement the narrowest coherent change.
5. Validate types and run the most relevant tests or checks.
6. Inspect the resulting diff for scope, safety, and accidental changes.
7. Summarize behavior changed, files changed, verification performed, and remaining limitations.

If a requested change jumps ahead in the roadmap, implement only the dependencies it actually needs. Do not use that request as permission to add unrelated platform features.

## First Milestone Definition of Done

The first coding-harness milestone is complete only when:

- the CLI accepts a natural-language task;
- the harness can read and search workspace files;
- it can run the project's tests and capture failures;
- it can edit source files;
- it can inspect Git diff;
- it reruns tests after changes;
- dangerous operations are blocked or require approval;
- every tool call is logged; and
- one broken fixture repository can be fixed end to end.

