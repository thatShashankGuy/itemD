import type { ToolCall } from "../tools/contracts.ts";

export type ShellApprovalDecision = "once" | "always" | "deny";
export type ShellExecutionMode = "ask" | "auto";

export type ShellApprovalRequest = {
  call: Extract<ToolCall, { type: "shell" }>;
  workspaceRoot: string;
};

export type ShellApprovalHandler = (
  request: ShellApprovalRequest,
  signal?: AbortSignal,
) => ShellApprovalDecision | Promise<ShellApprovalDecision>;

function commandKey(call: Extract<ToolCall, { type: "shell" }>): string {
  return JSON.stringify({
    executable: call.executable,
    args: call.args,
    pty: call.pty ?? false,
  });
}

/** Keeps exact user-approved commands for the lifetime of one harness process. */
export class ShellApprovalController {
  private readonly allowedCommands = new Set<string>();
  private readonly handler: ShellApprovalHandler;

  constructor(handler: ShellApprovalHandler) {
    this.handler = handler;
  }

  async authorize(
    request: ShellApprovalRequest,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted) {
      return false;
    }

    const key = commandKey(request.call);

    if (this.allowedCommands.has(key)) {
      return true;
    }

    const decision = await new Promise<ShellApprovalDecision>((resolve) => {
      let settled = false;

      const finish = (value: ShellApprovalDecision): void => {
        if (settled) {
          return;
        }

        settled = true;
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = (): void => {
        finish("deny");
      };

      signal?.addEventListener("abort", onAbort, { once: true });
      Promise.resolve()
        .then(() => this.handler(request, signal))
        .then(finish, () => finish("deny"));
    });

    if (signal?.aborted) {
      return false;
    }

    if (decision === "always") {
      this.allowedCommands.add(key);
    }

    return decision !== "deny";
  }
}
