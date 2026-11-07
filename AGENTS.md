# itemD — Agent Instructions

## Mission

Build itemD, a framework-light coding harness in TypeScript that makes the runtime around the model explicit: tool calls, command execution, permissions, workspace boundaries, context, Git, failures, tracing, and evaluation.

The north-star workflow is:

```text
itemd "fix the failing tests"
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
- Provider adapters using `fetch` for structured model/tool interaction; add an
  SDK only when a concrete provider requirement justifies it.
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

## Current Next Slice: Provider Setup and Adapters

The active slice is TUI onboarding and a provider-neutral model-adapter
boundary. Implement it one checkpoint at a time using `current-slice.tmp` as the
acceptance plan.

Progress through this slice:

- Checkpoint A complete: shared provider catalog and validation contracts.
- Checkpoint B complete: user-level atomic configuration and credential safety.
- Checkpoint C complete: provider-neutral runner and executable DeepSeek adapter.
- Checkpoint D complete: first-run/reconfigurable TUI setup with masked key input.
- Checkpoint E is next: CLI configuration integration, documentation, final
  verification, and one live read-only DeepSeek run.

The TUI also supports `exit()` for a clean session exit, `/replays` to list
recorded runs, and `/replay <trace-id>` to inspect one without model access.

Provider availability for this slice:

| Provider | Status |
| --- | --- |
| DeepSeek | Enabled |
| OpenAI | Disabled — Coming soon |
| OpenRouter | Disabled — Coming soon |
| Anthropic | Disabled — Coming soon |
| Gemini | Disabled — Coming soon |

- Do not implement, call, or accept credentials for a disabled provider.
- Do not silently map disabled providers to DeepSeek.
- Keep provider metadata in one catalog consumed by setup, validation, and the
  adapter factory.
- Keep the agent runner provider-neutral. Provider-specific messages,
  authentication, endpoints, request parameters, and response translation
  belong under `src/model/adapters/`.
- Only the DeepSeek adapter is executable in this slice.
- Preserve current CLI, TUI, trace, and replay behavior after each checkpoint.

DeepSeek setup initially supports:

- models `deepseek-flash` and `deepseek-v4-pro`;
- reasoning disabled (`none`) or enabled at `low`, `high`, or `max` effort;
- `high` as the default effort.

## Configuration and Credential Rules

- TUI first-run setup may collect and persist an API key only after an enabled
  provider, valid model, and valid effort have been selected.
- Hide or mask API-key input. Never echo the key back in a confirmation summary.
- Prefer a user-level itemD configuration directory over the target workspace.
- Support an explicit config-path override so tests use a temporary directory
  and never touch the developer's real configuration.
- Parse configuration as `unknown` and validate every field before use.
- Write configuration atomically and use user-only file permissions where the
  platform supports them.
- Environment variables override stored configuration and existing DeepSeek
  environment setup remains compatible.
- Never include credentials in errors, task history, tool results, traces,
  replay output, debug logs, Git diffs, or fixtures.
- Missing configuration is normal first-run state. Malformed configuration must
  produce a recoverable setup error rather than a crash.
- Replay must remain available without model credentials.

## TUI Setup Rules

- Show enabled and disabled providers in one selection menu.
- A disabled selection displays `Coming soon` and returns to provider selection.
- Drive provider, model, and effort choices from the shared provider catalog.
- Support rerunning setup from an active TUI session without corrupting the last
  working configuration.
- Ctrl+C during setup must exit cleanly without saving partial state.
- Keep setup input/output injectable so it can be tested without a real terminal.

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
- provider catalog validation and disabled-provider selection;
- configuration read, validation, atomic write, and permission behavior;
- credential redaction from errors, output, and traces;
- model and reasoning-effort compatibility;
- adapter request construction and malformed provider responses;
- first-run TUI setup, cancellation, and reconfiguration.

Once the core workflow exists, build fixture repositories covering a simple failing function, edge cases, missing validation, TypeScript compilation, broken imports, async behavior, parsing, regressions, configuration, and multi-file bugs.

For evaluation runs, record:

- solved or not solved;
- final test status;
- model and tool call counts;
- runtime and token usage where available;
- files changed;
- errors and policy denials.

## Repository Shape

Current responsibility-based layout:

```text
main.ts
src/
  agent/
    runner.ts
    types.ts
  execution/
    command.ts
  model/
    adapters/
      deepseek.ts
  permissions/
    shell-policy.ts
  shared/
    runtime.ts
  telemetry/
    trace.ts
  tools/
    contracts.ts
    dispatcher.ts
  ui/
    tui.ts
  workspace/
    files.ts
tests/
package.json
tsconfig.json
```

Keep root `main.ts` as the CLI entrypoint. Add files only when they own a real
responsibility; do not create empty provider adapters or placeholder layers for
disabled vendors.

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

The first itemD milestone is complete only when:

- the CLI accepts a natural-language task;
- the harness can read and search workspace files;
- it can run the project's tests and capture failures;
- it can edit source files;
- it can inspect Git diff;
- it reruns tests after changes;
- dangerous operations are blocked or require approval;
- every tool call is logged; and
- one broken fixture repository can be fixed end to end.

