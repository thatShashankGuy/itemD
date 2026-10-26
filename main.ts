import {
  executeTool,
  type ToolCall,
} from "./src/tools.ts";

async function main(): Promise<void> {
  const calls: ToolCall[] = [
    {
      type: "list_file",
      path: ".",
    },
    {
      type: "read_file",
      path: "package.json",
    },
    {
      type: "write_file",
      path: "phase-2-demo.txt",
      content: "Written by the write_file tool.\n",
    },
    {
      type: "shell",
      executable: process.execPath,
      args: ["-e", "console.log('Shell tool works')"],
    },
    {
      type: "shell",
      executable: process.execPath,
      args: ["-e", "console.error('Expected failure'); process.exit(1)"],
    },
  ];

  for (const call of calls) {
    const result = await executeTool(call, process.cwd());
    console.log(`\n${call.type}:`, result);
  }
}

main().catch((error: unknown) => {
  console.error("Unexpected harness failure:", error);
  process.exitCode = 1;
});
