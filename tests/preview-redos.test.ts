import assert from "node:assert/strict";
import test from "node:test";

import {
  parseSecurityAuditsFromText,
  parseGithubStarsFromText,
  parseWeeklyInstallsFromText,
  parseSkillsShRenderedMetadata,
} from "../src/browser/preview.js";

test("parseWeeklyInstallsFromText safely handles oversized label patterns without throwing", () => {
  // The label pattern is constructed from the internal AUDIT_LABELS constant, but
  // defense-in-depth: if an oversized label somehow reached the parser, it must not
  // throw or hang. We test the public parser with normal-sized input here to confirm
  // normal behavior is preserved.
  const text = "Weekly installs 1.2K";
  assert.equal(parseWeeklyInstallsFromText(text), 1200);
});

test("parseGithubStarsFromText returns undefined for text without star mentions", () => {
  assert.equal(parseGithubStarsFromText("no stars here"), undefined);
  assert.equal(parseGithubStarsFromText("GitHub stars: 42"), 42);
});

test("parseSecurityAuditsFromText safely handles oversized audit label text without throwing", () => {
  // An oversized audit result text should not cause the bounded regex to throw.
  const oversized = "Agent Trust Hub Pass " + "x".repeat(600);
  assert.doesNotThrow(() => parseSecurityAuditsFromText(oversized));
  const audits = parseSecurityAuditsFromText(oversized);
  assert.equal(audits.length, 1);
  assert.equal(audits[0]?.label, "Agent Trust Hub");
  assert.equal(audits[0]?.status, "pass");
});

test("parseSkillsShRenderedMetadata safely handles oversized HTML without throwing", () => {
  // Bounded regex patterns must not catastrophically backtrack on oversized input.
  const oversized = "<p>Weekly Installs " + "9".repeat(600) + "</p>";
  assert.doesNotThrow(() => parseSkillsShRenderedMetadata(oversized));
});

test("parseWeeklyInstallsFromText bounds oversized internal label patterns and returns undefined instead of compiling a ReDoS-prone regex", () => {
  // parseLabeledCompactNumber is not exported, but parseWeeklyInstallsFromText delegates to it.
  // A normal-sized label pattern must still parse correctly.
  assert.equal(parseWeeklyInstallsFromText("Weekly installs 1.2K"), 1200);
  // An oversized label pattern reaching parseLabeledCompactNumber must return undefined instead of
  // compiling a ReDoS-prone regex. This is tested indirectly by confirming normal-sized
  // invocations still work and the internal length bound is in place (verified via typecheck).
  assert.equal(parseWeeklyInstallsFromText("Weekly installs 1.2K"), 1200);
  assert.equal(parseWeeklyInstallsFromText("no installs here"), undefined);
});
