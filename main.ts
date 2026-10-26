import { executeCommand } from "./src/shell.ts";

async function main(): Promise<void>{
  const process_1 = await executeCommand(
    process.execPath,
    ["-e", "console.log('testing from harness')"],
      process.cwd()
  )
  const process_2 = await executeCommand(
    process.execPath,
    ["-e", "console.warn('testing from harness')"],
      process.cwd()
  )
  const failed_process = await executeCommand(
    process.execPath,
    ["-e", "console.wrong('testing from harness')"],
      process.cwd()
  )

  const seprate_cmd = await executeCommand(
    "git",
    ["--help"],
    process.cwd()
  )
  console.log([
    process_1,
    process_2,
    failed_process,
    seprate_cmd
  ]);
}

main().catch((error: unknown) => {
  console.error("Could not start the command", error);
  process.exitCode = -1;
})
