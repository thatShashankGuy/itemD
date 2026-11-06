import type { ModelError } from "../model/adapters/deepseek.ts";

export type AgentError =
  | ModelError
  | {
      code: "MAX_STEPS_REACHED";
      message: string;
    };

export type AgentRunResult =
  | {
      ok: true;
      status: "done";
      answer: string;
      steps: number;
      traceId: string;
      tracePath: string;
    }
  | {
      ok: false;
      status: "failed" | "max_steps";
      steps: number;
      error: AgentError;
      traceId: string;
      tracePath: string;
    };
