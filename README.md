# pi-skill-hub

[![npm version](https://img.shields.io/npm/v/pi-skill-hub?style=flat-square)](https://www.npmjs.com/package/pi-skill-hub) [![License](https://img.shields.io/github/license/MasuRii/pi-skill-hub?style=flat-square)](LICENSE)

`pi-skill-hub` is a Pi extension for provenance-aware skill discovery, inventory, preview, and management. It keeps skill mutations preview-first so installs, adoptions, removals, and updates can be reviewed before they touch local files.

## Capabilities

- Searches supported remote skill providers from inside Pi.
- Inventories local and external skill roots with provenance metadata.
- Opens an interactive browser for remote skill previews.
- Builds explicit install, adopt, update, and remove plans before applying changes.
- Requires confirmation tokens for mutating command-line flows.
- Writes debug logs only to the extension-local `debug/` directory when `debug` is enabled.

## Installation

### npm package

```bash
pi install npm:pi-skill-hub
```

### Git repository

```bash
pi install git:github.com/MasuRii/pi-skill-hub
```

### Local extension folder

Place this folder in one of Pi's extension discovery paths:

```text
~/.pi/agent/extensions/pi-skill-hub
.pi/extensions/pi-skill-hub
```

## Usage

Open the interactive browser:

```text
/skill-hub
/skill-hub browse
```

Command forms:

| Command | Purpose |
|---|---|
| `/skill-hub search <query>` | Search configured remote providers. |
| `/skill-hub list` | Show local skill inventory. |
| `/skill-hub inspect <skill>` | Inspect a local skill and provenance metadata. |
| `/skill-hub adopt <skill>` | Preview adopting an unmanaged local skill. |
| `/skill-hub install <skill-id>` | Preview installing a remote skill. |
| `/skill-hub update [skill]` | Check update status for one skill or all skills. |
| `/skill-hub remove <skill>` | Preview removing a managed skill. |
| `/skill-hub refresh` | Preview manifest refresh operations. |
| `/skill-hub help` | Show command help. |

Mutating commands stay preview-only until `--apply --confirm <token>` is supplied.

## Configuration

Runtime configuration is stored at the extension root:

```text
~/.pi/agent/extensions/pi-skill-hub/config.json
```

The package includes `config/config.example.json` as a starter template. Missing path settings default to:

| Setting | Default |
|---|---|
| `localSkillRoot` | `~/.pi/agent/skills` |
| `externalSkillRoots` | `~/.agents/skills` |
| `updateStagingRoot` | `data/update-staging` under the extension root |

Configuration options:

| Key | Type | Default | Purpose |
|---|---|---:|---|
| `debug` | `boolean` | `false` | Enables file-only debug logs under `debug/debug.log`. |
| `providers.skillsSh` | `boolean` | `true` | Enables skills.sh provider search. |
| `providers.skillsMp` | `boolean` | `true` | Enables Skills Marketplace provider search. |
| `maxSearchResults` | `number` | `20` | Limits provider search results. |
| `requestTimeoutMs` | `number` | `10000` | Bounds provider and remote preview requests. |
| `localSkillRoot` | `string` | home default | Overrides the managed local skill root. |
| `externalSkillRoots` | `string[]` | home default | Adds read-only external inventory roots. |
| `updateStagingRoot` | `string` | extension data default | Controls update staging location. |

## Development

```bash
npm install
npm run build
npm run lint
npm run test
npm run check
npm run package:dry-run
```

The extension uses a root `index.ts` for Pi discovery and keeps implementation modules under `src/`.

## Publishing

The package metadata follows the same publish-ready shape used by established Pi extensions:

- entrypoint: `index.ts`
- package exports: `.` → `./index.ts`
- Pi extension manifest: `pi.extensions`
- published files: source, README, changelog, license, and config template
- runtime `data/`, `debug/`, `dist/`, and test artifacts excluded from npm publication

## Related Pi Extensions

- [pi-context-injector](https://github.com/MasuRii/pi-context-injector) — Inject compact project context into first-turn and compaction prompts
- [pi-agent-router](https://github.com/MasuRii/pi-agent-router) — Active-agent routing and controlled subagent delegation
- [pi-model-profiles](https://github.com/MasuRii/pi-model-profiles) — Save and apply reusable agent model profile snapshots
- [pi-must-have-extension](https://github.com/MasuRii/pi-must-have-extension) — RFC 2119 keyword normalization for prompt compliance

## License

[MIT](LICENSE)
