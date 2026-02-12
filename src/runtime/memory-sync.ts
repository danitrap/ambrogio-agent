import type { StateStore } from "./state-store";

export type MemoryEntry = {
  id: string;
  type: "preference" | "fact" | "pattern";
  content: string;
  source: "explicit" | "extracted";
  confidence: number;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
  tags: string[];
  context: string;
  status: "active" | "deprecated" | "archived";
};

function parseMemoryEntry(value: string): MemoryEntry | null {
  try {
    return JSON.parse(value) as MemoryEntry;
  } catch {
    return null;
  }
}

function formatMemorySection(memories: MemoryEntry[], sectionTitle: string): string {
  if (memories.length === 0) {
    return "";
  }

  const lines: string[] = [`## ${sectionTitle}`, ""];

  for (const memory of memories) {
    lines.push(`### ${memory.content}`);
    lines.push("");
    lines.push(`- **ID**: \`${memory.id}\``);
    lines.push(`- **Confidence**: ${memory.confidence}%`);
    lines.push(`- **Source**: ${memory.source}`);
    lines.push(`- **Created**: ${new Date(memory.createdAt).toLocaleDateString()}`);
    lines.push(`- **Last Updated**: ${new Date(memory.updatedAt).toLocaleDateString()}`);

    if (memory.tags.length > 0) {
      lines.push(`- **Tags**: ${memory.tags.map((tag) => `\`${tag}\``).join(", ")}`);
    }

    if (memory.context) {
      lines.push(`- **Context**: ${memory.context}`);
    }

    if (memory.status !== "active") {
      lines.push(`- **Status**: ${memory.status}`);
    }

    lines.push("");
  }

  return lines.join("\n");
}

export function generateMemoryMarkdown(stateStore: StateStore): string {
  const entries = stateStore.getAllRuntimeKeys("memory:*");

  const preferences: MemoryEntry[] = [];
  const facts: MemoryEntry[] = [];
  const patterns: MemoryEntry[] = [];

  for (const entry of entries) {
    const memory = parseMemoryEntry(entry.value);
    if (!memory) {
      continue;
    }

    // Only include active and deprecated memories (not archived)
    if (memory.status === "archived") {
      continue;
    }

    switch (memory.type) {
      case "preference":
        preferences.push(memory);
        break;
      case "fact":
        facts.push(memory);
        break;
      case "pattern":
        patterns.push(memory);
        break;
    }
  }

  // Sort by confidence (high to low) then by creation date (recent first)
  const sortMemories = (a: MemoryEntry, b: MemoryEntry): number => {
    if (a.confidence !== b.confidence) {
      return b.confidence - a.confidence;
    }
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  };

  preferences.sort(sortMemories);
  facts.sort(sortMemories);
  patterns.sort(sortMemories);

  const sections: string[] = [
    "# Ambrogio Agent - Memory",
    "",
    "This file contains Ambrogio's long-term semantic memory across sessions.",
    "",
    "**Memory Types:**",
    "- **Preferences**: User's explicit choices (tools, communication style, workflows)",
    "- **Facts**: Contextual information (credentials, IPs, project details)",
    "- **Patterns**: Observed behaviors (habits, common mistakes)",
    "",
    "---",
    "",
  ];

  const preferencesSection = formatMemorySection(preferences, "User Preferences");
  if (preferencesSection) {
    sections.push(preferencesSection);
  }

  const factsSection = formatMemorySection(facts, "Facts & Knowledge");
  if (factsSection) {
    sections.push(factsSection);
  }

  const patternsSection = formatMemorySection(patterns, "Behavioral Patterns");
  if (patternsSection) {
    sections.push(patternsSection);
  }

  if (preferences.length === 0 && facts.length === 0 && patterns.length === 0) {
    sections.push("## No Memories Yet");
    sections.push("");
    sections.push("Use `ambrogioctl memory add` to create memories, or use the `memory-manager` skill.");
    sections.push("");
  }

  return sections.join("\n");
}
