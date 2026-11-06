import { isAbsolute } from "node:path";
import type { ToolCall, ToolError } from "../tools/contracts.ts";

type PolicyResult =
  | { ok: true }
  | {
      ok: false;
      error: ToolError;
    };

const ALLOWED_EXECUTABLES = new Set([
  "git",
  "ls",
  "node",
  "npm",
  "pwd",
  "python",
  "python3",
  "rg",
]);

const READ_ONLY_GIT_COMMANDS = new Set([
  "diff",
  "log",
  "show",
  "status",
]);

function denyCommand(message: string): PolicyResult {
  return {
    ok: false,
    error: {
      code: "COMMAND_DENIED",
      message,
    },
  };
}

function isSensitivePathPart(part: string): boolean {
  return (
    part === ".git" ||
    part === ".harness" ||
    part === ".env" ||
    part.startsWith(".env.")
  );
}

function isUnsafeArgument(argument: string): boolean {
  const normalized = argument.replaceAll("\\", "/");
  // Colons are included so Git object paths such as HEAD:.env are checked too.
  const parts = normalized.split(/[/:]/);

  return (
    argument.includes("\0") ||
    argument.includes("\n") ||
    argument.includes("\r") ||
    isAbsolute(argument) ||
    normalized.startsWith("~") ||
    normalized.includes("=/") ||
    parts.includes("..") ||
    parts.some(isSensitivePathPart)
  );
}

function validateGitCommand(args: string[]): PolicyResult {
  const subcommand = args[0] ?? "";

  if (!READ_ONLY_GIT_COMMANDS.has(subcommand)) {
    return denyCommand("Only read-only Git commands are allowed");
  }

  const forbiddenOptions = [
    "-c",
    "-o",
    "--config-env",
    "--exec-path",
    "--ext-diff",
    "--output",
    "--paginate",
    "--textconv",
  ];

  if (
    args.slice(1).some((argument) =>
      forbiddenOptions.some(
        (option) =>
          argument === option || argument.startsWith(`${option}=`),
      ),
    )
  ) {
    return denyCommand("Git command contains a forbidden option");
  }

  return { ok: true };
}

function validateNodeCommand(args: string[]): PolicyResult {
  const mode = args[0];

  if (mode === "--version" && args.length === 1) {
    return { ok: true };
  }

  if (mode === "--check" && args.length === 2) {
    return { ok: true };
  }

  if (mode === "--test") {
    const writesReporterOutput = args.some(
      (argument) =>
        argument === "--test-reporter-destination" ||
        argument.startsWith("--test-reporter-destination="),
    );

    return writesReporterOutput
      ? denyCommand("Node test output may not be redirected to a file")
      : { ok: true };
  }

  return denyCommand(
    "Node is limited to --version, --check, and --test",
  );
}

const PYTHON_TEST_MODULES = new Set(["pytest", "unittest"]);

/**
 * Mirrors the Node policy: version checks and test runners only.
 * Arbitrary Python code (`-c`, stdin, scripts, other `-m` modules) stays denied.
 */
function validatePythonCommand(args: string[]): PolicyResult {
  const [mode, ...rest] = args;

  if (mode === "--version" || mode === "-V") {
    return rest.length === 0
      ? { ok: true }
      : denyCommand("Python version flags do not accept arguments");
  }

  if (mode === "-m") {
    const moduleName = rest[0];

    if (moduleName === undefined) {
      return denyCommand("Python -m requires a module name");
    }

    return PYTHON_TEST_MODULES.has(moduleName)
      ? { ok: true }
      : denyCommand(
          "Python modules are limited to pytest and unittest",
        );
  }

  return denyCommand(
    "Python is limited to --version, -m pytest, and -m unittest",
  );
}

function validateNpmCommand(args: string[]): PolicyResult {
  if (args[0] !== "test") {
    return denyCommand("Only npm test is allowed");
  }

  if (args.length > 1 && args[1] !== "--") {
    return denyCommand("npm test options must follow --");
  }

  return { ok: true };
}

function validateRipgrepCommand(args: string[]): PolicyResult {
  const forbiddenOptions = [
    "--hidden",
    "--hostname-bin",
    "--no-ignore",
    "--pre",
    "-u",
    "-uu",
    "-uuu",
  ];

  const bypassesSafety = args.some((argument) =>
    forbiddenOptions.some(
      (option) =>
        argument === option || argument.startsWith(`${option}=`),
    ),
  );

  return bypassesSafety
    ? denyCommand("rg may not execute preprocessors or bypass ignored files")
    : { ok: true };
}

/**
 * Applies a conservative command allowlist before spawning a process.
 * This prevents common accidental host mutations; it is not a sandbox.
 */
export function validateShellPolicy(
  call: Extract<ToolCall, { type: "shell" }>,
): PolicyResult {
  if (!ALLOWED_EXECUTABLES.has(call.executable)) {
    return denyCommand(`Executable is not allowed: ${call.executable}`);
  }

  if (call.args.some(isUnsafeArgument)) {
    return denyCommand("Command contains an unsafe argument");
  }

  switch (call.executable) {
    case "pwd":
      return call.args.length === 0
        ? { ok: true }
        : denyCommand("pwd does not accept arguments");

    case "git":
      return validateGitCommand(call.args);

    case "node":
      return validateNodeCommand(call.args);

    case "python":
    case "python3":
      return validatePythonCommand(call.args);

    case "npm":
      return validateNpmCommand(call.args);

    case "rg":
      return validateRipgrepCommand(call.args);

    case "ls":
      return { ok: true };

    default:
      return denyCommand(
        `Executable has no configured policy: ${call.executable}`,
      );
  }
}
