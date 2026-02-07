import { mkdir } from "node:fs/promises";

function runGit(cwd: string, args: string[]): { stdout: string; stderr: string; success: boolean } {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    stdout: Buffer.from(result.stdout).toString("utf8").trim(),
    stderr: Buffer.from(result.stderr).toString("utf8").trim(),
    success: result.exitCode === 0,
  };
}

export class GitSnapshotManager {
  constructor(private readonly root: string) {}

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });

    const isRepo = runGit(this.root, ["rev-parse", "--is-inside-work-tree"]);
    if (!isRepo.success) {
      const initResult = runGit(this.root, ["init"]);
      if (!initResult.success) {
        throw new Error(`Failed to initialize git repo: ${initResult.stderr}`);
      }
    }

    runGit(this.root, ["config", "user.name", "agent-snapshot"]);
    runGit(this.root, ["config", "user.email", "agent@local"]);
  }

  createSnapshot(reason: string): string {
    const addResult = runGit(this.root, ["add", "-A"]);
    if (!addResult.success) {
      throw new Error(`Failed to stage snapshot: ${addResult.stderr}`);
    }

    const message = `pre-write snapshot: ${reason} @ ${new Date().toISOString()}`;
    const commitResult = runGit(this.root, ["commit", "--allow-empty", "-m", message]);
    if (!commitResult.success) {
      throw new Error(`Failed to create snapshot commit: ${commitResult.stderr}`);
    }

    const hashResult = runGit(this.root, ["rev-parse", "HEAD"]);
    if (!hashResult.success || !hashResult.stdout) {
      throw new Error(`Failed to get snapshot hash: ${hashResult.stderr}`);
    }

    return hashResult.stdout;
  }
}
