export type ScheduledRecurrenceType = "interval" | "cron" | null;
export type ScheduledJobKind = "background" | "delayed" | "recurring";

export const HEADLESS_NOTIFICATION_SENT_TOKEN = "[HEADLESS_NOTIFICATION_SENT]";
export const HEADLESS_NO_MESSAGE_TOKEN = "[HEADLESS_NO_MESSAGE]";
export const HEADLESS_CRON_SENT_MESSAGE_TOKEN = HEADLESS_NOTIFICATION_SENT_TOKEN;
export const HEADLESS_CRON_NO_MESSAGE_TOKEN = HEADLESS_NO_MESSAGE_TOKEN;
const HEADLESS_CRON_MARKER = "[Execution Mode: HEADLESS_CRON]";
const HEADLESS_SCHEDULED_MARKER = "[Execution Mode: HEADLESS_SCHEDULED]";
const BACKGROUND_JOB_HEADER = "⏰ [Background Job]";

function stripBackgroundJobHeader(prompt: string): string {
  if (prompt.startsWith(BACKGROUND_JOB_HEADER)) {
    return prompt.slice(BACKGROUND_JOB_HEADER.length).trimStart();
  }
  return prompt;
}

function isHeadlessPrompt(prompt: string): boolean {
  return prompt.includes(HEADLESS_CRON_MARKER) || prompt.includes(HEADLESS_SCHEDULED_MARKER);
}

function shouldApplyHeadlessMode(kind: ScheduledJobKind, recurrenceType: ScheduledRecurrenceType): boolean {
  return kind === "delayed" || kind === "recurring";
}

export function shouldDisableImplicitScheduledDelivery(
  kind: ScheduledJobKind,
  recurrenceType: ScheduledRecurrenceType,
): boolean {
  return shouldApplyHeadlessMode(kind, recurrenceType);
}

export function ensureHeadlessScheduledPrompt(prompt: string): string {
  const normalizedPrompt = prompt.trim();
  if (isHeadlessPrompt(normalizedPrompt)) {
    if (normalizedPrompt.startsWith(BACKGROUND_JOB_HEADER)) {
      return normalizedPrompt;
    }
    return `${BACKGROUND_JOB_HEADER}\n\n${normalizedPrompt}`;
  }

  const userPrompt = stripBackgroundJobHeader(normalizedPrompt).trim();
  return [
    BACKGROUND_JOB_HEADER,
    "",
    HEADLESS_SCHEDULED_MARKER,
    "Questo job schedulato gira senza chat interattiva.",
    "Se il job e mutato (`mutedUntil` nel futuro), il runtime lo salta prima di eseguire questo prompt.",
    "Se vuoi notificare l'utente DEVI usare il tool Telegram (es. ambrogioctl telegram send-message --text \"...\").",
    "Il runtime NON invia mai risposte implicite per questo job.",
    "Non aggiungere testo finale: usa solo tool (ambrogioctl) se devi notificare.",
    "",
    userPrompt,
  ].join("\n");
}

export function ensureCronHeadlessPrompt(prompt: string): string {
  return ensureHeadlessScheduledPrompt(prompt);
}

export function buildScheduledJobExecutionPrompt(
  prompt: string,
  kind: ScheduledJobKind,
  recurrenceType: ScheduledRecurrenceType,
): string {
  const basePrompt = `${BACKGROUND_JOB_HEADER}\n\n${prompt}`;
  if (!shouldApplyHeadlessMode(kind, recurrenceType)) {
    return basePrompt;
  }
  return ensureHeadlessScheduledPrompt(prompt);
}

export function shouldSuppressScheduledJobDelivery(
  reply: string,
  kind: ScheduledJobKind,
  recurrenceType: ScheduledRecurrenceType,
): boolean {
  const normalized = reply.trim();
  const canonical = normalized.toUpperCase().replaceAll(/[^A-Z]/g, "");
  if (canonical === "HEADLESSNOTIFICATIONSENT" || canonical === "HEADLESSNOMESSAGE") {
    return true;
  }
  if (canonical.includes("HEADLESS") && (canonical.includes("NOTIFICATIONSENT") || canonical.includes("NOMESSAGE"))) {
    return true;
  }
  if (!shouldApplyHeadlessMode(kind, recurrenceType)) {
    return false;
  }
  return normalized === HEADLESS_NOTIFICATION_SENT_TOKEN || normalized === HEADLESS_NO_MESSAGE_TOKEN;
}
