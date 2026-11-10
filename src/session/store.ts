import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ModelMessage, ModelToolRequest } from "../model/types.ts";
import { isRecord } from "../shared/runtime.ts";

const SESSION_DATABASE_FILE = "sessions.db";
const DEFAULT_SESSION_LIMIT = 10;

export type Session = {
  id: string;
  workspaceRoot: string;
  createdAt: string;
  updatedAt: string;
};

export type SessionStoreOptions = {
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
  clock?: () => Date;
};

export type SessionStoreErrorCode =
  | "SESSION_NOT_FOUND"
  | "INVALID_MESSAGE"
  | "STORE_CLOSED";

export class SessionStoreError extends Error {
  readonly code: SessionStoreErrorCode;

  constructor(code: SessionStoreErrorCode, message: string) {
    super(message);
    this.name = "SessionStoreError";
    this.code = code;
  }
}

function defaultSessionDirectory(env: NodeJS.ProcessEnv): string {
  if (process.platform === "win32" && env.APPDATA !== undefined) {
    return join(env.APPDATA, "itemd");
  }

  if (process.platform === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "itemd",
    );
  }

  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "itemd");
}

export function getSessionStorePath(
  options: Pick<SessionStoreOptions, "dbPath" | "env"> = {},
): string {
  const env = options.env ?? process.env;
  return resolve(
    options.dbPath ??
      env.ITEMD_SESSION_DB_PATH ??
      join(defaultSessionDirectory(env), SESSION_DATABASE_FILE),
  );
}

function toIsoTimestamp(value: Date): string {
  return value.toISOString();
}

function readString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new SessionStoreError(
      "INVALID_MESSAGE",
      `Stored message field ${field} is invalid`,
    );
  }

  return value;
}

function readToolCall(value: unknown): ModelToolRequest {
  if (!isRecord(value)) {
    throw new SessionStoreError(
      "INVALID_MESSAGE",
      "Stored assistant tool call is invalid",
    );
  }

  return {
    id: readString(value.id, "tool call id"),
    name: readString(value.name, "tool call name"),
    arguments: readString(value.arguments, "tool call arguments"),
  };
}

function parseModelMessage(value: unknown): ModelMessage {
  if (!isRecord(value) || typeof value.role !== "string") {
    throw new SessionStoreError(
      "INVALID_MESSAGE",
      "Stored message must include a valid role",
    );
  }

  if (value.role === "user") {
    return {
      role: "user",
      content: readString(value.content, "user content"),
    };
  }

  if (value.role === "tool") {
    return {
      role: "tool",
      toolCallId: readString(value.toolCallId, "tool call id"),
      content: readString(value.content, "tool content"),
    };
  }

  if (value.role === "assistant") {
    if (value.content !== null && typeof value.content !== "string") {
      throw new SessionStoreError(
        "INVALID_MESSAGE",
        "Stored assistant content is invalid",
      );
    }

    const reasoning = value.reasoning;
    if (
      reasoning !== undefined &&
      reasoning !== null &&
      typeof reasoning !== "string"
    ) {
      throw new SessionStoreError(
        "INVALID_MESSAGE",
        "Stored assistant reasoning is invalid",
      );
    }

    const toolCalls = value.toolCalls;
    if (toolCalls !== undefined && !Array.isArray(toolCalls)) {
      throw new SessionStoreError(
        "INVALID_MESSAGE",
        "Stored assistant tool calls are invalid",
      );
    }

    return {
      role: "assistant",
      content: value.content,
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(toolCalls === undefined
        ? {}
        : { toolCalls: toolCalls.map(readToolCall) }),
    };
  }

  throw new SessionStoreError(
    "INVALID_MESSAGE",
    `Stored message role ${value.role} is unsupported`,
  );
}

function parseSessionRow(row: Record<string, unknown>): Session {
  return {
    id: readString(row.id, "session id"),
    workspaceRoot: readString(row.workspace_root, "workspace root"),
    createdAt: readString(row.created_at, "created at"),
    updatedAt: readString(row.updated_at, "updated at"),
  };
}

function parseStoredMessageRow(row: Record<string, unknown>): ModelMessage {
  if (typeof row.id !== "number") {
    throw new SessionStoreError("INVALID_MESSAGE", "Stored message id is invalid");
  }

  const storedRole = readString(row.role, "role");
  const messageJson = readString(row.message_json, "message");
  let parsed: unknown;

  try {
    parsed = JSON.parse(messageJson) as unknown;
  } catch {
    throw new SessionStoreError(
      "INVALID_MESSAGE",
      "Stored message is not valid JSON",
    );
  }

  const message = parseModelMessage(parsed);

  if (message.role !== storedRole) {
    throw new SessionStoreError(
      "INVALID_MESSAGE",
      "Stored message role does not match its payload",
    );
  }

  return message;
}

