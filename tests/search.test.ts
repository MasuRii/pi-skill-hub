import test from "node:test";
import assert from "node:assert/strict";
import { deduplicateSkills, rankSkills, searchAllProviders } from "../src/search/search.js";
import type { SkillProvider } from "../src/providers/index.js";
import type { SkillSearchResult } from "../src/types.js";

function skill(name: string, popularity: number, provider: "skills-sh" | "skillsmp" = "skills-sh"): SkillSearchResult {
  return {
    id: `${provider}/${name}`,
    name,
    author: "author",
    description: `${name} TypeScript testing helper skill with detailed metadata`,
    popularity,
    provider,
    sourceUrl: `https://example.test/${name}`,
  };
}

test("search deduplicates by name and keeps richer higher-ranked result", () => {
  const deduped = deduplicateSkills([
    { ...skill("testing", 1), sourceUrl: undefined },
    skill("testing", 10, "skillsmp"),
  ]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0]?.provider, "skillsmp");
});

test("search ranks query matches before popularity ties", () => {
  const ranked = rankSkills([
    { ...skill("docker", 100), description: "container tooling" },
    { ...skill("typescript", 5), description: "typescript test runner" },
  ], "typescript testing");
  assert.equal(ranked[0]?.name, "typescript");
});

test("search aggregates providers and returns deduped ranked results", async () => {
  const providers: SkillProvider[] = [
    {
      id: "skills-sh",
      name: "skills.sh",
      requiresAuth: false,
      isAvailable: () => true,
      search: async () => [skill("alpha", 1), skill("beta", 2)],
    },
    {
      id: "skillsmp",
      name: "SkillsMP",
      requiresAuth: false,
      isAvailable: () => true,
      search: async () => [skill("alpha", 20, "skillsmp")],
    },
  ];

  const result = await searchAllProviders("alpha", "keyword", providers, 10);
  assert.equal(result.skills.length, 2);
  assert.equal(result.skills[0]?.name, "alpha");
  assert.equal(result.skills[0]?.provider, "skillsmp");
});

test("search preserves successful provider results while reporting failed providers", async () => {
  const providers: SkillProvider[] = [
    {
      id: "skills-sh",
      name: "skills.sh",
      requiresAuth: false,
      isAvailable: () => true,
      search: async () => {
        throw new Error("skills.sh unavailable");
      },
    },
    {
      id: "skillsmp",
      name: "SkillsMP",
      requiresAuth: false,
      isAvailable: () => true,
      search: async () => [skill("alpha", 20, "skillsmp")],
    },
  ];

  const result = await searchAllProviders("alpha", "keyword", providers, 10);

  assert.deepEqual(result.skills.map((item) => item.name), ["alpha"]);
  assert.deepEqual(result.sources, [
    { provider: "skills-sh", count: 0, error: "skills.sh unavailable" },
    { provider: "skillsmp", count: 1, error: undefined },
  ]);
});

test("search returns actionable source errors instead of throwing when all providers fail", async () => {
  const providers: SkillProvider[] = [
    {
      id: "skills-sh",
      name: "skills.sh",
      requiresAuth: false,
      isAvailable: () => true,
      search: async () => {
        throw new Error("skills.sh failed");
      },
    },
    {
      id: "skillsmp",
      name: "SkillsMP",
      requiresAuth: false,
      isAvailable: () => true,
      search: async () => {
        throw new Error("skillsmp failed");
      },
    },
  ];

  const result = await searchAllProviders("alpha", "keyword", providers, 10);

  assert.deepEqual(result.skills, []);
  assert.deepEqual(result.sources, [
    { provider: "skills-sh", count: 0, error: "skills.sh failed" },
    { provider: "skillsmp", count: 0, error: "skillsmp failed" },
  ]);
});
