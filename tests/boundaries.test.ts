import { describe, expect, test } from "vitest";
import { parseModelResponse } from "../src/model/adapters/deepseek.ts";
import { validateToolCall } from "../src/tools/contracts.ts";

describe("tool-call validation", () => {
  test("accepts a valid read_file call", () => {
    expect(
      validateToolCall({
        type: "read_file",
        path: "README.md",
      }),
    ).toEqual({
      ok: true,
      call: {
        type: "read_file",
        path: "README.md",
      },
    });
  });

  test("returns a structured error for an unknown tool", () => {
    const result = validateToolCall({ type: "delete_file" });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_TOOL_CALL");
    }
  });
});

describe("DeepSeek response parsing", () => {
  test("parses multiple tool calls from one model turn", () => {
    const result = parseModelResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: "Inspecting both files.",
            reasoning_content: "",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: '{"path":"package.json"}',
                },
              },
              {
                id: "call_2",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: '{"path":"README.md"}',
                },
              },
            ],
          },
        },
      ],
    });

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.action.type).toBe("tool_calls");

      if (result.action.type === "tool_calls") {
        expect(result.action.calls).toHaveLength(2);
      }
    }
  });

  test("rejects malformed JSON tool arguments", () => {
    const result = parseModelResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: "{not-json}",
                },
              },
            ],
          },
        },
      ],
    });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_MODEL_RESPONSE");
    }
  });
});
