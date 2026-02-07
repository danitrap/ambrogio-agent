import { createHash } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";

export type FileEntry = {
  path: string;
  type: "file" | "directory";
  size: number;
};

export type ReadFileResult = {
  path: string;
  content: string;
  sha256: string;
};

export type WriteFileResult = {
  path: string;
  newSha256: string;
};

export type SearchResult = {
  path: string;
  line: number;
  excerpt: string;
};

export type FsToolsOptions = {
  root: string;
  maxReadBytes?: number;
  maxWriteBytes?: number;
  maxSearchResults?: number;
};

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export class FsTools {
  private readonly maxReadBytes: number;
  private readonly maxWriteBytes: number;
  private readonly maxSearchResults: number;
  private rootRealPath: string = "";

  constructor(private readonly options: FsToolsOptions) {
    this.maxReadBytes = options.maxReadBytes ?? 1_000_000;
    this.maxWriteBytes = options.maxWriteBytes ?? 1_000_000;
    this.maxSearchResults = options.maxSearchResults ?? 200;
  }

  async init(): Promise<void> {
    await fs.mkdir(this.options.root, { recursive: true });
    this.rootRealPath = await fs.realpath(this.options.root);
  }

  private ensureInitialized(): void {
    if (!this.rootRealPath) {
      throw new Error("FsTools not initialized");
    }
  }

  private ensureWithinRoot(realTarget: string): void {
    const normalizedRoot = this.rootRealPath.endsWith(path.sep) ? this.rootRealPath : `${this.rootRealPath}${path.sep}`;
    if (realTarget !== this.rootRealPath && !realTarget.startsWith(normalizedRoot)) {
      throw new Error(`Path escapes root: ${realTarget}`);
    }
  }

  private normalizeInputPath(inputPath: string): string {
    const safePath = inputPath.trim() === "" ? "." : inputPath;
    return path.resolve(this.rootRealPath, safePath);
  }

  private async resolveForExistingPath(inputPath: string): Promise<{ absolute: string; real: string; relative: string }> {
    this.ensureInitialized();
    const absolute = this.normalizeInputPath(inputPath);
    const real = await fs.realpath(absolute);
    this.ensureWithinRoot(real);
    const relative = path.relative(this.rootRealPath, real) || ".";
    return { absolute, real, relative };
  }

  private async resolveForWrite(inputPath: string): Promise<{ absolute: string; relative: string }> {
    this.ensureInitialized();
    const absolute = this.normalizeInputPath(inputPath);
    const parent = path.dirname(absolute);
    const parentReal = await fs.realpath(parent);
    this.ensureWithinRoot(parentReal);

    try {
      const targetReal = await fs.realpath(absolute);
      this.ensureWithinRoot(targetReal);
    } catch {
      // File does not exist yet; parent check is enough.
    }

    const relative = path.relative(this.rootRealPath, absolute) || ".";
    if (relative.startsWith("..")) {
      throw new Error(`Path escapes root: ${inputPath}`);
    }

    return { absolute, relative };
  }

  async listFiles(inputPath = "."): Promise<FileEntry[]> {
    const { real } = await this.resolveForExistingPath(inputPath);
    const stat = await fs.stat(real);

    if (stat.isFile()) {
      return [{ path: path.relative(this.rootRealPath, real), type: "file", size: stat.size }];
    }

    const entries = await fs.readdir(real, { withFileTypes: true });
    const results: FileEntry[] = [];
    for (const entry of entries) {
      const target = path.join(real, entry.name);
      let targetReal: string;
      try {
        targetReal = await fs.realpath(target);
      } catch {
        continue;
      }
      this.ensureWithinRoot(targetReal);
      const entryStat = await fs.stat(targetReal);
      results.push({
        path: path.relative(this.rootRealPath, targetReal),
        type: entry.isDirectory() ? "directory" : "file",
        size: entryStat.size,
      });
    }
    return results.sort((a, b) => a.path.localeCompare(b.path));
  }

  async readFile(inputPath: string): Promise<ReadFileResult> {
    const { real } = await this.resolveForExistingPath(inputPath);
    const stat = await fs.stat(real);
    if (stat.size > this.maxReadBytes) {
      throw new Error(`File exceeds max read size (${this.maxReadBytes} bytes)`);
    }
    const content = await fs.readFile(real, "utf8");
    return {
      path: path.relative(this.rootRealPath, real),
      content,
      sha256: hashContent(content),
    };
  }

  async writeFile(inputPath: string, content: string, expectedSha256?: string): Promise<WriteFileResult> {
    const contentSize = Buffer.byteLength(content, "utf8");
    if (contentSize > this.maxWriteBytes) {
      throw new Error(`Write payload exceeds max size (${this.maxWriteBytes} bytes)`);
    }

    const { absolute, relative } = await this.resolveForWrite(inputPath);

    if (expectedSha256) {
      try {
        const currentContent = await fs.readFile(absolute, "utf8");
        const currentHash = hashContent(currentContent);
        if (currentHash !== expectedSha256) {
          throw new Error("Hash mismatch: file changed since it was read");
        }
      } catch (error) {
        if ((error as Error).message.startsWith("Hash mismatch")) {
          throw error;
        }
      }
    }

    const tempPath = `${absolute}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await fs.writeFile(tempPath, content, "utf8");
    const tempHandle = await fs.open(tempPath, "r");
    await tempHandle.sync();
    await tempHandle.close();
    await fs.rename(tempPath, absolute);

    return {
      path: relative,
      newSha256: hashContent(content),
    };
  }

  async search(query: string, inputPath = "."): Promise<SearchResult[]> {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      return [];
    }

    const { real } = await this.resolveForExistingPath(inputPath);
    const results: SearchResult[] = [];

    const walk = async (currentPath: string): Promise<void> => {
      if (results.length >= this.maxSearchResults) {
        return;
      }

      const currentStat = await fs.stat(currentPath);
      if (currentStat.isDirectory()) {
        const children = await fs.readdir(currentPath);
        for (const child of children) {
          await walk(path.join(currentPath, child));
          if (results.length >= this.maxSearchResults) {
            return;
          }
        }
        return;
      }

      if (currentStat.size > this.maxReadBytes) {
        return;
      }

      const fileContent = await fs.readFile(currentPath, "utf8");
      const lines = fileContent.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        if (lines[index]?.includes(trimmedQuery)) {
          results.push({
            path: path.relative(this.rootRealPath, currentPath),
            line: index + 1,
            excerpt: lines[index]!.slice(0, 200),
          });
        }

        if (results.length >= this.maxSearchResults) {
          return;
        }
      }
    };

    await walk(real);
    return results;
  }
}
