import { getErrorMessage, isRecord } from "../../shared/runtime.ts";
import type { ModelAdapter } from "../adapter.ts";
import type { ReasoningEffort } from "../contracts.ts";
import type {
  ModelCallResult,
  ModelCallOptions,
  ModelMessage,
  ModelStreamEvent,
  ModelToolRequest,
  ToolAction,
} from "../types.ts";

const MODEL_TIMEOUT_MS = 60_000;
const MAX_MODEL_ERROR_CHARS = 4_000;
const ENDPOINT = "https://api.deepseek.com/chat/completions";

const SYSTEM_PROMPT = `
You are the reasoning component of a local coding harness.

The harness, not you, executes tools. You may request multiple tools in one turn.
Use workspace-relative paths only.
Use list_files or search_files to locate relevant code, then read_file before
editing unfamiliar code.
Use write_file to create or replace a complete file, and edit_file for one exact
replacement in an existing file. Use delete_file only when the task requires
removing a regular workspace file.
Use shell only for permitted inspection or test commands. Shell commands may
request pty: true when terminal output formatting or terminal detection is
required. The harness may ask the user for approval before execution.
If a tool fails, inspect its structured error, exit code, stderr, and output;
explain the root cause in the final answer and choose a recovery action when
one is available.
When the task is complete, respond with DONE: followed by a concise summary.
Do not claim that a tool ran unless its result appears in the conversation.
`.trim();

const DIRECT_ANSWER_SYSTEM_PROMPT = `
You answer general informational questions clearly and directly.
Do not request tools, inspect the workspace, or claim to have performed an
action. If the question depends on files or a particular project, explain what
information is missing instead.
`.trim();

type DeepSeekToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type DeepSeekMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      reasoning_content?: string | null;
      tool_calls?: DeepSeekToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

export type DeepSeekAdapterOptions = {
  apiKey: string;
  model: string;
  effort: ReasoningEffort;
  fetchImplementation?: typeof fetch;
};

const DEEPSEEK_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file inside the current workspace.",
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
      name: "write_file",
      description:
        "Create a new UTF-8 workspace file or replace an existing regular file with complete content.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative file path.",
          },
          content: {
            type: "string",
            description: "Complete UTF-8 file contents.",
          },
        },
        required: ["path", "content"],
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
            description: "Exact text to replace. It must occur exactly once.",
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
      name: "delete_file",
      description:
        "Delete one existing regular workspace file. Directories and protected paths cannot be deleted.",
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
      name: "list_files",
      description:
        "List immediate files and directories in a workspace directory.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Optional workspace-relative directory path; defaults to the workspace root.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description:
        "Search workspace text files for a literal string and return matching paths, line numbers, and lines.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Literal text to find.",
          },
          path: {
            type: "string",
            description: "Optional workspace-relative directory path to search.",
          },
        },
        required: ["query"],
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
            description: "Arguments passed directly without shell interpolation.",
          },
          pty: {
            type: "boolean",
            description:
              "Optional. Allocate a pseudoterminal when the command needs terminal behavior.",
          },
        },
        required: ["executable", "args"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the public web and return up to five concise results. Use web_fetch to inspect an authoritative result.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "A focused web search query.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description:
        "Fetch bounded text from one public http or https URL returned by web_search.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The public URL to inspect.",
          },
        },
        required: ["url"],
      },
    },
  },
] as const;

function invalidModelResponse(message: string): ModelCallResult {
  return {
    ok: false,
    error: { code: "INVALID_MODEL_RESPONSE", message },
  };
}

function getFirstChoiceMessage(
  response: Record<string, unknown>,
): unknown {
  if (!Array.isArray(response.choices)) {
    return undefined;
  }

  const firstChoice = response.choices[0];

  return isRecord(firstChoice) ? firstChoice.message : undefined;
}

export function parseModelResponse(response: unknown): ModelCallResult {
  if (!isRecord(response)) {
    return invalidModelResponse("Model response must be an object");
  }

  const rawMessage = getFirstChoiceMessage(response);

  if (!isRecord(rawMessage)) {
    return invalidModelResponse("Model response has no first choice message");
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
    return invalidModelResponse("Assistant content must be a string or null");
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

  if (rawToolCalls !== undefined && !Array.isArray(rawToolCalls)) {
    return invalidModelResponse("Assistant tool calls must be an array");
  }

  const toolCalls: ModelToolRequest[] = [];
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
      return invalidModelResponse("Tool arguments must decode to an object");
    }

    const toolCall: ModelToolRequest = {
      id: rawToolCall.id,
      name: rawToolCall.function.name,
      arguments: rawToolCall.function.arguments,
    };
    toolCalls.push(toolCall);
    toolActions.push({
      id: toolCall.id,
      name: toolCall.name,
      args: parsedArguments,
      call: {
        ...parsedArguments,
        type: toolCall.name,
      },
    });
  }

  const message = {
    role: "assistant" as const,
    content: rawMessage.content,
    ...(rawMessage.reasoning_content === undefined
      ? {}
      : { reasoning: rawMessage.reasoning_content }),
    ...(rawToolCalls === undefined ? {} : { toolCalls }),
  };

  if (toolActions.length > 0) {
    return {
      ok: true,
      message,
      action: { type: "tool_calls", calls: toolActions },
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
    message,
    action: { type: "final", text },
  };
}

