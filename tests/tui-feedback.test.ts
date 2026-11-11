import { describe, expect, test } from "vitest";
import {
  copiedCharactersMessage,
  getTranscriptSelectionText,
  LOADER_FRAMES,
} from "../src/ui/feedback.ts";

type FakeNode = {
  parent: FakeNode | null;
};

describe("TUI feedback", () => {
  test("copies only selections contained by the transcript", () => {
    const transcript: FakeNode = { parent: null };
    const entry: FakeNode = { parent: transcript };
    const outside: FakeNode = { parent: null };

    expect(
      getTranscriptSelectionText(
        {
          selectedRenderables: [entry],
          getSelectedText: () => "agent response",
        },
        transcript,
      ),
    ).toBe("agent response");
    expect(
      getTranscriptSelectionText(
        {
          selectedRenderables: [entry, outside],
          getSelectedText: () => "mixed selection",
        },
        transcript,
      ),
    ).toBeNull();
  });

  test("formats copy feedback and exposes loader frames", () => {
    expect(copiedCharactersMessage("itemd")).toBe("5 chars copied");
    expect(copiedCharactersMessage("🙂")).toBe("1 chars copied");
    expect(new Set(LOADER_FRAMES).size).toBe(LOADER_FRAMES.length);
    expect(LOADER_FRAMES.length).toBeGreaterThan(1);
  });
});
