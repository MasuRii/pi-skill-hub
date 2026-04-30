import type { ProviderId, SkillSearchResult } from "../types.js";
import {
  parseSkillsShIdentifier,
  parseSkillsShReference,
  parseSkillsShUrl,
  skillsShDetailUrl,
  skillsShIdentifier,
  type SkillsShSource,
} from "../providers/skills-sh-identifiers.js";

export interface InstallDescriptor {
  displayName: string;
  localSkillName: string;
  installReference: string;
  sourceId: string;
  provider?: ProviderId | undefined;
  sourceUrl?: string | undefined;
}

export function skillNameFromInstallId(skillId: string): string {
  const skillsShSource = parseSkillsShReference(skillId);
  if (skillsShSource) {
    return skillsShSource.skill;
  }

  const trimmedSkillId = skillId.trim();
  const nameDelimiterIndex = trimmedSkillId.lastIndexOf("@");
  return nameDelimiterIndex >= 0 ? trimmedSkillId.slice(nameDelimiterIndex + 1).trim() : trimmedSkillId;
}

function installReferenceForSkill(skill: SkillSearchResult): string {
  return skill.installReference ?? skill.id;
}

function skillsShSourceForSkill(skill: SkillSearchResult): SkillsShSource | undefined {
  if (skill.provider !== "skills-sh") {
    return undefined;
  }

  return parseSkillsShReference(installReferenceForSkill(skill))
    ?? parseSkillsShReference(skill.id)
    ?? parseSkillsShUrl(skill.sourceUrl);
}

function skillsShDescriptor(source: SkillsShSource, displayName?: string | undefined): InstallDescriptor {
  const identifier = skillsShIdentifier(source);
  return {
    displayName: displayName && displayName.trim().length > 0 ? displayName : source.skill,
    localSkillName: source.skill,
    installReference: identifier,
    sourceId: identifier,
    provider: "skills-sh",
    sourceUrl: skillsShDetailUrl(source),
  };
}

export function createInstallDescriptor(skill: SkillSearchResult | string): InstallDescriptor {
  if (typeof skill === "string") {
    const sourceId = skill.trim();
    const skillsShSource = parseSkillsShReference(sourceId);
    if (skillsShSource) {
      return skillsShDescriptor(skillsShSource);
    }

    return {
      displayName: skillNameFromInstallId(sourceId),
      localSkillName: skillNameFromInstallId(sourceId),
      installReference: sourceId,
      sourceId,
    };
  }

  const skillsShSource = skillsShSourceForSkill(skill);
  if (skillsShSource) {
    return skillsShDescriptor(skillsShSource, skill.name);
  }

  const localSkillName = skill.name.trim().length > 0 ? skill.name : skillNameFromInstallId(skill.id);
  return {
    displayName: skill.name.trim().length > 0 ? skill.name : localSkillName,
    localSkillName,
    installReference: installReferenceForSkill(skill),
    sourceId: skill.id,
    provider: skill.provider,
    sourceUrl: skill.sourceUrl,
  };
}