function toDeepSeekMessage(message: ModelMessage): DeepSeekMessage {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }

  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content,
      ...(message.reasoning === undefined
        ? {}
        : { reasoning_content: message.reasoning }),
      ...(message.toolCalls === undefined
        ? {}
        : {
            tool_calls: message.toolCalls.map((toolCall) => ({
              id: toolCall.id,
              type: "function" as const,
              function: {
                name: toolCall.name,
                arguments: toolCall.arguments,
              },
            })),
          }),
    };
  }

  return message;
}

function redactSecret(text: string, secret: string): string {
  return secret.length === 0 ? text : text.split(secret).join("[REDACTED]");
}

function requestBody(
  history: readonly ModelMessage[],
  model: string,
  effort: ReasoningEffort,
  stream: boolean,
  interactionMode: ModelCallOptions["interactionMode"] = "agent",
): Record<string, unknown> {
  return {
    model,
    messages: [
      {
        role: "system",
        content:
          interactionMode === "direct"
            ? DIRECT_ANSWER_SYSTEM_PROMPT
            : SYSTEM_PROMPT,
      },
      ...history.map(toDeepSeekMessage),
    ],
    ...(interactionMode === "direct" ? {} : { tools: DEEPSEEK_TOOLS }),
    thinking: {
      type: effort === "none" ? "disabled" : "enabled",
    },
    ...(effort === "none" ? {} : { reasoning_effort: effort }),
    ...(stream ? { stream: true } : {}),
  };
}

type StreamToolCall = {
  id: string;
  name: string;
  arguments: string;
};

type StreamDelta = {
  content?: string;
  reasoning?: string;
  toolCalls?: Array<{
    index: number;
    id?: string;
    name?: string;
    arguments?: string;
  }>;
};

function parseStreamDelta(value: unknown): StreamDelta {
  if (!isRecord(value) || !Array.isArray(value.choices)) {
    return {};
  }

  const choice = value.choices[0];

  if (!isRecord(choice) || !isRecord(choice.delta)) {
    return {};
  }

  const delta = choice.delta;
  const parsed: StreamDelta = {};

  if (typeof delta.content === "string") {
    parsed.content = delta.content;
  }

  if (typeof delta.reasoning_content === "string") {
    parsed.reasoning = delta.reasoning_content;
  }

  if (Array.isArray(delta.tool_calls)) {
    parsed.toolCalls = delta.tool_calls.flatMap((call, fallbackIndex) => {
      if (!isRecord(call)) {
        return [];
      }

      const index = typeof call.index === "number" ? call.index : fallbackIndex;
      const functionValue = isRecord(call.function) ? call.function : {};

      return [{
        index,
        ...(typeof call.id === "string" ? { id: call.id } : {}),
        ...(typeof functionValue.name === "string"
          ? { name: functionValue.name }
          : {}),
        ...(typeof functionValue.arguments === "string"
          ? { arguments: functionValue.arguments }
          : {}),
      }];
    });
  }

  return parsed;
}

function streamFailure(
  message: string,
  status?: number,
  details?: unknown,
): ModelStreamEvent {
  return {
    type: "failed",
    error: {
      code: status === undefined
        ? "INVALID_MODEL_RESPONSE"
        : "MODEL_REQUEST_FAILED",
      message,
      ...(status === undefined ? {} : { status }),
      ...(details === undefined ? {} : { details }),
    },
  };
}

