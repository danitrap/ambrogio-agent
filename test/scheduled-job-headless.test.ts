import { describe, expect, test } from "bun:test";
import {
  buildScheduledJobExecutionPrompt,
  ensureHeadlessScheduledPrompt,
  HEADLESS_NO_MESSAGE_TOKEN,
  HEADLESS_NOTIFICATION_SENT_TOKEN,
  shouldDisableImplicitScheduledDelivery,
  shouldSuppressScheduledJobDelivery,
} from "../src/runtime/scheduled-job-headless";

describe("scheduled-job-headless", () => {
  test("adds headless directives for cron jobs", () => {
    const prompt = buildScheduledJobExecutionPrompt("controlla meteo", "recurring", "cron");

    expect(prompt).toContain("[Background Job]");
    expect(prompt).toContain("HEADLESS");
    expect(prompt).toContain("NON invia mai risposte implicite");
    expect(prompt).toContain("controlla meteo");
  });

  test("adds headless directives for one-shot delayed jobs", () => {
    const prompt = buildScheduledJobExecutionPrompt("ricordami alle 18", "delayed", null);

    expect(prompt).toContain("[Execution Mode: HEADLESS_SCHEDULED]");
    expect(prompt).toContain("ricordami alle 18");
  });

  test("adds headless directives for recurring interval jobs", () => {
    const prompt = buildScheduledJobExecutionPrompt("sync report", "recurring", "interval");

    expect(prompt).toContain("[Execution Mode: HEADLESS_SCHEDULED]");
    expect(prompt).toContain("ambrogioctl telegram send-message --text");
    expect(prompt).toContain("sync report");
  });

  test("suppresses delivery only for explicit headless tokens in headless modes", () => {
    expect(shouldSuppressScheduledJobDelivery(HEADLESS_NOTIFICATION_SENT_TOKEN, "recurring", "cron")).toBe(true);
    expect(shouldSuppressScheduledJobDelivery(HEADLESS_NO_MESSAGE_TOKEN, "delayed", null)).toBe(true);
    expect(shouldSuppressScheduledJobDelivery("ok inviato", "delayed", null)).toBe(false);
    expect(shouldSuppressScheduledJobDelivery(HEADLESS_NOTIFICATION_SENT_TOKEN, "recurring", "interval")).toBe(true);
  });

  test("normalizes scheduled headless prompt idempotently", () => {
    const first = ensureHeadlessScheduledPrompt("promemoria");
    const second = ensureHeadlessScheduledPrompt(first);

    expect(first).toContain("[Execution Mode: HEADLESS_SCHEDULED]");
    expect(second).toBe(first);
  });

  test("disables implicit delivery for delayed and cron jobs", () => {
    expect(shouldDisableImplicitScheduledDelivery("delayed", null)).toBe(true);
    expect(shouldDisableImplicitScheduledDelivery("recurring", "cron")).toBe(true);
    expect(shouldDisableImplicitScheduledDelivery("recurring", "interval")).toBe(true);
  });
});
