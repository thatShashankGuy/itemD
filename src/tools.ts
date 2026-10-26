import {
  readFile,
  readdir,
  writedir,
} from "node:fs/promises"

export type ToolCall =
{
  type: "read_file";
  path: string;
  } | {
    type: "write_file";
    path: string;
    content: string;
  } | {
    type: "list_file";
    path:string
  } | {
    type: "shell",
    executable: string;
    args: [];
  }

export type ToolResult = {
  ok: true; output:string
} | {
    ok:false,error:string
  }


export async function executeTool(
  call: ToolCall,
  cwd: string,
):Promise<ToolCall> {
  switch (call.type) {
    case "list_file":
      //todo
    case "read_file":
      const filPath = resolve(cwd, call.path);
      const content = await readFile("filePath","utf8")
    case "shell":
      //todo
    case "write_file":
      //todo
  }
}
