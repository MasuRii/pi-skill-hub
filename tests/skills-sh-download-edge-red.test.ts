import test from "node:test";
import assert from "node:assert/strict";
import { extractSkillsShDownloadedFiles } from "../src/providers/skills-sh-download.js";

const SOURCE = { owner: "owner", repo: "repo", skill: "safe-skill" };

test("skills.sh download extraction rejects nested traversal after selecting a valid root SKILL.md", () => {
  assert.throws(
    () => extractSkillsShDownloadedFiles({
      files: [
        { path: "safe-skill/SKILL.md", contents: "# Safe Skill\n" },
        { path: "safe-skill/../outside.txt", contents: "escape" },
      ],
    }, SOURCE),
    /unsafe file path/u,
  );
});

test("skills.sh download extraction rejects Windows drive-qualified nested paths", () => {
  assert.throws(
    () => extractSkillsShDownloadedFiles({
      files: [
        { path: "safe-skill/SKILL.md", contents: "# Safe Skill\n" },
        { path: "safe-skill/C:/Users/Public/escape.txt", contents: "escape" },
      ],
    }, SOURCE),
    /unsafe file path/u,
  );
});
