import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TelegramAttachment, TelegramDownload } from "../telegram/adapter";

const TEXTUAL_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".json",
  ".csv",
  ".xml",
  ".yaml",
  ".yml",
  ".log",
]);

type ProcessIncomingParams = {
  attachment: TelegramAttachment;
  download: TelegramDownload;
  updateId: number;
  sequence: number;
  receivedAt?: Date;
};

export type ProcessedAttachment = {
  kind: TelegramAttachment["kind"];
  relativePath: string;
  mimeType: string | null;
  sizeBytes: number;
  originalFileName: string | null;
  inlineText: string | null;
};

export class AttachmentService {
  constructor(
    private readonly dataRoot: string,
    private readonly maxInlineTextBytes: number = 64 * 1024,
  ) {}

  async processIncoming(params: ProcessIncomingParams): Promise<ProcessedAttachment> {
    const receivedAt = params.receivedAt ?? new Date();
    const dateFolder = this.getDateFolder(receivedAt);
    const attachmentsFolder = path.join(this.dataRoot, "attachments", dateFolder);
    await mkdir(attachmentsFolder, { recursive: true });

    const sourceName = params.attachment.fileName ?? params.download.fileName;
    const safeName = this.sanitizeFileName(sourceName, params.attachment.kind);
    const fileName = `${params.updateId}-${params.sequence}-${params.attachment.kind}-${safeName}`;
    const absolutePath = path.join(attachmentsFolder, fileName);

    const bytes = new Uint8Array(await params.download.fileBlob.arrayBuffer());
    await writeFile(absolutePath, bytes);

    const relativePath = path.relative(this.dataRoot, absolutePath);
    const resolvedMimeType = params.attachment.mimeType ?? params.download.mimeType ?? null;
    const inlineText = await this.extractInlineText({
      kind: params.attachment.kind,
      fileName: safeName,
      mimeType: resolvedMimeType,
      sizeBytes: bytes.byteLength,
      blob: params.download.fileBlob,
    });

    return {
      kind: params.attachment.kind,
      relativePath,
      mimeType: resolvedMimeType,
      sizeBytes: bytes.byteLength,
      originalFileName: params.attachment.fileName ?? null,
      inlineText,
    };
  }

  buildPromptContext(attachments: ProcessedAttachment[]): string {
    if (attachments.length === 0) {
      return "";
    }

    const metadataLines = attachments.map((item, index) => {
      const mime = item.mimeType ?? "unknown";
      const name = item.originalFileName ?? "n/a";
      return `${index + 1}. kind=${item.kind} path=${item.relativePath} mime=${mime} size_bytes=${item.sizeBytes} original_name=${name}`;
    });

    const inlineSections = attachments
      .map((item, index) => {
        if (!item.inlineText) {
          return null;
        }
        return [
          `Attachment ${index + 1} text (${item.relativePath}):`,
          item.inlineText,
        ].join("\n");
      })
      .filter((section): section is string => section !== null);

    const parts = [
      "Attachment context:",
      ...metadataLines,
    ];
    if (inlineSections.length > 0) {
      parts.push("", "Attachment text content:", ...inlineSections);
    }
    return parts.join("\n");
  }

  private getDateFolder(date: Date): string {
    const year = String(date.getUTCFullYear());
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    return path.join(year, month, day);
  }

  private sanitizeFileName(value: string | null | undefined, fallbackKind: TelegramAttachment["kind"]): string {
    const input = value && value.trim().length > 0 ? value : `${fallbackKind}.bin`;
    const baseName = path.basename(input);
    const cleaned = baseName.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
    return cleaned.length > 0 ? cleaned : `${fallbackKind}.bin`;
  }

  private async extractInlineText(params: {
    kind: TelegramAttachment["kind"];
    fileName: string;
    mimeType: string | null;
    sizeBytes: number;
    blob: Blob;
  }): Promise<string | null> {
    if (params.kind !== "document") {
      return null;
    }
    if (params.sizeBytes > this.maxInlineTextBytes) {
      return null;
    }
    if (!this.isTextLikeDocument(params.fileName, params.mimeType)) {
      return null;
    }
    const text = await params.blob.text();
    return text.trim().length > 0 ? text : null;
  }

  private isTextLikeDocument(fileName: string, mimeType: string | null): boolean {
    if (mimeType && mimeType.startsWith("text/")) {
      return true;
    }
    const lowerMime = mimeType?.toLowerCase();
    if (lowerMime && (
      lowerMime.includes("json")
      || lowerMime.includes("xml")
      || lowerMime.includes("yaml")
      || lowerMime.includes("csv")
    )) {
      return true;
    }

    const extension = path.extname(fileName).toLowerCase();
    return TEXTUAL_EXTENSIONS.has(extension);
  }
}