async function* parseDeepSeekStream(
  response: Response,
  apiKey: string,
): AsyncGenerator<ModelStreamEvent> {
  if (response.body === null) {
    yield streamFailure("DeepSeek streaming response had no body");
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  let sawReasoning = false;
  let streamError: ModelStreamEvent | undefined;
  const toolCalls = new Map<number, StreamToolCall>();

  const consumeLine = function* (line: string): Generator<ModelStreamEvent> {
    if (!line.startsWith("data:")) {
      return;
    }

    const data = line.slice("data:".length).trim();

    if (data.length === 0 || data === "[DONE]") {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch (error: unknown) {
      streamError = streamFailure(
        `DeepSeek returned invalid stream JSON: ${redactSecret(
          getErrorMessage(error),
          apiKey,
        )}`,
      );
      return;
    }

    const delta = parseStreamDelta(parsed);

    if (delta.content !== undefined) {
      content += delta.content;
      yield { type: "text_delta", text: delta.content };
    }

    if (delta.reasoning !== undefined) {
      reasoning += delta.reasoning;
      sawReasoning = true;
      yield { type: "reasoning_delta", text: delta.reasoning };
    }

    for (const part of delta.toolCalls ?? []) {
      const existing = toolCalls.get(part.index) ?? {
        id: "",
        name: "",
        arguments: "",
      };
      existing.id += part.id ?? "";
      existing.name += part.name ?? "";
      existing.arguments += part.arguments ?? "";
      toolCalls.set(part.index, existing);
    }
  };

  try {
    while (true) {
      const chunk = await reader.read();

      if (chunk.done) {
        break;
      }

      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        yield* consumeLine(line);
      }
    }

    buffer += decoder.decode();
    if (buffer.length > 0) {
      yield* consumeLine(buffer);
    }
  } finally {
    reader.releaseLock();
  }

  if (streamError !== undefined) {
    yield streamError;
    return;
  }

  const orderedToolCalls = [...toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => ({
      id: call.id,
      type: "function" as const,
      function: {
        name: call.name,
        arguments: call.arguments,
      },
    }));
  const result = parseModelResponse({
    choices: [
      {
        message: {
          role: "assistant",
          content: content.length === 0 ? null : content,
          ...(sawReasoning ? { reasoning_content: reasoning } : {}),
          ...(orderedToolCalls.length === 0
            ? {}
            : { tool_calls: orderedToolCalls }),
        },
      },
    ],
  });

  if (result.ok) {
    yield { type: "completed", result };
  } else {
    yield { type: "failed", error: result.error };
  }
}

export function createDeepSeekAdapter(
  options: DeepSeekAdapterOptions,
): ModelAdapter {
  const fetchImplementation = options.fetchImplementation ?? fetch;

  return {
    metadata: {
      provider: "deepseek",
      model: options.model,
      effort: options.effort,
    },
    async call(
      history: readonly ModelMessage[],
      signal?: AbortSignal,
      callOptions?: ModelCallOptions,
    ): Promise<ModelCallResult> {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, MODEL_TIMEOUT_MS);
      const requestSignal =
        signal === undefined
          ? controller.signal
          : AbortSignal.any([controller.signal, signal]);

      try {
        const response = await fetchImplementation(ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify(
            requestBody(
              history,
              options.model,
              options.effort,
              false,
              callOptions?.interactionMode,
            ),
          ),
          signal: requestSignal,
        });

        if (!response.ok) {
          const errorBody = await response.text();

          return {
            ok: false,
            error: {
              code: "MODEL_REQUEST_FAILED",
              message: `DeepSeek request failed with HTTP ${response.status}`,
              status: response.status,
              details: redactSecret(
                errorBody.slice(0, MAX_MODEL_ERROR_CHARS),
                options.apiKey,
              ),
            },
          };
        }

        let responseBody: unknown;

        try {
          responseBody = await response.json();
        } catch (error: unknown) {
          const message = redactSecret(
            getErrorMessage(error),
            options.apiKey,
          );

          return {
            ok: false,
            error: {
              code: "INVALID_MODEL_RESPONSE",
              message: `DeepSeek returned invalid JSON: ${message}`,
            },
          };
        }

        return parseModelResponse(responseBody);
      } catch (error: unknown) {
        const message =
          error instanceof Error && error.name === "AbortError"
            ? signal?.aborted
              ? "DeepSeek request cancelled"
              : `DeepSeek request exceeded ${MODEL_TIMEOUT_MS}ms`
            : getErrorMessage(error);

        return {
          ok: false,
          error: {
            code: "MODEL_REQUEST_FAILED",
            message: redactSecret(message, options.apiKey),
          },
        };
      } finally {
        clearTimeout(timeout);
      }
    },
    async *stream(
      history: readonly ModelMessage[],
      signal?: AbortSignal,
      callOptions?: ModelCallOptions,
    ): AsyncGenerator<ModelStreamEvent> {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, MODEL_TIMEOUT_MS);
      const requestSignal =
        signal === undefined
          ? controller.signal
          : AbortSignal.any([controller.signal, signal]);

      try {
        const response = await fetchImplementation(ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            Authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify(
            requestBody(
              history,
              options.model,
              options.effort,
              true,
              callOptions?.interactionMode,
            ),
          ),
          signal: requestSignal,
        });

        if (!response.ok) {
          const errorBody = await response.text();
          yield streamFailure(
            `DeepSeek request failed with HTTP ${response.status}`,
            response.status,
            redactSecret(
              errorBody.slice(0, MAX_MODEL_ERROR_CHARS),
              options.apiKey,
            ),
          );
          return;
        }

        yield* parseDeepSeekStream(response, options.apiKey);
      } catch (error: unknown) {
        const message =
          error instanceof Error && error.name === "AbortError"
            ? signal?.aborted
              ? "DeepSeek request cancelled"
              : `DeepSeek request exceeded ${MODEL_TIMEOUT_MS}ms`
            : getErrorMessage(error);
        yield streamFailure(redactSecret(message, options.apiKey));
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
