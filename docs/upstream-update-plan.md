# Upstream updates for BTR West Coast

Status: implemented in the repository. Scheduling starts when these workflows reach fork `main`; automatic merging is off by default.

## Running and configuring the implementation

The implementation consists of `.github/workflows/upstream-sync.yml`, `.github/workflows/upstream-publish.yml`, `scripts/upstream-sync.mjs` and `scripts/upstream-control.mjs`. No runtime dependencies were added.

- `npm run sync:dry-run` fetches the fork and newest upstream stable release into a disposable clone, prepares a candidate if possible, and saves `dist/upstream-sync/report.json` and a Git bundle. It never pushes, tags or opens a PR, and leaves your working checkout untouched. A blocked merge exits unsuccessfully with the conflicted paths in the report.
- `npm run test:upstream` runs the temporary-repository integration tests. They are also included in `npm test` and the normal Actions test suite.
- **Actions → Upstream sync → Run workflow** runs the same preparation, maintains one update PR, runs the existing full test workflow, and attaches the `Upstream candidate` commit status. The scheduled run is daily at 14:17 UTC.
- After merging an update PR with **Create a merge commit**, **Publish upstream update** verifies the bundles and provenance, creates an immutable fork version tag, and explicitly dispatches **Release**. For recovery, run **Publish upstream update** with the exact original merge SHA, not a later unrelated commit. Publication can be retried without moving an existing tag.

Set up the fork before relying on scheduled updates:

1. Merge this implementation into fork `main` and enable the workflows under Actions. Keep merge commits enabled in repository settings. Run the workflow once manually to confirm repository permissions and CI behavior.
2. For the default `GITHUB_TOKEN` mode, enable **Settings → Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests**. The bot does not submit approvals. Candidate testing runs explicitly even if the PR's separate native workflow run awaits approval. If that run is required by branch protection, approve it before merging. `GITHUB_TOKEN` cannot push workflow-file changes; use the App mode below for those updates.
3. Prefer a GitHub App installed **only on this fork**, with Contents, Pull requests and Commit statuses write permissions and Workflows write permission for updates that include workflow files. Set the repository variable `UPSTREAM_APP_CLIENT_ID` and secret `UPSTREAM_APP_PRIVATE_KEY`. The workflows mint short-lived tokens only in the write jobs; neither the private key nor a write token is passed to candidate code. App-created PRs receive ordinary native CI runs.
4. Protect `main`: require a PR, require the native **Tests** workflow's **汇总** check, require the branch to be up to date, and apply the protection to administrators. Select the check once it has run in this fork. Review the additional `Upstream candidate` status on sync PRs; do not make that sync-only status mandatory for unrelated PRs. Leave bypass permissions disabled. These are existing-branch protection settings, not a ruleset; the auto-merge preflight reads the branch-protection API.
5. Direct Canary writes to this fork's `main` are now disabled by default, since sync candidates already include both bundles. Keep `CANARY_DIRECT_PUSH` unset when branch protection is enabled. Setting it to `true` opts back into the legacy direct-write behavior and can be rejected by branch protection.
6. Keep `UPSTREAM_AUTO_MERGE` unset for the pilot. After several reviewed updates, optionally enable repository auto-merge and set this variable to `true`. Automatic merge additionally requires App mode, strict branch protection with the **汇总** check, administrator enforcement, a fresh candidate, passing tests and no protected-path changes. The bot does not bypass required reviews or other repository rules.

`upstream-sync.json` is generated provenance committed only on candidate branches: fork base, upstream SHA/tag, fork stable/Canary versions and paths requiring review. Upstream changes to workflows, scripts, tests, adapter metadata or package configuration always require a reviewed merge. Maintainer commits on a pending update branch stop automated branch updates; resolve and merge that branch manually, or close its PR and delete the branch before starting over. No branch history is force-pushed.

If source or changelog conflicts prevent creating the first candidate, the run fails with a report and does not create a partial PR. Resolve that merge on a maintainer branch, rebuild both bundles with increasing versions, add release notes, and run the full tests before merging. A stopped run also invalidates the status on an existing update PR and cancels any previously queued auto-merge.

Validation on November 3, 2026: a dry run against upstream `2026.11.3.1` stopped on a `CHANGELOG.md` conflict (plus the generated stable bundle, which is rebuildable). No upstream changes were applied to fork `main`.

