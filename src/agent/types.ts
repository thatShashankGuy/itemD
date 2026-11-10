import type { ModelError } from "../model/types.ts";

export type AgentError =
  | ModelError
  | {
      code: "MAX_STEPS_REACHED";
      message: string;
    }
  | {
      code: "RUN_CANCELLED";
      message: string;
    }
  | {
      code: "INTERACTION_POLICY_VIOLATION";
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
      status: "failed" | "max_steps" | "cancelled";
      steps: number;
      error: AgentError;
      traceId: string;
      tracePath: string;
    };
