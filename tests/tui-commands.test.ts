import { describe, expect, test } from "vitest";
import {
  formatTuiCommandHelp,
  suggestTuiCommands,
  TUI_COMMANDS,
} from "../src/ui/commands.ts";

describe("TUI slash commands", () => {
  test("lists commands when slash is entered", () => {
    expect(suggestTuiCommands("/")).toEqual(TUI_COMMANDS);
  });

  test("filters commands by the typed prefix", () => {
    expect(
      suggestTuiCommands("/re").map((command) => command.name),
    ).toEqual(["/reasoning", "/reload", "/replays", "/replay", "/resume"]);
    expect(suggestTuiCommands("plain task")).toEqual([]);
    expect(suggestTuiCommands("/replay ")).toEqual([]);
  });

  test("documents reload and adapter selection", () => {
    const help = formatTuiCommandHelp();

    expect(help).toContain("/reload");
    expect(help).toContain("Reload the API key");
    expect(help).toContain("/reasoning [on|off]");
    expect(help).toContain("Toggle reasoning in live runs");
    expect(help).toContain("/adapter");
    expect(help).toContain("Select a model adapter");
    expect(help).toContain("/model [model-id]");
    expect(help).toContain("Select or change the active model");
    expect(help).toContain("/effort [none|low|high|max]");
    expect(help).toContain("Select or change reasoning effort");
    expect(help).toContain("/setup [browser]");
    expect(help).toContain("/new");
    expect(help).toContain("Start a new session");
    expect(help).toContain("/sessions");
    expect(help).toContain("/resume [session-id]");
    expect(help).toContain("/theme [dark|light]");
    expect(help).toContain("Switch between dark and light terminal themes");
  });
});