Local verification passed: all 14 sync integration tests, the complete existing unit/browser suite (including the version-upgrade settings test), and actionlint 1.7.12. Live-media tests were not run locally; the update workflow calls them through the existing reusable CI. Repository configuration, GitHub workflow execution and a real Tampermonkey update still require deployment of these changes to the fork.

## Goal and current setup

Automatically bring upstream fixes into the fork, retain the West Coast improvements, and deliver a newly versioned script through the existing Tampermonkey update URL. A clean Git merge is necessary but does not prove that behavior is preserved; fork regression tests are part of the release gate.

Local checkout inspected on November 3, 2026:

- Fork: `salileoss/Bilibili-thread-ripper`, remote `origin`, branch `main`.
- Original: `MrTangLuyao/Bilibili-thread-ripper`, remote `upstream`.
- Fork HEAD: `3edc239`, version `2026.11.2.1`, based on upstream commit `3e715f5`.
- The fork changes 29 files relative to that upstream base, including shared downloader/player code, metadata, tests, build scripts and generated bundles.
- Stable and Canary already have their own fork identity and update URLs.
- These are local refs, not a fresh check of the original repository's latest state.

## Update policy

Start by following upstream's newest published, non-draft, non-prerelease GitHub Release. Pin its tag to a commit SHA before merging. Ignore a release whose commit is already an ancestor of fork `main`; the fork already contains some upstream development after the last local stable tag. Never reset the fork to an older release.

Check daily, for example at `17 14 * * *` UTC, and support `workflow_dispatch` for an immediate check. Tracking every upstream `main` commit can be added later as an explicit Canary policy; a commit to upstream `main` is not automatically a stable release.

Use a temporary `automation/upstream-sync` branch and one open update PR at a time. Create it from current fork `main`, merge the selected upstream SHA, and retain upstream ancestry. Merge the PR with a merge commit rather than squash or rebase so future runs recognize imported commits. Do not mirror, reset or force-push fork `main`, and do not use a blanket "ours" or "theirs" conflict strategy.

Fetch upstream history without importing its tags into the fork's tag namespace. The existing build uses `git describe --tags`, and upstream tags must not become fork release versions. Record the upstream repository, release tag, SHA and compare link in the PR and fork release notes.

## Candidate preparation and verification

1. Resolve the release SHA and check whether it has already been incorporated. If so, finish without changing files or creating another PR.
2. Merge on the update branch. If there is an existing bot branch, incorporate current fork `main` without rewriting history. Pause automatic branch updates once a maintainer has added their own commits.
3. Stop on source, metadata or documentation conflicts and report the affected paths in the workflow summary. If a PR already exists, keep it blocked. Generated userscript conflicts can be resolved by rebuilding only after all source conflicts have been resolved.
4. Prepare a fork release entry and a new four-part numeric version using the existing date/build-number convention. Require it to exceed the published fork stable version and avoid existing fork tags; do not copy upstream's `@version`. Reserve and recheck the version if another release lands while the PR is open.
5. Rebuild both committed bundles from the merged source using `scripts/build.mjs` and `scripts/canary.mjs`, with independently increasing versions when their contents change. Commit the bundles and release notes on the candidate branch before verification.
6. Run the existing Node 24 CI, including unit tests, browser tests and real-media checks. Network failures block automatic publication and can be retried; do not enable `ignore_failures` for this workflow. Anonymous hosted tests do not establish West Coast or logged-in 4K performance.
7. Require the candidate to include current fork `main` and all checks to pass for the latest candidate. If `main` changes, merge it into the candidate, rebuild where necessary, and retest before merging.

Important existing constraint: `dev/west-coast-test.js` requires **both** committed stable and Canary bundles to exactly match the source. `npm run build` writes only a development bundle to `dist/`; it is not enough to prepare an upstream update. Waiting until after merge to rebuild stable would fail the current tests.

Keep the current safeguards and extend them with meaningful gaps before enabling automatic merges:

| Behavior to retain | Existing coverage / required addition |
| --- | --- |
| Auto mode keeps original, mainland and overseas routes eligible | Existing West Coast route tests |
| Latency-aware ranking, short-lived priors and adaptive concurrency | Existing West Coast scheduler tests |
| Fork name, namespace and stable/Canary update ownership | Existing bundle checks cover update URLs; add exact identity and download URL checks |
| Existing settings survive updates; defaults apply only to fresh installations | Add a persisted-settings upgrade case |
| Playback-rate-aware buffering and conservative feature defaults | Retain buffer tests; add missing default assertions |
| Diagnostics retain useful-byte accounting without signed URL leakage | Existing diagnostics test; retain playback diagnostics coverage |

