export const SIDEBAR_MIN_COLUMNS = 100;

export type SidebarModel = {
  workspaceName: string;
  sessionId: string;
  provider: string;
  model: string;
  effort: string;
  webSearchEnabled: boolean;
};

export function shouldShowSidebar(width: number): boolean {
  return Number.isFinite(width) && width >= SIDEBAR_MIN_COLUMNS;
}

export function formatSidebarContent(model: SidebarModel): string {
  return [
    "WORKSPACE",
    model.workspaceName,
    "",
    "SESSION",
    model.sessionId,
    "",
    "MODEL",
    `${model.provider} / ${model.model}`,
    `effort: ${model.effort}`,
    `web search: ${model.webSearchEnabled ? "on" : "off"}`,
    "",
    "SHORTCUTS",
    "Esc  stop active task",
    "Ctrl+C  exit itemD",
    "/  command palette",
  ].join("\n");
}
