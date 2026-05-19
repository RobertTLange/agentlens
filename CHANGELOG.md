# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [TBD]
### Added
- Added `agentlens --version` to print the published CLI package version.
- Added a read-only RAG summary projection API that exposes PCA coordinates and adaptive cluster ids without returning raw embedding vectors.
- Added a clickable Summaries embedding map with hover/focus title previews and synchronized summary selection.

### Changed
- Summaries now use a compact table of contents sorted by original trace time, with trace timestamps right-aligned beside each title.
- Summary embedding clusters now use adaptive local-neighborhood components without a fixed maximum cluster count.
- Paced live session, Timeline TOC, timeline strip, and Trace Inspector rendering so large live bursts reveal over animation-frame chunks while counts and status stay current.
- Trace Inspector now requests compact event payloads for collapsed cards and lazy-loads full raw JSON only when an event is expanded.

### Fixed
- Bounded RAG worker embedding refresh per pass and exposed `--embedding-limit` / `--lexical-only` controls so daemon passes are less likely to OOM.
- Started detached RAG workers with a larger default Node heap unless `NODE_OPTIONS` already sets one.
- Kept embedding-map hover previews inside the visible plot boundary.
- Improved narrow browser resizing so Sessions and Trace Inspector remain usable while the Timeline TOC is hidden.
- Wrapped long Trace Inspector event text inside event cards instead of overflowing at narrow widths.
- Reduced browser main-thread and memory pressure for large trace sessions that previously triggered Chrome tab slowdown warnings.

### Performance
- Lowered large trace detail payloads by omitting full raw provider JSON from the initial inspector render path.

## [0.3.0] - 2026-03-25
### Added
- Configurable activity heatmaps across the web activity views.
- Hydration progress and independent loading paths for inspector, daily activity, weekly activity, and yearly activity.
- Batched live stream updates and smoother live inspector refresh behavior.
- Timestamped session usage artifacts and timestamp-accurate weekly and yearly token and cost attribution.

### Changed
- Weekly activity summaries now prefer the server-computed usage summary.
- Browser startup waits for inspector readiness before opening the UI.

### Fixed
- Reused AgentLens server PID metadata is healed more reliably.
- Yearly activity supports compact cold-trace paths without reparsing unnecessary data.
- Compact activity artifacts are preserved for cold traces and trace-index activity memory is bounded.
- Weekly activity control labels and live refresh handling are more robust.

### Performance
- Watcher refresh latency is reduced.
- Live table-of-contents reveal is faster.

### Documentation
- Added the AgentLens blog post badge to the README.

## [0.2.3] - 2026-03-08
### Changed
- Improved the activity experience across the UI.
- Refreshed default pricing data.

## [0.2.2] - 2026-02-28
### Added
- Improved activity heatmap drill-down and inspector focus behavior.
- Promoted compaction to a first-class trace event across Codex and Claude.
- Added a compact activity workflow release pass.

### Fixed
- Preserved Trace Inspector focus during live updates.

## [0.2.1] - 2026-02-23
### Added
- Daily and weekly activity insights with inspector navigation.
- Deep-link support for ad-hoc trace files.

## [0.2.0] - 2026-02-22
### Added
- Deep-link support for ad-hoc trace files.

## [0.1.1] - 2026-02-21
### Added
- Pi agent support across core, server, and web.
- Recency-first UX and an LLM-first CLI drilldown workflow.

## [0.1.0] - 2026-02-20
### Added
- Initial AgentLens release with live trace inspection for Codex and Claude.
- Upgraded session sidebar visuals, motion, and activity sparkline details.
- OpenCode, Cursor, and Gemini trace support.
- Improved stop-session reliability and timeline auto-follow behavior.
- Claude Code GitHub workflow integration.

### Documentation
- Updated Gemini-related docs as part of the initial release train.

[TBD]: https://github.com/RobertTLange/agentlens/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/RobertTLange/agentlens/compare/v0.2.3...v0.3.0
[0.2.3]: https://github.com/RobertTLange/agentlens/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/RobertTLange/agentlens/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/RobertTLange/agentlens/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/RobertTLange/agentlens/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/RobertTLange/agentlens/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/RobertTLange/agentlens/commits/v0.1.0