Do not silently resolve shared runtime conflicts by keeping entire fork files: that would discard upstream fixes. Resolve the relevant logic together and verify its behavior.

## Merge, publication and installed-script updates

Begin with automatic preparation/testing and manual PR merges for the first few updates. After that pilot, enable automatic merge for conflict-free updates that pass all checks and do not touch the review-required paths below. Manual review remains the fallback for conflicts, failed checks or changes the tests do not establish as compatible.

The stable update URL serves `user_scripts/bilibili-thread-ripper.user.js` directly from fork `main`. Consequently, merging a PR that contains a newer stable bundle **publishes that update immediately**. All stable release checks belong before that merge, not only in the tag-triggered Release workflow.

After a successful merge, a publication job should:

1. Read the stable version and release notes from the merged commit, confirm the bundle matches its source, and tag that exact commit in the fork. Never move an existing tag.
2. Run the existing Release workflow explicitly for that tag, or call its reusable logic, to create the GitHub Release and attach the script. Make reruns idempotent. The existing workflow retests before creating the GitHub Release; this is additional verification after the update became available on `main`.
3. Let Tampermonkey detect the newer `@version` at the fork's unchanged `@updateURL` and download from its fork `@downloadURL`. Installation timing depends on the user's script-manager update settings; no reinstall is required for an existing fork installation.

Adapt the current release preparation into a candidate-building helper. Do not run `npm run release` unchanged in the bot: it requires `main`, performs local commits/tags, and does not push. Retain the existing local release command for maintainer use.

For rollback, publish the previous known-good source as a **new, higher** fork version. Reverting the bundle to an older version alone will not update users who already received the bad release. Preserve the upstream merge ancestry when reverting faulty behavior so subsequent syncs remain understandable.

## GitHub Actions wiring

- Add `upstream-sync.yml` for scheduled/manual discovery, candidate preparation and PR maintenance. Serialize sync runs and prevent duplicate PRs or releases.
- Reuse `tests.yml` for candidate checks, with no Canary publication on the update branch. Keep execution of candidate code in jobs without write credentials or secrets; grant writes only to jobs that push, manage the PR or publish.
- Require manual review whenever upstream changes workflows, build/release scripts, the test runner, fork regression tests or fork identity/update metadata. A change that weakens a guard must not qualify itself for automatic merge.
- Configure required checks on fork `main`. Reconcile those rules with the existing Canary workflow's direct writes; do not grant the sync bot unrestricted bypass of required checks. The bot must not approve its own PR.
- Prefer a repository-scoped GitHub App token for PR creation and automatic merges. Configure its required permissions, including workflow-file permission if it must push workflow changes, rather than using a broad personal token. Validate actual repository settings during implementation.
- If using `GITHUB_TOKEN` instead, explicitly dispatch checks/publication as needed and verify which commit receives the required checks. Current GitHub documentation says bot-created PR events can produce approval-required runs, while token-generated pushes generally do not trigger downstream workflows. Do not depend on a bot tag push starting Release automatically.
- Enable Actions/schedules in the fork and include a visible last-success summary. GitHub can delay schedules and disables public-repository schedules after 60 days without repository activity; retain the manual trigger as a recovery route.

## Implementation order and acceptance

1. Add a candidate release helper plus missing fork regression cases. Verify increasing versions, exact bundle generation and preserved settings.
2. Add a dry-run sync script. Exercise no-update, clean merge, generated-only conflict, source conflict, version collision and rerun cases in temporary repositories.
3. Add scheduled PR preparation and candidate CI. Confirm there is only one PR, required checks run on its current candidate, failures leave published `main` unchanged, and upstream history remains an ancestor after merging.
4. Add idempotent tagging/Release publication. Verify a test installation detects the newer fork version and retains its settings. Confirm the release and its asset refer to the merged commit and version.
5. After several successful reviewed updates, enable the restricted automatic-merge policy. Verify a simulated protected-path change, failed check, stale candidate and concurrent release each block publication.

## Primary references

- [GitHub: triggering workflows from workflows](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)
- [GitHub: scheduled workflow behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- [GitHub: repository Actions settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository)
- [Tampermonkey: update and download metadata](https://www.tampermonkey.net/documentation.php?locale=en&q=update_url)
