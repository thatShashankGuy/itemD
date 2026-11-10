import {
  mkdtemp,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  getSessionStorePath,
  openSessionStore,
  SessionStoreError,
  type Session,
  type SessionStore,
} from "../src/session/store.ts";
import type { ModelMessage } from "../src/model/types.ts";

const temporaryDirectories: string[] = [];
const stores: SessionStore[] = [];

async function createDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "itemd-session-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "nested", "sessions.db");
}

function time(day: number): Date {
  return new Date(Date.UTC(2026, 0, day));
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

describe("session store", () => {
  test("creates the schema and round-trips sessions and model messages", async () => {
    const dbPath = await createDatabasePath();
    const store = await openSessionStore({ dbPath });
    stores.push(store);

    const session = store.createSession("/workspace/project", time(1));
    const messages: ModelMessage[] = [
      { role: "user", content: "Fix the failing test" },
      {
        role: "assistant",
        content: null,
        reasoning: "Inspect the test first",
        toolCalls: [
          { id: "call-1", name: "read_file", arguments: '{"path":"test.ts"}' },
        ],
      },
      {
        role: "tool",
        toolCallId: "call-1",
        content: JSON.stringify({ output: "failure" }),
      },
    ];

    store.appendMessage(session.id, messages[0]!, time(2));
    store.appendMessage(session.id, messages[1]!, time(3));
    store.appendMessage(session.id, messages[2]!, time(4));

    expect(store.getSession(session.id)).toEqual({
      ...session,
      updatedAt: time(4).toISOString(),
    });
    expect(store.getMessages(session.id)).toEqual(messages);

    store.close();
    const reopened = await openSessionStore({ dbPath });
    stores.push(reopened);

    expect(reopened.getSession(session.id)).toEqual({
      ...session,
      updatedAt: time(4).toISOString(),
    });
    expect(reopened.getMessages(session.id)).toEqual(messages);

    if (process.platform !== "win32") {
      expect((await stat(dbPath)).mode & 0o777).toBe(0o600);
    }
  });

  test("lists sessions newest first and prunes everything after the retention limit", async () => {
    const store = await openSessionStore({ dbPath: await createDatabasePath() });
    stores.push(store);
    const sessions: Session[] = [];

    for (let day = 1; day <= 12; day += 1) {
      const session = store.createSession(`/workspace/${day}`, time(day));
      store.appendMessage(
        session.id,
        { role: "user", content: `task ${day}` },
        time(day),
      );
      sessions.push(session);
    }

    expect(store.listSessions()).toHaveLength(10);
    expect(store.listSessions().map((session) => session.workspaceRoot)).toEqual(
      Array.from({ length: 10 }, (_, index) => `/workspace/${12 - index}`),
    );
    expect(store.pruneSessions()).toBe(2);
    expect(store.listSessions(20)).toHaveLength(10);
    const oldest = sessions[0];
    const newest = sessions[11];
    if (oldest === undefined || newest === undefined) {
      throw new Error("Expected all test sessions to be created");
    }
    expect(store.getSession(oldest.id)).toBeNull();
    expect(store.getMessages(oldest.id)).toBeNull();
    expect(store.getSession(newest.id)).not.toBeNull();
  });

  test("returns null for unknown sessions and reports invalid writes", async () => {
    const store = await openSessionStore({ dbPath: await createDatabasePath() });
    stores.push(store);

    expect(store.getSession("missing")).toBeNull();
    expect(store.getMessages("missing")).toBeNull();
    expect(store.deleteSession("missing")).toBe(false);

    expect(() =>
      store.appendMessage("missing", { role: "user", content: "task" }),
    ).toThrowError(
      new SessionStoreError(
        "SESSION_NOT_FOUND",
        "Session missing was not found",
      ),
    );
  });

  test("supports an environment override for the default database path", () => {
    expect(
      getSessionStorePath({
        env: { ITEMD_SESSION_DB_PATH: "/tmp/itemd-custom/sessions.db" },
      }),
    ).toBe("/tmp/itemd-custom/sessions.db");
  });
});
