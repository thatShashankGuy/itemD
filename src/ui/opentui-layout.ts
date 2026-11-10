export const SIDEBAR_MIN_COLUMNS = 100;

export type SidebarModel = {
  workspaceName: string;
  sessionId: string;
  provider: string;
  model: string;
  effort: string;
  webSearchEnabled: boolean;
  recentSessions: readonly RecentSessionModel[];
};

export type RecentSessionModel = {
  id: string;
  workspaceName: string;
  updatedAt: string;
  active: boolean;
};

export function shouldShowSidebar(width: number): boolean {
  return Number.isFinite(width) && width >= SIDEBAR_MIN_COLUMNS;
}

export function formatSidebarContent(model: SidebarModel): string {
  const recentSessions = model.recentSessions.length === 0
    ? ["(none)"]
    : model.recentSessions.map((session) => {
      const marker = session.active ? "*" : " ";
      const shortId = session.id.slice(0, 8);
      return `${marker} ${shortId}  ${formatSessionTime(session.updatedAt)}`;
    });

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
    "RECENT SESSIONS",
    ...recentSessions,
    "",
    "SHORTCUTS",
    "Esc  stop active task",
    "Ctrl+C  exit itemD",
    "/  command palette",
  ].join("\n");
}

function formatSessionTime(updatedAt: string): string {
  return updatedAt.replace("T", " ").slice(5, 16);
}
