export type TuiCommand = {
  name: `/${string}`;
  usage: string;
  description: string;
};

export const TUI_COMMANDS = [
  {
    name: "/help",
    usage: "/help",
    description: "Show commands and keyboard controls",
  },
  {
    name: "/config",
    usage: "/config",
    description: "Show the active provider, model, and effort",
  },
  {
    name: "/reload",
    usage: "/reload",
    description: "Reload the API key and model config",
  },
  {
    name: "/setup",
    usage: "/setup",
    description: "Reconfigure provider, model, effort, and API key",
  },
  {
    name: "/adapter",
    usage: "/adapter",
    description: "Select a model adapter (alias for /setup)",
  },
  {
    name: "/replays",
    usage: "/replays",
    description: "List recorded runs",
  },
  {
    name: "/replay",
    usage: "/replay <trace-id>",
    description: "Display a recorded run without model access",
  },
  {
    name: "/clear",
    usage: "/clear",
    description: "Clear the transcript",
  },
  {
    name: "/exit",
    usage: "/exit",
    description: "Exit itemD",
  },
] as const satisfies readonly TuiCommand[];

export function suggestTuiCommands(input: string): readonly TuiCommand[] {
  const commandText = input.trimStart();

  if (/\s/.test(commandText)) {
    return [];
  }

  const prefix = commandText.toLowerCase();

  if (!prefix.startsWith("/")) {
    return [];
  }

  return TUI_COMMANDS.filter((command) =>
    command.name.startsWith(prefix),
  );
}

export function formatTuiCommandHelp(): string {
  const usageWidth = Math.max(
    ...TUI_COMMANDS.map((command) => command.usage.length),
  );

  return TUI_COMMANDS.map(
    (command) =>
      `${command.usage.padEnd(usageWidth)}  ${command.description}`,
  ).join("\n");
}
