import { describe, expect, test } from "vitest";
import {
  formatActivitySnapshot,
  formatShellApprovalPanel,
} from "../src/ui/opentui-activity.ts";

describe("OpenTUI activity presentation", () => {
  test("formats a runtime activity snapshot", () => {
    expect(formatActivitySnapshot({
      phase: "executing_tool",
      message: "Running tsc",
      step: 3,
    })).toBe("step 3  •  executing_tool  •  Running tsc");
  });

  test("formats shell approval choices in one panel", () => {
    expect(formatShellApprovalPanel('"npm" "test"')).toContain(
      "[1] once    [2] allow this exact command later    [3] deny",
    );
  });
});
