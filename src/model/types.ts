export type ModelRequest = {
  requestId?: string;
  message: string;
  signal?: AbortSignal;
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

export interface ModelBridge {
  respond(request: ModelRequest): Promise<ModelResponse>;
  getLastExecutionSummary?(): ModelExecutionSummary | null;
}
