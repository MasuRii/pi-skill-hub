# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-07-03

### Added
- Added an `enabled` master toggle to the Skill Hub config so the extension can be disabled without uninstalling. ([6eaa865](https://github.com/MasuRii/pi-skill-hub/commit/6eaa8650eeb72a7629d861692a18b6bfef399304))

### Changed
- Widened Pi coding-agent and Pi TUI peer dependency ranges through `^0.80.0` and added a `postinstall` patch with npm `overrides` to resolve known vulnerabilities in transitive dependencies. ([056da05](https://github.com/MasuRii/pi-skill-hub/commit/056da05af7aa2d3016061d2a054b7d9ba4ce46aa))
- Extracted shared utilities and consolidated provider logic across skills.sh, Skills Marketplace, and source-discovery modules. ([6eaa865](https://github.com/MasuRii/pi-skill-hub/commit/6eaa8650eeb72a7629d861692a18b6bfef399304))
- Added tests for refactored providers and ReDoS coverage. ([1c0a66d](https://github.com/MasuRii/pi-skill-hub/commit/1c0a66db2306144c3dcfc3b7c8a574972bbf9aa8))
- Updated README badge styling and added a ko-fi support button. ([44c7049](https://github.com/MasuRii/pi-skill-hub/commit/44c70495cdd5313e4763469aa6f96290f2c31180))

## [0.2.4] - 2026-06-16

### Fixed
- Blocked Windows drive letter prefixes (e.g., `C:`) in skills.sh download path segments to prevent path traversal on Windows.

## [0.2.3] - 2026-06-01

### Changed
- Deferred Skill Hub command registration through a dedicated registration module to reduce startup work.
- Aligned Pi peer and development dependency metadata with `^0.77.0 || ^0.78.0` compatibility.

## [0.2.2] - 2026-05-26

### Changed
- Widened peer dependency ranges to `^0.74.0 || ^0.75.0` for broader Pi version compatibility.
- Aligned dev dependencies to `^0.75.5`.

## [0.2.1] - 2026-05-22

### Changed
- Migrated Pi peer dependencies, imports, and tests to the `@earendil-works` package scope.
- Redacted secret-like debug values and appended debug logs asynchronously so skill-hub UI flows are not blocked by file writes.

## [0.2.0] - 2026-04-30

### Added
- Added the unified `/skill-hub` modal workspace with Browse, Inventory, Install, Update, Sources, and Remove panes.
- Added terminal-size-aware modal layout helpers for bounded workspace rendering.
- Added installed-skill indexing, provider source discovery, and source binding flows for local inventory provenance.
- Added GitHub, skills.sh download, and source-reference helpers for remote previews and update staging.

### Changed
- Expanded install, adopt, update, refresh, source binding, and remove planning flows with preview-first confirmation behavior.
- Improved skills.sh and Skills Marketplace provider handling, search normalization, and result rendering.
- Updated Pi development dependencies and expanded coverage for modal, provider, plan, discovery, configuration, GitHub, search, and update behavior.

## [0.1.0] - 2026-04-28

### Added
- Added provenance-aware skill inventory across local and external skill roots.
- Added `/skill-hub` command support for browsing, searching, listing, inspecting, adopting, installing, updating, removing, and refreshing skills.
- Added preview-first install and mutation plans that require explicit confirmation before file changes.
- Added provider adapters for skills.sh and Skills Marketplace search flows.
- Added debug logging gated by `config.json` and written only to the extension-local `debug/` directory.
- Added strict TypeScript build, test, and release verification scripts.

### Changed
- Standardized package metadata, npm package contents, runtime config template, README, changelog, and license for public publication readiness.