async function prepareDatabase(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  const database = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    timeout: 5_000,
  });

  try {
    database.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        workspace_root TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        message_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS messages_session_id_id
        ON messages(session_id, id);
      CREATE INDEX IF NOT EXISTS sessions_updated_at
        ON sessions(updated_at DESC);
    `);
  } finally {
    database.close();
  }

  if (process.platform !== "win32") {
    await chmod(path, 0o600).catch(() => undefined);
  }
}

export async function openSessionStore(
  options: SessionStoreOptions = {},
): Promise<SessionStore> {
  const path = getSessionStorePath(options);
  await prepareDatabase(path);

  return new SessionStore(
    new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    }),
    options.clock ?? (() => new Date()),
  );
}

export class SessionStore {
  private closed = false;
  private readonly database: DatabaseSync;
  private readonly clock: () => Date;

  constructor(
    database: DatabaseSync,
    clock: () => Date = () => new Date(),
  ) {
    this.database = database;
    this.clock = clock;
  }

  createSession(workspaceRoot: string, now = this.clock()): Session {
    this.assertOpen();
    const session: Session = {
      id: randomUUID(),
      workspaceRoot,
      createdAt: toIsoTimestamp(now),
      updatedAt: toIsoTimestamp(now),
    };

    this.database
      .prepare(
        `INSERT INTO sessions (id, workspace_root, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.workspaceRoot,
        session.createdAt,
        session.updatedAt,
      );

    return session;
  }

  getSession(sessionId: string): Session | null {
    this.assertOpen();
    const row = this.database
      .prepare(
        `SELECT id, workspace_root, created_at, updated_at
         FROM sessions WHERE id = ?`,
      )
      .get(sessionId);

    return row === undefined ? null : parseSessionRow(row);
  }

  listSessions(limit = DEFAULT_SESSION_LIMIT): Session[] {
    this.assertOpen();
    const safeLimit = Math.max(0, Math.floor(limit));

    return this.database
      .prepare(
        `SELECT id, workspace_root, created_at, updated_at
         FROM sessions
         ORDER BY updated_at DESC, created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(safeLimit)
      .map(parseSessionRow);
  }

  appendMessage(
    sessionId: string,
    message: ModelMessage,
    now = this.clock(),
  ): void {
    this.assertOpen();

    if (this.getSession(sessionId) === null) {
      throw new SessionStoreError(
        "SESSION_NOT_FOUND",
        `Session ${sessionId} was not found`,
      );
    }

    const createdAt = toIsoTimestamp(now);
    const messageJson = JSON.stringify(parseModelMessage(message));

    this.database.exec("BEGIN");
    try {
      this.database
        .prepare(
          `INSERT INTO messages
             (session_id, role, message_json, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(sessionId, message.role, messageJson, createdAt);
      this.database
        .prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
        .run(createdAt, sessionId);
      this.database.exec("COMMIT");
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getMessages(sessionId: string): ModelMessage[] | null {
    this.assertOpen();

    if (this.getSession(sessionId) === null) {
      return null;
    }

    return this.database
      .prepare(
        `SELECT id, session_id, role, message_json, created_at
         FROM messages WHERE session_id = ? ORDER BY id ASC`,
      )
      .all(sessionId)
      .map(parseStoredMessageRow);
  }

  deleteSession(sessionId: string): boolean {
    this.assertOpen();
    const result = this.database
      .prepare("DELETE FROM sessions WHERE id = ?")
      .run(sessionId);
    return Number(result.changes) > 0;
  }

  pruneSessions(keep = DEFAULT_SESSION_LIMIT): number {
    this.assertOpen();
    const safeKeep = Math.max(0, Math.floor(keep));
    const result = this.database
      .prepare(
        `DELETE FROM sessions
         WHERE id NOT IN (
           SELECT id FROM sessions
           ORDER BY updated_at DESC, created_at DESC, id DESC
           LIMIT ?
         )`,
      )
      .run(safeKeep);
    return Number(result.changes);
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.database.close();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new SessionStoreError("STORE_CLOSED", "Session store is closed");
    }
  }
}
