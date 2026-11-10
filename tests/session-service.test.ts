import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { ModelMessage } from "../src/model/types.ts";
import { SessionService } from "../src/session/service.ts";
import { openSessionStore, type SessionStore } from "../src/session/store.ts";

const temporaryDirectories: string[] = [];
const stores: SessionStore[] = [];

async function createService(
  options: { retentionLimit?: number } = {},
): Promise<SessionService> {
  const directory = await mkdtemp(join(tmpdir(), "itemd-session-service-test-"));
  temporaryDirectories.push(directory);
  const store = await openSessionStore({
    dbPath: join(directory, "sessions.db"),
  });
  stores.push(store);
  return new SessionService(store, options);
}

afterEach(async () => {
  for (const store of stores.splice(0)) {
    store.close();
  }

  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("session service", () => {
  test("creates a new empty session and lists recent sessions", async () => {
    const service = await createService();
    const context = service.createSession("/workspace/project");

    expect(context.messages).toEqual([]);
    expect(service.listSessions()).toEqual([context.session]);
  });

  test("appends messages and resumes their complete history", async () => {
    const service = await createService();
    const context = service.createSession("/workspace/project");
    const messages: ModelMessage[] = [
      { role: "user", content: "Fix the failing test" },
      { role: "assistant", content: "I found the failure." },
    ];

    service.appendMessage(context.session.id, messages[0]!);
    service.appendMessage(context.session.id, messages[1]!);

    expect(
      service.resumeSession(context.session.id, "/workspace/project"),
    ).toEqual({
      ok: true,
      context: {
        session: expect.objectContaining({ id: context.session.id }),
        messages,
      },
    });
  });

  test("rejects a missing or different-workspace session", async () => {
    const service = await createService();
    const context = service.createSession("/workspace/project");

    expect(service.resumeSession("missing", "/workspace/project")).toEqual({
      ok: false,
      error: {
        code: "SESSION_NOT_FOUND",
        message: "Session missing was not found",
      },
    });
    expect(
      service.resumeSession(context.session.id, "/workspace/other"),
    ).toEqual({
      ok: false,
      error: {
        code: "SESSION_WORKSPACE_MISMATCH",
        message: "Session belongs to a different workspace",
      },
    });
  });

  test("prunes old sessions after creating and saving messages", async () => {
    const service = await createService({ retentionLimit: 2 });
    const sessions = [
      service.createSession("/workspace/one"),
      service.createSession("/workspace/two"),
      service.createSession("/workspace/three"),
    ];

    service.appendMessage(sessions[2]!.session.id, {
      role: "user",
      content: "Keep this session active",
    });

    expect(service.listSessions(10)).toHaveLength(2);
    expect(service.resumeSession(sessions[0]!.session.id, "/workspace/one")).toEqual({
      ok: false,
      error: {
        code: "SESSION_NOT_FOUND",
        message: `Session ${sessions[0]!.session.id} was not found`,
      },
    });
  });
});
