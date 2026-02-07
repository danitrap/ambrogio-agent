import type { SkillMetadata } from "./discovery";

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
}

export function selectSkills(message: string, skills: SkillMetadata[], max = 3): SkillMetadata[] {
  if (skills.length === 0) {
    return [];
  }

  const tokens = new Set(tokenize(message));
  const scored = skills
    .map((skill) => {
      const source = `${skill.name} ${skill.description}`.toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (source.includes(token)) {
          score += 1;
        }
      }
      return { skill, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id));

  if (scored.length === 0) {
    return skills.slice(0, 1);
  }

  return scored.slice(0, max).map((entry) => entry.skill);
}
