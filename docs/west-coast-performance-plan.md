# US West Coast playback performance plan

Initial review: 2026-11-02, checkout `3e715f5` (`canary 2026.11.1.1`). The implementation status below records subsequent work in the personal fork.

## Recommendation

Prioritize measured selection across Bilibili's original, overseas, and mainland routes, then optimize useful bytes delivered before playback deadlines. Keep the existing downloader and player architecture. Its range validation, resumable retries, shared request budget, weighted scheduling, deadline-aware hedges, seek cancellation, and quota recovery are valuable foundations.

For this connection, overseas mode is the best first configuration to compare against the current mainland default. This is a starting hypothesis supported by a small local probe, not a universal West Coast preset. Select the winner using actual browser playback, including less popular videos and evening congestion.

## Project model

- `scripts/build.mjs` combines the ordered sources in `user_scripts/adapter/meta.json` into a userscript. Make future changes in `src/` and adapter sources, then build; do not hand-edit generated stable or canary bundles.
- The adapter injects page code at document start and bridges userscript-manager storage. `bridge.js` normalizes and shares settings; `settings-panel.js` and the native menu expose them.
- `page-hook.js` captures playinfo, coordinates navigation, quality changes, takeover/fallback, URL renewal, and native-player integration.
- Full takeover: `native-mse-player.js` selects DASH representations, reads initialization and SIDX ranges, schedules audio/video, and appends into MSE while retaining Bilibili's UI. It suppresses competing native download schedulers.
- Compatibility takeover: `native-range-transport.js` replaces eligible bounded media Fetch/XHR requests while Bilibili retains its playback core. Episodes use this path. It intentionally validates complete ranges before resolving Fetch because native loaders can swallow streaming errors.
- Both paths use `cdn-resolver.js` and `idm-downloader.js` for CDN candidates, health, concurrent Range requests, retry/resume, and rescue copies. `range-core.js` supplies validation and settings; `sidx.js` maps bytes to media time.
- Live playback is a separate, opt-in HLS pipeline in `live-core.js` / `live-hook.js`, with its own host pool, hedges, and prefetch cache. VOD improvements will not automatically improve live playback.

## Local evidence and limits

Executed the existing `dev/network-probe.mjs` on this machine. IP geolocation reported California / AT&T (approximate network location). The sample was public video `BV1T1NZ6xEZZ`, using an anonymous playurl response. Each measurement below is one sequential GET for the first 1 MiB; signed URLs were not recorded here.

| Route / host | Time to response headers | Total transfer time | Reported payload rate |
| --- | ---: | ---: | ---: |
| Original `upos-sz-mirrorcosov.bilivideo.com` | 333 ms | 596 ms | 14.1 Mbps |
| Original `upos-hz-mirrorakam.akamaized.net` | 525 ms | 600 ms | 14.0 Mbps |
| Overseas `upos-sz-mirroraliov.bilivideo.com` | 258 ms | 594 ms | 14.1 Mbps |
| Overseas `upos-sz-mirrorcosov.bilivideo.com` (later request) | 372 ms | 690 ms | 12.2 Mbps |
| Mainland `upos-sz-mirror14b.bilivideo.com` | 544 ms | 1,360 ms | 6.2 Mbps |
| Mainland `upos-sz-mirrorbd.bilivideo.com` | 792 ms | 1,788 ms | 4.7 Mbps |
| Other successful mainland hosts | 858–2,662 ms | 2,403–4,396 ms | 1.9–3.5 Mbps |
| Overseas Hong Kong hosts | 655–662 ms | 1,600–1,813 ms | 4.6–5.2 Mbps |
| Mainland `upos-sz-mirrorali.bilivideo.com` | Connection timeout | 10,631 ms | — |
| Mainland `upos-sz-mirror08c.bilivideo.com` | DNS lookup failure | 1 ms | — |

All successful media requests above returned HTTP 206. The utility labels response-header latency as first-byte latency; it does not separately measure the first body chunk, or fully validate Content-Range and payload length. Improve those checks before treating it as a rigorous benchmark. A failed lookup here does not prove a host is globally unavailable.

These are Node Fetch results, not browser playback results. They do not establish sustained bandwidth, 4K capability, independent capacity across hosts, cache-cold CDN performance, or results for another ISP. The manifest offered low-resolution video representations; this run did not exercise authenticated high-bitrate streams. Repeated requests may warm caches and connections.

Baseline verification: 59 tests passed across `shared-core-test.js`, `auto-concurrency-test.js`, `optimization-test.js`, and `vod-selection-test.js`. Browser tests and sustained real-video playback were not run during this review.

