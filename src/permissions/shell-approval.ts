import type { ToolCall } from "../tools/contracts.ts";

export type ShellApprovalDecision = "once" | "always" | "deny";
export type ShellExecutionMode = "ask" | "auto";

export type ShellApprovalRequest = {
  call: Extract<ToolCall, { type: "shell" }>;
  workspaceRoot: string;
};

export type ShellApprovalHandler = (
  request: ShellApprovalRequest,
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

  async authorize(request: ShellApprovalRequest): Promise<boolean> {
    const key = commandKey(request.call);

    if (this.allowedCommands.has(key)) {
      return true;
    }

    const decision = await this.handler(request);

    if (decision === "always") {
      this.allowedCommands.add(key);
    }

    return decision !== "deny";
  }
}
