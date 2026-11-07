export type ShellInputResult =
  | {
      ok: true;
      executable: string;
      args: string[];
    }
  | {
      ok: false;
      message: string;
    };

/**
 * Parses a user-facing `!` command into argv without invoking a shell.
 * Quotes group arguments, but shell operators remain ordinary arguments and
 * are never evaluated.
 */
export function parseShellInput(input: string): ShellInputResult {
  const tokens: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "single" | "double" | null = null;
  let escaping = false;

  for (const character of input.trim()) {
    if (escaping) {
      token += character;
      tokenStarted = true;
      escaping = false;
      continue;
    }

    if (quote === "single") {
      if (character === "'") {
        quote = null;
      } else {
        token += character;
        tokenStarted = true;
      }
      continue;
    }

    if (quote === "double") {
      if (character === '"') {
        quote = null;
      } else if (character === "\\") {
        escaping = true;
      } else {
        token += character;
        tokenStarted = true;
      }
      continue;
    }

    if (character === "\\") {
      escaping = true;
    } else if (character === "'") {
      quote = "single";
      tokenStarted = true;
    } else if (character === '"') {
      quote = "double";
      tokenStarted = true;
    } else if (/\s/.test(character)) {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
    } else {
      token += character;
      tokenStarted = true;
    }
  }

  if (escaping) {
    return { ok: false, message: "Shell command ends with an escape character" };
  }

  if (quote !== null) {
    return { ok: false, message: "Shell command has an unterminated quote" };
  }

  if (tokenStarted) {
    tokens.push(token);
  }

  const executable = tokens[0];

  if (executable === undefined || executable.length === 0) {
    return { ok: false, message: "Usage: !<command> [args...]" };
  }

  return {
    ok: true,
    executable,
    args: tokens.slice(1),
  };
}
