import type { ProviderId, SkillSearchResult } from "../types.js";

export interface InstallDescriptor {
  displayName: string;
  localSkillName: string;
  installReference: string;
  sourceId: string;
  provider?: ProviderId | undefined;
  sourceUrl?: string | undefined;
}

export function skillNameFromInstallId(skillId: string): string {
  const trimmedSkillId = skillId.trim();
  const nameDelimiterIndex = trimmedSkillId.lastIndexOf("@");
  return nameDelimiterIndex >= 0 ? trimmedSkillId.slice(nameDelimiterIndex + 1).trim() : trimmedSkillId;
}

function installReferenceForSkill(skill: SkillSearchResult): string {
  return skill.installReference ?? skill.id;
}

export function createInstallDescriptor(skill: SkillSearchResult | string): InstallDescriptor {
  if (typeof skill === "string") {
    const sourceId = skill.trim();
    return {
      displayName: skillNameFromInstallId(sourceId),
      localSkillName: skillNameFromInstallId(sourceId),
      installReference: sourceId,
      sourceId,
    };
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
