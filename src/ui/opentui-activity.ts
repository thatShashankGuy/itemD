export type ActivitySnapshot = {
  phase: string;
  message: string;
  step?: number;
};

export function formatActivitySnapshot(snapshot: ActivitySnapshot): string {
  const step = snapshot.step === undefined ? "" : `step ${snapshot.step}  •  `;
  return `${step}${snapshot.phase}  •  ${snapshot.message}`;
}

export function formatShellApprovalPanel(
  command: string,
): string {
  return [
    "The model wants to execute:",
    command,
    "",
    "[1] once    [2] allow this exact command later    [3] deny",
  ].join("\n");
}
