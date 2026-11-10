import type { ModelMessage } from "../model/types.ts";
import {
  SessionStoreError,
  type Session,
  type SessionStore,
} from "./store.ts";

export const DEFAULT_SESSION_RETENTION = 10;

export type SessionContext = {
  session: Session;
  messages: ModelMessage[];
};

export type SessionServiceErrorCode =
  | "SESSION_NOT_FOUND"
  | "SESSION_WORKSPACE_MISMATCH";

export type SessionServiceError = {
  code: SessionServiceErrorCode;
  message: string;
};

export type ResumeSessionResult =
  | { ok: true; context: SessionContext }
  | { ok: false; error: SessionServiceError };

function serviceError(
  code: SessionServiceErrorCode,
  message: string,
): { ok: false; error: SessionServiceError } {
  return { ok: false, error: { code, message } };
}

export type SessionServiceOptions = {
  retentionLimit?: number;
};

export class SessionService {
  private readonly retentionLimit: number;
  private readonly store: SessionStore;

  constructor(
    store: SessionStore,
    options: SessionServiceOptions = {},
  ) {
    this.store = store;
    this.retentionLimit = Math.max(
      1,
      Math.floor(options.retentionLimit ?? DEFAULT_SESSION_RETENTION),
    );
  }

  createSession(workspaceRoot: string): SessionContext {
    const session = this.store.createSession(workspaceRoot);
    this.store.pruneSessions(this.retentionLimit);
    return { session, messages: [] };
  }

  resumeSession(
    sessionId: string,
    workspaceRoot: string,
  ): ResumeSessionResult {
    const session = this.store.getSession(sessionId);

    if (session === null) {
      return serviceError(
        "SESSION_NOT_FOUND",
        `Session ${sessionId} was not found`,
      );
    }

    if (session.workspaceRoot !== workspaceRoot) {
      return serviceError(
        "SESSION_WORKSPACE_MISMATCH",
        "Session belongs to a different workspace",
      );
    }

    const messages = this.store.getMessages(sessionId);

    if (messages === null) {
      return serviceError(
        "SESSION_NOT_FOUND",
        `Session ${sessionId} was not found`,
      );
    }

    return { ok: true, context: { session, messages } };
  }

  listSessions(limit = DEFAULT_SESSION_RETENTION): Session[] {
    return this.store.listSessions(limit);
  }

  appendMessage(sessionId: string, message: ModelMessage): SessionContext {
    try {
      this.store.appendMessage(sessionId, message);
    } catch (error: unknown) {
      if (
        error instanceof SessionStoreError &&
        error.code === "SESSION_NOT_FOUND"
      ) {
        throw new SessionStoreError(
          "SESSION_NOT_FOUND",
          `Session ${sessionId} was not found`,
        );
      }

      throw error;
    }

    this.store.pruneSessions(this.retentionLimit);
    const session = this.store.getSession(sessionId);
    const messages = this.store.getMessages(sessionId);

    if (session === null || messages === null) {
      throw new SessionStoreError(
        "SESSION_NOT_FOUND",
        `Session ${sessionId} was not found`,
      );
    }

    return { session, messages };
  }

  deleteSession(sessionId: string): boolean {
    return this.store.deleteSession(sessionId);
  }

  close(): void {
    this.store.close();
  }
}
