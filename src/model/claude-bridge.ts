import { resolve } from "node:path";
import type { Logger } from "../logging/audit";
import { correlationFields } from "../logging/correlation";
import type {
  ModelBridge,
  ModelExecutionSummary,
  ModelRequest,
  ModelResponse,
} from "./types";

type BridgeOptions = {
  cwd?: string;
  env?: Record<string, string>;
};

type ClaudeJsonResponse = {
  type: "result";
  subtype?: "success" | "error";
  is_error?: boolean;
  result: string;
  duration_ms?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    server_tool_use?: {
      web_search_requests?: number;
      web_fetch_requests?: number;
    };
  };
  session_id?: string;
  total_cost_usd?: number;
  stop_reason?: string | null;
};

type ClaudeAuditAction = {
  type: "web_search" | "web_fetch";
  detail: string;
};

function previewLogText(value: string, max = 240): string {
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max)}...`;
}

function buildPromptText(request: ModelRequest): string {
  return request.message;
}

export function extractClaudeAuditActions(
  jsonResponse: ClaudeJsonResponse,
): ClaudeAuditAction[] {
  const actions: ClaudeAuditAction[] = [];
  const usage = jsonResponse.usage;

  if (!usage || !usage.server_tool_use) {
    return actions;
  }

  const searches = usage.server_tool_use.web_search_requests ?? 0;
  const fetches = usage.server_tool_use.web_fetch_requests ?? 0;

  if (searches > 0) {
    actions.push({
      type: "web_search",
      detail: `${searches} search${searches === 1 ? "" : "es"}`,
    });
  }

  if (fetches > 0) {
    actions.push({
      type: "web_fetch",
      detail: `${fetches} fetch${fetches === 1 ? "" : "es"}`,
    });
  }

  return actions;
}

export class ClaudeBridge implements ModelBridge {
  private readonly cwd?: string;
  private readonly rootDir: string;
  private readonly envOverrides?: Record<string, string>;
  private lastExecutionSummary: ModelExecutionSummary | null = null;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly logger: Logger,
    options: BridgeOptions = {},
  ) {
    this.cwd = options.cwd;
    this.rootDir = resolve(options.cwd ?? process.cwd());
    this.envOverrides = options.env;
  }

  async respond(request: ModelRequest): Promise<ModelResponse> {
    throw new Error("Not implemented");
  }

  getLastExecutionSummary(): ModelExecutionSummary | null {
    return this.lastExecutionSummary;
  }
}
