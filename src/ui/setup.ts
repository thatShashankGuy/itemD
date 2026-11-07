import {
  stdin as input,
  stdout as output,
} from "node:process";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import {
  ITEMD_CONFIG_VERSION,
  type ConfigurationOptions,
  type ItemDConfiguration,
  writeConfiguration,
} from "../config/configuration.ts";
import { PROVIDER_CATALOG } from "../model/catalog.ts";
import type { EnabledProviderDefinition } from "../model/contracts.ts";

export type QuestionOptions = {
  masked?: boolean;
};

export interface TuiIO {
  readonly interrupted: boolean;
  question(
    prompt: string,
    options?: QuestionOptions,
  ): Promise<string | null>;
  write(text: string): void;
  close(): void;
}

class MaskableOutput extends Writable {
  masked = false;

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.masked) {
      output.write(chunk);
    }

    callback();
  }
}

export class TerminalTuiIO implements TuiIO {
  interrupted = false;
  private readonly maskedOutput = new MaskableOutput();
  private readonly readline = createInterface({
    input,
    output: this.maskedOutput,
    terminal: true,
  });

  constructor() {
    this.readline.on("SIGINT", () => {
      this.interrupted = true;
      output.write("\n");
      this.readline.close();
    });
  }

  async question(
    prompt: string,
    options: QuestionOptions = {},
  ): Promise<string | null> {
    if (this.interrupted) {
      return null;
    }

    try {
      if (!options.masked) {
        return await this.readline.question(prompt);
      }

      output.write(prompt);
      this.maskedOutput.masked = true;

      try {
        return await this.readline.question("");
      } finally {
        this.maskedOutput.masked = false;

        if (!this.interrupted) {
          output.write("\n");
        }
      }
    } catch (error: unknown) {
      if (this.interrupted) {
        return null;
      }

      throw error;
    }
  }

  write(text: string): void {
    output.write(text);
  }

  close(): void {
    this.readline.close();
  }
}

function writeLine(io: TuiIO, text = ""): void {
  io.write(`${text}\n`);
}

async function askForIndex(
  io: TuiIO,
  prompt: string,
  choiceCount: number,
): Promise<number | null> {
  while (true) {
    const answer = await io.question(prompt);

    if (answer === null) {
      return null;
    }

    const index = Number(answer.trim()) - 1;

    if (Number.isInteger(index) && index >= 0 && index < choiceCount) {
      return index;
    }

    writeLine(io, `Choose a number from 1 to ${choiceCount}.`);
  }
}

async function selectProvider(
  io: TuiIO,
): Promise<EnabledProviderDefinition | null> {
  while (true) {
    writeLine(io, "Select a provider:");

    PROVIDER_CATALOG.forEach((provider, index) => {
      const status = provider.enabled
        ? ""
        : ` — ${provider.disabledMessage}`;
      writeLine(io, `  ${index + 1}. ${provider.displayName}${status}`);
    });

    const index = await askForIndex(
      io,
      "Provider: ",
      PROVIDER_CATALOG.length,
    );

    if (index === null) {
      return null;
    }

    const provider = PROVIDER_CATALOG[index];

    if (provider === undefined) {
      continue;
    }

    if (!provider.enabled) {
      writeLine(io, `${provider.displayName}: ${provider.disabledMessage}`);
      writeLine(io);
      continue;
    }

    return provider;
  }
}

export type SetupResult =
  | { status: "saved" }
  | { status: "cancelled" }
  | { status: "failed" };

export async function runSetup(
  io: TuiIO,
  configOptions: ConfigurationOptions = {},
): Promise<SetupResult> {
  writeLine(io, "Model setup");
  writeLine(io);

  const provider = await selectProvider(io);

  if (provider === null) {
    return { status: "cancelled" };
  }

  writeLine(io, "Select a model:");
  provider.models.forEach((model, index) => {
    const suffix = model.id === provider.defaultModel ? " (default)" : "";
    writeLine(io, `  ${index + 1}. ${model.displayName}${suffix}`);
  });
  const modelIndex = await askForIndex(
    io,
    "Model: ",
    provider.models.length,
  );

  if (modelIndex === null) {
    return { status: "cancelled" };
  }

  const model = provider.models[modelIndex];

  if (model === undefined) {
    return { status: "failed" };
  }

  writeLine(io, "Select reasoning effort:");
  provider.reasoningEfforts.forEach((effort, index) => {
    const suffix = effort.id === provider.defaultEffort ? " (default)" : "";
    writeLine(io, `  ${index + 1}. ${effort.displayName}${suffix}`);
  });
  const effortIndex = await askForIndex(
    io,
    "Effort: ",
    provider.reasoningEfforts.length,
  );

  if (effortIndex === null) {
    return { status: "cancelled" };
  }

  const effort = provider.reasoningEfforts[effortIndex];

  if (effort === undefined) {
    return { status: "failed" };
  }

  let apiKey: string;

  while (true) {
    const answer = await io.question("API key: ", { masked: true });

    if (answer === null) {
      return { status: "cancelled" };
    }

    apiKey = answer.trim();

    if (apiKey.length > 0) {
      break;
    }

    writeLine(io, "API key cannot be empty.");
  }

  const configuration: ItemDConfiguration = {
    version: ITEMD_CONFIG_VERSION,
    provider: provider.id,
    model: model.id,
    effort: effort.id,
    apiKey,
  };

  writeLine(io);
  writeLine(io, "Setup summary:");
  writeLine(io, `  provider: ${provider.displayName}`);
  writeLine(io, `  model: ${model.displayName}`);
  writeLine(io, `  effort: ${effort.displayName}`);

  const writeResult = await writeConfiguration(
    configuration,
    configOptions,
  );

  if (!writeResult.ok) {
    writeLine(io, `[configuration error] ${writeResult.error.message}`);
    return { status: "failed" };
  }

  writeLine(io, "Configuration saved.");
  writeLine(io);

  return { status: "saved" };
}
