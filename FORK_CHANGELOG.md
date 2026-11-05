# BTR West Coast changelog

Fork releases are recorded here. Original project release notes remain in [CHANGELOG.md](CHANGELOG.md).

## [Unreleased]

- Request maintainer reviews for blocked upstream updates, with deduplicated GitHub email notifications and assigned issue alerts when conflicts prevent a PR.
- Keep upstream and fork release histories separate so upstream release notes merge without recurring fork insertions.
- Explicitly run candidate CI and publication when using the built-in GitHub token for guarded auto-merging.

## [2026.11.4.1] - 2026-11-04

### BTR West Coast upstream update

- Integrate [upstream 2026.11.3.1](https://github.com/MrTangLuyao/Bilibili-thread-ripper/releases/tag/2026.11.3.1) (e409a42cbec60d4ceb430dc53d8a7942e07c1d31).
- Settings reopen on the main page, with Network selected when entering advanced settings.
- Retain West Coast adaptive routing, conservative buffering defaults, saved settings and fork update URLs.
- Preserve both upstream and fork release history while resolving the changelog conflict.

## [2026.11.2.1] - 2026-11-02

### BTR West Coast fork

- Independent Tampermonkey identity and stable/Canary updates from `salileoss/Bilibili-thread-ripper`.
- New installations default to Auto CDN selection across original, overseas and mainland routes; explicit manual/custom selections remain available.
- Latency-aware route ranking, bounded exploration, and short-lived host priors shared across tracks/videos.
- Useful-delivery and playback interruption diagnostics, stricter concurrency trial gains and conservative downward trials.
- Playback-rate-aware safety buffers and upcoming-segment demand estimates; same-quality codec capability checks respect explicit preferences.
- Optional low-buffer progressive appending, disabled by default, plus validated route probes and serial browser benchmarks.

### 修复

- 全接管下，断网后交回 B 站、B 站也恢复失败时，自动重新接管会从头播放（@KeWu5678，#62）。现在保留断网前的位置；B 站已经恢复播放时，使用它当前的进度。
