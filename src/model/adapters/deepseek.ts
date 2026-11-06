import { getErrorMessage, isRecord } from "../../shared/runtime.ts";

export const DEFAULT_DEEPSEEK_MODEL = "deepseek-flash";
const MODEL_TIMEOUT_MS = 60_000;
const MAX_MODEL_ERROR_CHARS = 4_000;

const SYSTEM_PROMPT = `
You are the reasoning component of a local coding harness.

The harness, not you, executes tools. You may request multiple tools in one turn.
Use workspace-relative paths only.
Use read_file before editing unfamiliar code.
Use edit_file for one exact replacement.
Use shell only for permitted inspection or test commands.
If a tool fails, inspect the structured error and choose a recovery action.
When the task is complete, respond with DONE: followed by a concise summary.
Do not claim that a tool ran unless its result appears in the conversation.
`.trim();

type DeepSeekToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type Message =
  | {
      role: "user";
      content: string;
    }
  | {
      role: "assistant";
      content: string | null;
      reasoning_content?: string | null;
      tool_calls?: DeepSeekToolCall[];
    }
  | {
      role: "tool";
      tool_call_id: string;
      content: string;
    };

export type ToolAction = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  call: unknown;
};

type ModelAction =
  | {
      type: "tool_calls";
      calls: ToolAction[];
    }
  | {
      type: "final";
      text: string;
    };

export type ModelError = {
  code: "MODEL_REQUEST_FAILED" | "INVALID_MODEL_RESPONSE";
  message: string;
  status?: number;
  details?: unknown;
};

export type ModelCallResult =
  | {
      ok: true;
      action: ModelAction;
      content: Message;
    }
  | {
      ok: false;
      error: ModelError;
    };

export function createInitialMessages(task: string): Message[] {
  return [
    {
      role: "user",
      content: task,
    },
  ];
}

const DEEPSEEK_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a UTF-8 text file inside the current workspace.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative file path.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Replace one exact, unique text occurrence in an existing workspace file.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative file path.",
          },
          oldText: {
            type: "string",
            description:
              "Exact text to replace. It must occur exactly once.",
          },
          newText: {
            type: "string",
            description: "Replacement text.",
          },
        },
        required: ["path", "oldText", "newText"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shell",
      description:
        "Run one command allowed by the harness command policy. " +
        "Python is limited to --version, -m pytest, and -m unittest.",
      parameters: {
        type: "object",
        properties: {
          executable: {
            type: "string",
            description:
              "Executable name such as git, node, npm, python3, rg, ls, or pwd.",
          },
          args: {
            type: "array",
            items: { type: "string" },
            description:
              "Arguments passed directly without shell interpolation.",
          },
        },
        required: ["executable", "args"],
      },
    },
  },
] as const;

function invalidModelResponse(message: string): ModelCallResult {
  return {
    ok: false,
    error: {
      code: "INVALID_MODEL_RESPONSE",
      message,
    },
  };
}

function getFirstChoiceMessage(
  response: Record<string, unknown>,
): unknown {
  if (!Array.isArray(response.choices)) {
    return undefined;
  }

  const firstChoice = response.choices[0];

  return isRecord(firstChoice)
    ? firstChoice.message
    : undefined;
}