## Findings that drive the plan

1. **The default pool excludes promising routes during media delivery.** `range-core.js` and `bridge.js` default to mainland. `representationUrls()` normally excludes overseas/original Akamai addresses in that mode. `startupCandidates()` includes original addresses, but metadata uses only its first three, while the first media probe uses `rangeCandidates()`. A fast metadata winner therefore need not be eligible for media or steady playback. The local measurements make this the highest-priority hypothesis.
2. **Route measurements restart too often.** Resolver speed history is scoped to a representation's host/path and resolver instance. Signature refreshes retain measurements in that instance, but separate audio/video resolvers and new video sessions do not share a general host prior. Starting each new file from static ordering costs time and can repeatedly trial poor routes.
3. **VOD ranking conflates startup latency and transfer rate.** It smooths bytes divided by full attempt duration and ranks successful routes by that rate; it does not separately model header delay, first body byte, transfer slope, or tail variability. A tiny startup range and a large 4K segment have different optimal choices.
4. **Concurrency control has a weak plateau rule.** It starts at 8, boosts full-takeover starts to at least 16, and can reach 64. A trial rolls back only when throughput is lower than baseline, not when the gain is negligible. Aside from startup rollback and refusals, it lacks a routine downward search after conditions improve. Compatibility mode supplies fewer playback-pressure signals.
5. **Steady-state delivery waits for whole segments.** Full takeover appends startup pieces progressively, but subsequent segments are downloaded and assembled completely before append. This creates a useful-buffer delay when early bytes are ready but a later piece is slow. Startup activation also requires complete first segments, so progressive arrival does not by itself guarantee early activation.
6. **Buffer adaptation is concentrated at startup.** The startup target is 2.5–10 media seconds; forward buffering defaults to 45 media seconds. Startup demand uses the first segment's average bitrate and is profiled once. Deadlines account for playback rate, but the broader buffer/concurrency thresholds and throughput-demand comparison need consistent wall-clock treatment and rolling VBR estimates.
7. **Current benchmarks do not measure the whole objective.** The simulator includes pooled-host and per-request-limited models, heterogeneous hosts, latency and stalls. It has no moving playback deadlines in its range calls, no rendered player, and no rebuffer-duration metric. CI real-media tests cover correctness across codecs/navigation but anonymous runs receive low resolutions and hosted runners do not represent this connection.

## Ordered implementation plan

### 1. Establish playback measurements and a repeatable baseline

Extend existing diagnostics and benchmark tools before tuning constants.

