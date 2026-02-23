export type ModelRequest = {
  requestId?: string;
  message: string;
  signal?: AbortSignal;
  onToolCallEvent?: (event: ModelToolCallEvent) => Promise<void> | void;
};

export type ModelResponse = {
  text: string;
};

export type ModelExecutionSummary = {
  requestId?: string;
  command: string;
  startedAt: string;
  durationMs?: number;
  status: "running" | "completed" | "empty_output" | "error";
  exitCode?: number;
  promptLength: number;
  stdoutLength?: number;
  stderrLength?: number;
  outputLength?: number;
  stdoutPreview?: string;
  stderrPreview?: string;
  outputPreview?: string;
  errorMessage?: string;
};

export type ModelToolCallEvent = {
  backend: "codex" | "claude";
  type: "shell_exec" | "web_search" | "web_fetch" | "claude_tool_call";
  detail: string;
  phase: "realtime" | "final_summary";
  toolName?: string;
  source?: "tool_use" | "usage_summary";
};

export interface ModelBridge {
  respond(request: ModelRequest): Promise<ModelResponse>;
  getLastExecutionSummary?(): ModelExecutionSummary | null;
}
