import test from "node:test";
import assert from "node:assert/strict";
import { formatGithubHttpError, githubRequestHeaders } from "../src/utils/github-http.js";

test("github request headers use only explicit config API key for GitHub API requests", () => {
  const originalToken = process.env.GITHUB_TOKEN;
  const originalGhToken = process.env.GH_TOKEN;
  process.env.GITHUB_TOKEN = "ignored-env-token";
  process.env.GH_TOKEN = "ignored-gh-token";
  try {
    const unauthenticatedHeaders = githubRequestHeaders(new URL("https://api.github.com/repos/owner/repo"), "application/json", "test-agent");
    assert.equal(unauthenticatedHeaders.authorization, undefined);

    const apiHeaders = githubRequestHeaders(new URL("https://api.github.com/repos/owner/repo"), "application/json", "test-agent", "config-key");
    assert.equal(apiHeaders.authorization, "Bearer config-key");
    assert.equal(apiHeaders["user-agent"], "test-agent");

    const rawHeaders = githubRequestHeaders(new URL("https://raw.githubusercontent.com/owner/repo/main/SKILL.md"), "text/plain", "test-agent", "config-key");
    assert.equal(rawHeaders.authorization, undefined);
  } finally {
    if (originalToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = originalToken;
    }
    if (originalGhToken === undefined) {
      delete process.env.GH_TOKEN;
    } else {
      process.env.GH_TOKEN = originalGhToken;
    }
  }
});

test("github 403 errors include config API key recovery guidance", () => {
  const message = formatGithubHttpError(
    new URL("https://api.github.com/repos/anthropics/skills"),
    403,
    JSON.stringify({ message: "API rate limit exceeded" }),
    { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1893456000" },
  );

  assert.match(message, /HTTP 403/u);
  assert.match(message, /API rate limit exceeded/u);
  assert.match(message, /Configure apiKeys\.github in pi-skill-hub\/config\.json/u);
  assert.match(message, /2030-01-01T00:00:00.000Z/u);
});

test("github 403 errors with configured API key point to access or rate limits", () => {
  const message = formatGithubHttpError(
    new URL("https://api.github.com/repos/anthropics/skills"),
    403,
    JSON.stringify({ message: "Resource not accessible by token" }),
    { "x-ratelimit-remaining": "10" },
    "config-key",
  );

  assert.match(message, /Resource not accessible by token/u);
  assert.match(message, /configured GitHub API key may lack repository access or may be rate-limited/u);
});
