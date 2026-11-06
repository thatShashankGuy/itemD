export function isRecord(
  input: unknown,
): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
