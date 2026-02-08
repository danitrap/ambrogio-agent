export type CorrelationContext = {
  updateId?: number;
  userId?: number;
  chatId?: number;
  requestId?: string;
  command?: string;
};

export function correlationFields(context: CorrelationContext): Record<string, string | number> {
  const fields: Record<string, string | number> = {};
  if (typeof context.updateId === "number") {
    fields.updateId = context.updateId;
  }
  if (typeof context.userId === "number") {
    fields.userId = context.userId;
  }
  if (typeof context.chatId === "number") {
    fields.chatId = context.chatId;
  }
  if (typeof context.requestId === "string" && context.requestId.length > 0) {
    fields.requestId = context.requestId;
  }
  if (typeof context.command === "string" && context.command.length > 0) {
    fields.command = context.command;
  }
  return fields;
}

