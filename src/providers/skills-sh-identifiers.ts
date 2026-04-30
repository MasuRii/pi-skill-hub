export interface SkillsShSource {
  owner: string;
  repo: string;
  skill: string;
}

const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/u;

function isSafeSegment(segment: string | undefined): segment is string {
  return Boolean(segment && segment !== "." && segment !== ".." && SAFE_SEGMENT_PATTERN.test(segment));
}

function safeDecodeURIComponent(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function parseSafeSegments(value: string): string[] | undefined {
  const segments = value
    .trim()
    .split("/")
    .filter(Boolean)
    .map((segment) => safeDecodeURIComponent(segment));
  if (segments.length !== 3 || segments.some((segment) => !isSafeSegment(segment))) {
    return undefined;
  }
  return segments as string[];
}

export function parseSkillsShIdentifier(identifier: string | undefined): SkillsShSource | undefined {
  if (!identifier) {
    return undefined;
  }

  const trimmed = identifier.trim();
  if (!trimmed) {
    return undefined;
  }

  const identifierParts = trimmed.split("@");
  if (identifierParts.length === 2) {
    const [repoPart, skill] = identifierParts;
    const repoParts = repoPart?.split("/") ?? [];
    if (repoParts.length !== 2) {
      return undefined;
    }

    const [owner, repo] = repoParts;
    if (!isSafeSegment(owner) || !isSafeSegment(repo) || !isSafeSegment(skill)) {
      return undefined;
    }

    return { owner, repo, skill };
  }

  const apiIdSegments = parseSafeSegments(trimmed);
  if (!apiIdSegments) {
    return undefined;
  }
  const owner = apiIdSegments[0];
  const repo = apiIdSegments[1];
  const skill = apiIdSegments[2];
  if (!owner || !repo || !skill) {
    return undefined;
  }
  return { owner, repo, skill };
}

export function parseSkillsShUrl(urlValue: string | undefined): SkillsShSource | undefined {
  if (!urlValue) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(urlValue.trim());
  } catch {
    return undefined;
  }

  if (url.protocol !== "https:" || url.hostname !== "skills.sh") {
    return undefined;
  }

  const pathSegments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => safeDecodeURIComponent(segment));
  if (pathSegments.length !== 3) {
    return undefined;
  }

  const [owner, repo, skill] = pathSegments;
  if (!isSafeSegment(owner) || !isSafeSegment(repo) || !isSafeSegment(skill)) {
    return undefined;
  }

  return { owner, repo, skill };
}

export function parseSkillsShReference(reference: string | undefined): SkillsShSource | undefined {
  return parseSkillsShIdentifier(reference) ?? parseSkillsShUrl(reference);
}

export function skillsShIdentifier(source: SkillsShSource): string {
  return `${source.owner}/${source.repo}@${source.skill}`;
}

export function skillsShApiId(source: SkillsShSource): string {
  return `${source.owner}/${source.repo}/${source.skill}`;
}

export function skillsShDetailUrl(source: SkillsShSource, detailBaseUrl = "https://skills.sh"): string {
  const url = new URL(
    `/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/${encodeURIComponent(source.skill)}`,
    detailBaseUrl,
  );
  return url.toString().replace(/\/$/u, "");
}