export function parseModelResponse(response: unknown): ModelCallResult {
  if (!isRecord(response)) {
    return invalidModelResponse("Model response must be an object");
  }

  const rawMessage = getFirstChoiceMessage(response);

  if (!isRecord(rawMessage)) {
    return invalidModelResponse(
      "Model response has no first choice message",
    );
  }

  if (rawMessage.role !== "assistant") {
    return invalidModelResponse(
      "Model choice message role must be assistant",
    );
  }

  if (
    rawMessage.content !== null &&
    typeof rawMessage.content !== "string"
  ) {
    return invalidModelResponse(
      "Assistant content must be a string or null",
    );
  }

  if (
    rawMessage.reasoning_content !== undefined &&
    rawMessage.reasoning_content !== null &&
    typeof rawMessage.reasoning_content !== "string"
  ) {
    return invalidModelResponse(
      "Assistant reasoning content must be a string or null",
    );
  }

  const rawToolCalls = rawMessage.tool_calls;

  if (
    rawToolCalls !== undefined &&
    !Array.isArray(rawToolCalls)
  ) {
    return invalidModelResponse(
      "Assistant tool calls must be an array",
    );
  }

  const toolCalls: DeepSeekToolCall[] = [];
  const toolActions: ToolAction[] = [];
  const toolCallIds = new Set<string>();

  for (const rawToolCall of rawToolCalls ?? []) {
    if (
      !isRecord(rawToolCall) ||
      typeof rawToolCall.id !== "string" ||
      rawToolCall.id.length === 0 ||
      rawToolCall.type !== "function" ||
      !isRecord(rawToolCall.function) ||
      typeof rawToolCall.function.name !== "string" ||
      typeof rawToolCall.function.arguments !== "string"
    ) {
      return invalidModelResponse(
        "Tool call must contain an id, function name, and JSON arguments",
      );
    }

    if (toolCallIds.has(rawToolCall.id)) {
      return invalidModelResponse(
        "Tool call IDs must be unique within a model turn",
      );
    }

    toolCallIds.add(rawToolCall.id);

    let parsedArguments: unknown;

    try {
      parsedArguments = JSON.parse(
        rawToolCall.function.arguments,
      ) as unknown;
    } catch (error: unknown) {
      return invalidModelResponse(
        `Tool arguments are not valid JSON: ${getErrorMessage(error)}`,
      );
    }

    if (!isRecord(parsedArguments)) {
      return invalidModelResponse(
        "Tool arguments must decode to an object",
      );
    }

    const toolCall: DeepSeekToolCall = {
      id: rawToolCall.id,
      type: "function",
      function: {
        name: rawToolCall.function.name,
        arguments: rawToolCall.function.arguments,
      },
    };
    toolCalls.push(toolCall);
    toolActions.push({
      id: toolCall.id,
      name: toolCall.function.name,
      args: parsedArguments,
      call: {
        ...parsedArguments,
        // Put type last so an argument cannot overwrite the tool name.
        type: toolCall.function.name,
      },
    });
  }

  const content: Message = {
    role: "assistant",
    content: rawMessage.content,
    ...(rawMessage.reasoning_content === undefined
      ? {}
      : { reasoning_content: rawMessage.reasoning_content }),
    ...(rawToolCalls === undefined
      ? {}
      : { tool_calls: toolCalls }),
  };

  if (toolActions.length > 0) {
    return {
      ok: true,
      content,
      action: {
        type: "tool_calls",
        calls: toolActions,
      },
    };
  }

  const text = rawMessage.content?.trim() ?? "";

  if (text.length === 0) {
    return invalidModelResponse(
      "Model response contains neither text nor a function call",
    );
  }

  return {
    ok: true,
    content,
    action: {
      type: "final",
      text,
    },
  };
}

export async function callDeepSeek(
  apiKey: string,
  model: string,
  messages: Message[],
): Promise<ModelCallResult> {
  const endpoint = "https://api.deepseek.com/chat/completions";

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, MODEL_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...messages,
        ],
        tools: DEEPSEEK_TOOLS,
        thinking: { type: "enabled" },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text();

      return {
        ok: false,
        error: {
          code: "MODEL_REQUEST_FAILED",
          message: `DeepSeek request failed with HTTP ${response.status}`,
          status: response.status,
          details: errorBody.slice(0, MAX_MODEL_ERROR_CHARS),
        },
      };
    }

    let responseBody: unknown;

    try {
      responseBody = await response.json();
    } catch (error: unknown) {
      return {
        ok: false,
        error: {
          code: "INVALID_MODEL_RESPONSE",
          message: `DeepSeek returned invalid JSON: ${getErrorMessage(error)}`,
        },
      };
    }

    return parseModelResponse(responseBody);
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: "MODEL_REQUEST_FAILED",
        message:
          error instanceof Error && error.name === "AbortError"
            ? `DeepSeek request exceeded ${MODEL_TIMEOUT_MS}ms`
            : getErrorMessage(error),
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}
