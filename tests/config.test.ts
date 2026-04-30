import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config/config.js";

function configPath(): string {
  return join(mkdtempSync(join(tmpdir(), "skill-hub-config-")), "config.json");
}

test("config loads provider and source API keys only from apiKeys object", () => {
  const path = configPath();
  writeFileSync(path, JSON.stringify({ apiKeys: { github: " gh-key ", skillsMp: " mp-key " } }), "utf-8");

  const loaded = loadConfig(path);

  assert.equal(loaded.config.apiKeys.github, "gh-key");
  assert.equal(loaded.config.apiKeys.skillsMp, "mp-key");
  assert.equal("github" + "Token" in loaded.config, false);
  assert.deepEqual(loaded.warnings, []);
});

test("config loads skills.sh API-first defaults and provider-specific overrides", () => {
  const path = configPath();
  writeFileSync(path, JSON.stringify({
    apiKeys: { skillsSh: " api-key " },
    skillsSh: {
      apiBaseUrl: "https://registry.example.test/",
      downloadBaseUrl: "https://download.example.test/",
      detailBaseUrl: "https://detail.example.test/",
      transport: "cli",
      cliCompatibility: true,
    },
  }), "utf-8");

  const loaded = loadConfig(path);

  assert.equal(loaded.config.skillsSh.apiBaseUrl, "https://registry.example.test");
  assert.equal(loaded.config.skillsSh.downloadBaseUrl, "https://download.example.test");
  assert.equal(loaded.config.skillsSh.detailBaseUrl, "https://detail.example.test");
  assert.equal(loaded.config.skillsSh.transport, "cli");
  assert.equal(loaded.config.skillsSh.cliCompatibility, true);
  assert.equal(loaded.config.skillsSh.apiKey, "api-key");
  assert.deepEqual(loaded.warnings, []);
});

test("config warns when CLI transport is selected without explicit compatibility mode", () => {
  const path = configPath();
  writeFileSync(path, JSON.stringify({ skillsSh: { transport: "cli" } }), "utf-8");

  const loaded = loadConfig(path);

  assert.equal(loaded.config.skillsSh.transport, "cli");
  assert.equal(loaded.config.skillsSh.cliCompatibility, false);
  assert.match(loaded.warnings.join("\n"), /requires skillsSh\.cliCompatibility=true/u);
});

test("config does not load a second GitHub credential key", () => {
  const path = configPath();
  const ignoredRootKey = "github" + "Token";
  writeFileSync(path, JSON.stringify({ [ignoredRootKey]: " ignored-token ", apiKeys: { skillsMp: "mp-key" } }), "utf-8");

  const loaded = loadConfig(path);

  assert.equal(loaded.config.apiKeys.github, undefined);
  assert.equal(loaded.config.apiKeys.skillsMp, "mp-key");
  assert.equal("github" + "Token" in loaded.config, false);
});