- Record page/playinfo availability, metadata completion, first media body byte, first presented frame, startup hold, and seek-to-presented-frame latency separately.
- Measure network-caused interruption count and duration, including BTR's proactive `pauseForData()` holds. Exclude viewer pauses, seeking, autoplay denial and end-of-stream. Classify decoder starvation/dropped frames separately from missing media.
- Report unique validated media delivered per second, contiguous playable A/V buffer, queue delay, per-host latency/rate, retries, rescue traffic, and bytes discarded after cancellation. Current total network speed can include losing copies; it is not the optimization target.
- Use app timestamps as the portable baseline. Resource Timing details can be unavailable across origins without server permission; missing DNS/TLS/protocol timing must remain unknown, not zero-latency samples. See [W3C Resource Timing](https://www.w3.org/TR/resource-timing/).
- Upgrade `network-probe.mjs`: validate bounded 206 responses, distinguish headers/body timing, cap body reads, repeat in randomized host order, report distributions, and reuse production candidate construction instead of duplicating lists/host swapping. Never export signed query strings or account cookies.
- Add a browser playback benchmark on this machine, running one performance trial at a time. Compare native playback, current mainland/Auto, overseas/Auto, and later mixed Auto. Use the same quality/codec/rate; record actual representation IDs.

Acceptance: one local, redacted report explains startup, stalls, useful throughput, waste, and route choices without requiring verbose per-chunk debug logging.

### 2. Add an automatic mixed CDN policy

Changes: `cdn-resolver.js`, `range-core.js`, `bridge.js`, `settings-panel.js`, native settings menu/preconnect logic in `page-hook.js`, plus affected tests.

- Add an explicit Auto CDN policy combining valid original/backup URLs and permitted overseas/mainland candidates. Preserve existing manual/custom behavior and stored choices; consider making Auto the new-install default only after browser validation.
- Keep exact original addresses intact, including Akamai URLs. Preserve relay handling, signed-address rules, response validation, expiry refresh and failure attribution. Reuse existing candidate construction rather than inventing unsigned URLs.
- Use the same eligible pool for metadata, first media, ordinary media and rescue. Let successful metadata routes influence the first media probe without treating tiny metadata success as a throughput measurement.
- Bound initial exploration: start with an original address and a small diverse set of promising hosts, staggered within the existing global budget. Do not race every host for every segment. After learning, concentrate on a small measured set, retaining a bounded exploration opportunity while buffer is healthy.
- Rank expected completion time using observed startup latency, remaining bytes, useful transfer rate and failure/variance penalty. Retain existing weighted assignment and deadline-aware rescue.
- Share conservative, short-lived hostname priors across tracks/videos in the page. Keep file/address validity and bans separate. Optionally persist only host statistics with expiry, never signed URLs; revalidate after idle periods or network changes. Cold content may behave differently from earlier hot content.
- Preconnect only a few likely active origins, including originals. Current code preconnects every host in the selected static pool.

Acceptance: a fast original/overseas route remains eligible after metadata; a slow first-listed mainland route cannot dominate cold startup; route degradation triggers rescue and reranking; manual/custom settings retain their semantics.

### 3. Tune concurrency and chunk size for useful throughput

Changes: `idm-downloader.js`, resolver measurement payloads, relevant native/compat pressure reporting.

- Keep one shared audio/video budget and existing rescue allowance. Add per-host active counts/caps so multiple segments do not flood a single route while others have room.
- Evaluate concurrency trials on unique validated delivery under sustained demand. Require a meaningful gain above noise (initial experiment: 10–15%); otherwise return to the prior level. Periodically test one lower level when buffer is comfortably ahead, with quick reversal on genuine playback pressure.
- Retain immediate 412/429 pushback and cooldowns. Distinguish first-byte waits on one poor host from evidence that the whole download needs more concurrency.
- Use per-host header/body latency and transfer rate to choose chunk sizes that amortize request overhead while preserving enough pieces for deadline scheduling. Benchmark candidate ranges such as 128–512 KiB instead of replacing the existing adaptive policy with a single fixed size.
- Do not equate JavaScript request count with socket count or sum individual route speeds into a promised aggregate. HTTP/2 multiplexes requests and can reuse connections across origins; apparent host diversity may still share transport or upstream capacity. See [RFC 9113, sections 9.1–9.1.1](https://www.rfc-editor.org/rfc/rfc9113.html#section-9.1).

Acceptance: pooled-capacity simulations settle at a lower effective request budget without increasing stalls; per-request-throttled simulations can still climb; neutral trials do not permanently ratchet concurrency upward; audio and rescue work remain responsive.

### 4. Make buffering responsive to current playback demand

Changes: `native-mse-player.js`; shared diagnostics/control signals where applicable.

- Express safety targets as wall-clock seconds of contiguous playable A/V, converting to media seconds using playback rate. Estimate demand from upcoming SIDX segment sizes/durations, including audio, rather than only the first segment's average.
- Keep startup and forward-buffer goals separate. Start from existing 2.5–10 second startup targets, then tune against measured interruption risk. Test 45 versus 90 media seconds ahead on this desktop; larger buffers consume memory and increase abandoned downloads.
- Adapt safety margin to recent useful throughput and delivery variability. When buffer is low, prioritize the next missing contiguous pieces over distant prefetch/exploration. Do not shorten current recovery holds until measurements show it improves total interruption time.
- Track downloaded/in-flight bytes as well as seconds. Retain back-buffer eviction and quota-driven reduction; MSE has no portable fixed capacity, so a large configured time window may not fit. See [Chrome's MSE quota guidance](https://developer.chrome.com/blog/quotaexceedederror); its historical example limits are not constants to hard-code.
- Keep secondary buffering opt-in until memory/waste measurements show a benefit. Its current cap can reach 512 MiB, in addition to MSE and in-flight allocations.

Acceptance: playback at 2x receives an appropriate safety margin; VBR spikes do not starve audio/video; long 4K playback stays within a defined byte budget; quota pressure does not create a recovery loop.

### 5. Reduce append and startup latency, behind measured experiments

- In full takeover, try ordered, validated piece appends for the immediately needed steady-state segment. Allow MSE to consume contiguous fragments before later pieces finish, with bounded append batching and backpressure. Keep byte/total consistency checks and cancel the session on unrecoverable later validation errors.
- Test across AVC/HEVC/AV1, seeks, quality changes and quota pressure. Pieces may cut MP4 boxes; prove browser behavior and avoid excessive append operations or retained copies. A slow earliest piece still needs rescue: progressive append alone cannot remove every dependency.
- If initialization and SIDX ranges are adjacent, evaluate fetching their union once per track and slicing locally, using the existing header cache. Current parallel requests may already be faster on some routes; measure before adopting.
- Only consider activation before complete first-segment download once sufficient decodable contiguous A/V and recovery behavior are verified. It is a separate change from progressive appending.
- Preserve compatibility mode's complete-response validation contract unless a separate loader-specific investigation proves streaming errors are handled correctly.

Acceptance: useful-buffer arrival and startup/seek latency improve without higher corruption, append-error, quota-error or post-start stall rates.

### 6. Handle sustainable bitrate and decoder limits

- Full takeover currently follows selected quality and prefers AV1, then HEVC, then AVC among supported representations. `MediaSource.isTypeSupported()` establishes format support, not smooth high-resolution decoding.
- In default codec selection, query `navigator.mediaCapabilities.decodingInfo()` for actual resolution, bitrate and frame rate; combine its `smooth` / `powerEfficient` hints with observed dropped frames. Respect explicit codec preferences. See [W3C Media Capabilities](https://www.w3.org/TR/media-capabilities/).
- Offer an explicit smooth-playback/automatic-quality policy when sustained useful throughput cannot cover video + audio at the selected playback rate with headroom. Lower quality after sustained deficit, upgrade only after sustained surplus, and coordinate through the existing quality synchronization path. A manually locked quality remains locked.
- For bitrate `R` Mbps and playback rate `p`, average demand is approximately `R × p`, before VBR/safety headroom. No buffer or request count can sustain a permanent deficit; buffers only bridge temporary deficits.

Acceptance: decoder trouble is not answered by endlessly adding requests; automatic quality avoids oscillation; manual quality/codec selection, position, HDR/Dolby handling and audio choice remain correct.

## Validation and rollout

Extend `dev/download-benchmark.js` with playback time, moving deadlines, finite buffer, randomized seeds, burst loss, correlated host slowdowns, common bottlenecks, route recovery, and 2x/VBR cases. Keep both pooled and per-request-limited models. Measure interruption time and first-frame latency alongside throughput, request count and waste.

For each implementation stage, run the relevant unit tests and existing browser regressions, then the full suite/build before a canary. Include native-MSE and compatibility playback, episodes, navigation, seeks, quality changes, end-of-stream, expired signatures, quota pressure, and fallback. Test live separately if changing shared behavior.

On the actual West Coast browser/ISP, use several popular and low-view videos, short and long content, and 1080p/4K/4K60 where the account is entitled. Include cold/warm connections, randomized trial order, 1x/2x and multiple local evening windows. Run at least five repeats for exploratory comparisons; collect enough independent sessions before claiming reliable p95 improvements. Browser/account access must remain local; anonymous CI is not a 4K acceptance test.

Proposed release gates, to adjust after baseline collection:

- At least 20% lower p95 first-frame or unbuffered-seek latency, with no material regression in the other.
- At least 50% less network-caused interruption time on challenged routes; on ample-capacity routes, aim for under 0.5% playback time interrupted.
- No material regression on already-fast playback, no additional byte-validation failures or fatal MSE errors, and no increase in server refusals.
- Track extra network bytes per unique delivered byte and abandoned prefetch separately; investigate sustained rescue/retry overhead above 10% in healthy steady-state playback. Startup races have a separate, bounded budget.
- Expose the selected route policy, useful throughput versus demand, and a redacted local diagnostics export. Roll out through canary with an easy return to existing manual policies.

## First practical action

Before implementation, compare overseas + automatic concurrency against mainland + automatic concurrency at identical quality, codec and playback speed. Keep full takeover on supported desktop browsers and start with the current 45-second forward buffer; compare 90 seconds only if temporary throughput dips persist. The first code milestone should be diagnostics plus mixed Auto CDN selection. Optimize concurrency and buffering after those measurements identify the remaining bottleneck.

## Implementation status — BTR West Coast 2026.11.2.1

Fork: [salileoss/Bilibili-thread-ripper](https://github.com/salileoss/Bilibili-thread-ripper). Stable and Canary have separate Tampermonkey identities from upstream and fetch updates from this fork. Original attribution and MIT licensing remain intact. Enable only one BTR script at a time.

Implemented:

- Auto CDN policy in settings and the native player menu; fresh fork installations use Auto, while explicit mainland/overseas/custom settings remain unchanged.
- Exact original addresses remain eligible for metadata, first media, ordinary media and rescue. Auto bounds its initial candidate set, retains a small exploration allowance, ranks estimated completion using latency/rate/variability, and shares conservative host priors for 90 seconds within the page. Priors contain no signatures and do not assert that another file is valid.
- Auto preconnects at most three likely origins. Request scheduling prefers another host over a busy host while preserving priority classes and borrowing spare slots when only one host has work.
- Concurrency increases require at least 10% measured gain under steady demand; healthy playback can trial a lower level after 30 seconds, with rollback on pressure. Compatibility mode now reports playback-rate-adjusted buffer pressure too.
- Transfer diagnostics distinguish network bytes, winning-piece delivery, queue waits, first media body byte and completed ranges. Playback diagnostics include first presented frame, seek-to-frame, contiguous wall-clock buffer, upcoming VBR demand and interruption duration, including proactive holds. Viewer pauses/seeks/end-of-stream close interruption intervals. Network-byte totals include metadata; delivered-byte totals count media, so their difference is not a pure duplicate-traffic metric.
- Startup/recovery targets and concurrency buffer signals account for playback speed; demand considers the largest of the upcoming three segments per track. Same-quality default codec selection consults bounded Media Capabilities hints and respects explicit codec choices.
- Optional low-buffer progressive appending is exposed in the buffer settings and remains disabled by default. Compatibility mode retains full-response validation. Ordered piece delivery now checks file-total consistency before appending further pieces.
- The route probe uses production candidate construction, bounded reads and 206/Content-Range/length checks. `BTR_PROBE_REPEATS` enables randomized repeated samples. The simulator includes moving playback deadlines and interruption estimates; a serial real-media browser harness compares modes and can exercise 2x/progressive/codec choices.

Evidence collected during implementation:

| Experiment | Mainland / old policy | Auto / new policy |
| --- | ---: | ---: |
| Simulated fast overseas original, median of three: first segment | 4,256 ms | 906 ms |
| Same simulation: total download | 14,838 ms | 4,154 ms |
| Same simulation: extra transferred bytes | 17.9% | 7.7% |
| Shared bottleneck at 2x, median total download | 14,109 ms | 14,008 ms |
| Real browser sample: first presented frame | 2,441 ms | 351 ms |
| Real browser sample: seek to presented frame | 1,872 ms | 565 ms |

The simulations compare the saved initial downloader against the changed source. The shared-bottleneck result illustrates the bandwidth limit: extra route choices cannot create capacity. Simulations are not predictions of real performance.

The browser comparison was one anonymous AVC/quality-32 public video, 10 seconds of playback followed by a seek and 10 more seconds, one mode at a time. Overseas-only first frame was 526 ms. All three trials had no fatal errors or dropped frames and no recorded steady-state network interruptions. This harness proxies media through the local Node server: browser MSE/decoding are real, but upstream DNS/TLS/connections belong to Node. Shared server connections and CDN caches can warm across trials. These numbers establish basic functionality and an exploratory result, not p95 improvement or logged-in 4K performance. Raw local results are in ignored `dist/west-coast-playback.json`.

The stricter route probe again returned valid overseas/original 1 MiB samples at 11.3–12.1 Mbps, versus 1.3–4.8 Mbps on successful mainland hosts. These remain single samples on one AT&T connection.

Further experiments remain gated on evidence: authenticated 4K/4K60 and evening repetitions, long-session memory/quota behavior, Safari behavior, broader progressive-appending rollout, adjacent-header coalescing, per-host chunk-size tuning, and optional automatic quality switching. The installed release keeps quality under the viewer's control; it does not claim to sustain a bitrate above available bandwidth. Existing chunk sizing and quota reduction remain in place.

Local release validation: all 13 groups in `dev/run-tests.js` passed, including Tampermonkey packaging/storage/update integration and the expanded browser regressions for 2x buffer accounting and progressive appends. Eight additional fork tests passed, including exact source/bundle equality. A separate anonymous AV1 trial at actual playback rate 2x with the progressive option enabled recorded no fatal errors or network interruptions, first frame in 291 ms and seek-to-frame in 600 ms, with one dropped frame out of 865. It has the same proxy/cache/sample-size limitations as the 1x benchmark. The first-frame/seek metrics are separate from the conservative full startup-buffer-ready gate.

All seven real-media cases in `dev/native-mse-end-test.js` also passed: default/AVC/HEVC/AV1 startup, seeking and end-of-stream; strict-duration HEVC/AV1; and native quality synchronization, including switching while seeking and returning to Auto.
