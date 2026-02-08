import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { AttachmentService } from "../src/attachments/attachment-service";

describe("AttachmentService", () => {
  test("stores document attachments and extracts inline text under max size", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "agent-attachments-"));
    const service = new AttachmentService(dataRoot, 64 * 1024);
    const content = "ciao dal file";

    const processed = await service.processIncoming({
      attachment: {
        kind: "document",
        fileId: "abc",
        fileName: "note.md",
        mimeType: "text/markdown",
        fileSize: content.length,
      },
      download: {
        fileBlob: new Blob([content], { type: "text/markdown" }),
        fileName: "note.md",
        mimeType: "text/markdown",
      },
      updateId: 55,
      sequence: 0,
      receivedAt: new Date("2026-02-08T12:00:00Z"),
    });

    expect(processed.kind).toBe("document");
    expect(processed.relativePath).toContain("attachments/2026/02/08/");
    expect(processed.inlineText).toBe(content);

    const savedContent = await readFile(path.join(dataRoot, processed.relativePath), "utf8");
    expect(savedContent).toBe(content);
  });

  test("does not extract inline text when document exceeds max bytes", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "agent-attachments-"));
    const service = new AttachmentService(dataRoot, 64 * 1024);
    const content = "a".repeat(64 * 1024 + 1);

    const processed = await service.processIncoming({
      attachment: {
        kind: "document",
        fileId: "abc",
        fileName: "large.txt",
        mimeType: "text/plain",
        fileSize: content.length,
      },
      download: {
        fileBlob: new Blob([content], { type: "text/plain" }),
        fileName: "large.txt",
        mimeType: "text/plain",
      },
      updateId: 56,
      sequence: 0,
      receivedAt: new Date("2026-02-08T12:00:00Z"),
    });

    expect(processed.inlineText).toBeNull();
  });

  test("stores photo attachments without inline text", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "agent-attachments-"));
    const service = new AttachmentService(dataRoot, 64 * 1024);

    const processed = await service.processIncoming({
      attachment: {
        kind: "photo",
        fileId: "photo-1",
        fileName: null,
        mimeType: null,
        fileSize: 5,
      },
      download: {
        fileBlob: new Blob(["abcde"], { type: "image/jpeg" }),
        fileName: "photo.jpg",
        mimeType: "image/jpeg",
      },
      updateId: 57,
      sequence: 1,
      receivedAt: new Date("2026-02-08T12:00:00Z"),
    });

    expect(processed.kind).toBe("photo");
    expect(processed.inlineText).toBeNull();
    expect(processed.relativePath).toContain("attachments/2026/02/08/");
  });

  test("sanitizes unsafe names when storing attachments", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "agent-attachments-"));
    const service = new AttachmentService(dataRoot, 64 * 1024);

    const processed = await service.processIncoming({
      attachment: {
        kind: "document",
        fileId: "abc",
        fileName: "../secrets.env",
        mimeType: "text/plain",
        fileSize: 2,
      },
      download: {
        fileBlob: new Blob(["ok"], { type: "text/plain" }),
        fileName: "../secrets.env",
        mimeType: "text/plain",
      },
      updateId: 58,
      sequence: 0,
      receivedAt: new Date("2026-02-08T12:00:00Z"),
    });

    expect(processed.relativePath.includes("..")).toBe(false);
    expect(processed.relativePath).toContain("secrets.env");
  });
});
