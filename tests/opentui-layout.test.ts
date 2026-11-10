import { describe, expect, test } from "vitest";
import {
  SIDEBAR_MIN_COLUMNS,
  formatSidebarContent,
  shouldShowSidebar,
} from "../src/ui/opentui-layout.ts";

describe("OpenTUI layout model", () => {
  test("shows the sidebar only when the terminal has room", () => {
    expect(shouldShowSidebar(SIDEBAR_MIN_COLUMNS - 1)).toBe(false);
    expect(shouldShowSidebar(SIDEBAR_MIN_COLUMNS)).toBe(true);
    expect(shouldShowSidebar(Number.POSITIVE_INFINITY)).toBe(false);
  });

  test("formats the sidebar from current session state", () => {
    expect(
      formatSidebarContent({
        workspaceName: "itemD",
        sessionId: "session-1",
        provider: "deepseek",
        model: "deepseek-flash",
        effort: "high",
        webSearchEnabled: false,
        recentSessions: [
          {
            id: "12345678-aaaa-bbbb-cccc-123456789012",
            workspaceName: "itemD",
            updatedAt: "2026-11-10T10:20:30.123Z",
            active: true,
          },
        ],
      }),
    ).toContain("deepseek / deepseek-flash\neffort: high\nweb search: off");
    expect(
      formatSidebarContent({
        workspaceName: "itemD",
        sessionId: "session-1",
        provider: "deepseek",
        model: "deepseek-flash",
        effort: "high",
        webSearchEnabled: false,
        recentSessions: [],
      }),
    ).toContain("RECENT SESSIONS\n(none)");
  });
});
