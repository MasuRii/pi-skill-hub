# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
