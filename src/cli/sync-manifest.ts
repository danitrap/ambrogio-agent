// src/cli/sync-manifest.ts
import path from "node:path";

export type SyncManifest = {
  version: string;
  outputFile: string;
  patterns: string[];
  generator: string;
  description?: string;
};

export type ValidationResult = {
  valid: boolean;
  errors: string[];
};

export function validateSyncManifest(manifest: unknown): ValidationResult {
  const errors: string[] = [];

  if (typeof manifest !== "object" || manifest === null) {
    return { valid: false, errors: ["Manifest must be an object"] };
  }

  const m = manifest as Record<string, unknown>;

  // Check version
  if (m.version !== "1") {
    errors.push("version must be '1'");
  }

  // Check outputFile
  if (typeof m.outputFile !== "string" || !m.outputFile) {
    errors.push("outputFile is required and must be a non-empty string");
  } else if (!path.isAbsolute(m.outputFile)) {
    errors.push("outputFile must be an absolute path");
  }

  // Check patterns
  if (!Array.isArray(m.patterns)) {
    errors.push("patterns is required and must be an array");
  } else if (m.patterns.length === 0) {
    errors.push("patterns array must not be empty");
  } else if (!m.patterns.every((p) => typeof p === "string" && p.length > 0)) {
    errors.push("patterns must be an array of non-empty strings");
  }

  // Check generator
  if (typeof m.generator !== "string" || !m.generator) {
    errors.push("generator is required and must be a non-empty string");
  }

  // Optional description
  if (m.description !== undefined && typeof m.description !== "string") {
    errors.push("description must be a string if provided");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
