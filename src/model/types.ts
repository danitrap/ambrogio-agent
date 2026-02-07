import type { HydratedSkill } from "../skills/discovery";

export type ToolCall = {
  tool: "list_files" | "read_file" | "write_file" | "search";
  args: Record<string, unknown>;
};

export type ModelRequest = {
  message: string;
  skills: HydratedSkill[];
};

export type ModelResponse = {
  text: string;
  toolCalls: ToolCall[];
};

export interface ModelBridge {
  respond(request: ModelRequest): Promise<ModelResponse>;
}
