export const LOADER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

type ParentNode = {
  parent: ParentNode | null;
};

type SelectionLike = {
  selectedRenderables: readonly ParentNode[];
  getSelectedText(): string;
};

function isDescendantOf(node: ParentNode, container: ParentNode): boolean {
  let current: ParentNode | null = node;

  while (current !== null) {
    if (current === container) {
      return true;
    }

    current = current.parent;
  }

  return false;
}

export function getTranscriptSelectionText(
  selection: SelectionLike,
  transcript: ParentNode,
): string | null {
  if (
    selection.selectedRenderables.length === 0 ||
    !selection.selectedRenderables.every((renderable) =>
      isDescendantOf(renderable, transcript),
    )
  ) {
    return null;
  }

  const text = selection.getSelectedText();
  return text.length === 0 ? null : text;
}

export function copiedCharactersMessage(text: string): string {
  return `${Array.from(text).length} chars copied`;
}
