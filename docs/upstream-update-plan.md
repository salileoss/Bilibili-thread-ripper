# Upstream updates for BTR West Coast

The fork follows published upstream stable releases. Daily preparation runs at 14:17 UTC; **Actions → Upstream sync → Run workflow** starts a check immediately. Automatic merging requires both the repository setting and `UPSTREAM_AUTO_MERGE=true`.

## Separate release histories

- `CHANGELOG.md` belongs to upstream. It is restored to the exact file at imported upstream commit `e409a42cbec60d4ceb430dc53d8a7942e07c1d31` during migration and is never edited by fork release preparation.
- `FORK_CHANGELOG.md` contains the West Coast releases, including the existing `2026.11.2.1` and `2026.11.4.1` history. Write fork release notes under its `## [Unreleased]` heading.
- Sync candidates, `scripts/release.mjs`, `scripts/release-notes.mjs` and userscript version tests use the fork changelog. Identical date-based version headings in the two files remain independent.
- Both histories are retained. Routine upstream changelog additions now merge without competing with fork release insertions. Source conflicts still stop preparation.

## How an update travels through the workflows

1. **Upstream sync** (`upstream-sync.yml`) resolves the newest published, non-draft, non-prerelease upstream Release to an exact commit. An already imported release is a no-op. Preparation uses a disposable clone, fetches upstream history without importing its tags, and preserves upstream ancestry.
2. Preparation merges into `automation/upstream-sync`, advances the fork stable version, rebuilds both bundles from the merged source, writes fork release notes and records `upstream-sync.json`. Generated bundle conflicts are rebuilt; other conflicts require manual resolution. Maintainer commits on a pending bot branch stop automatic branch updates. There is one update PR and no force-push.
3. The write job maintains the PR, marks **Upstream candidate** pending, and explicitly dispatches **Tests** on the candidate branch with real-media checks enabled and Canary publication disabled. This produces native checks on the candidate SHA using the built-in token, independently of whether the PR's separate event-triggered run requires approval.
4. **Complete upstream update** (`upstream-complete.yml`) handles only completed, explicitly dispatched Tests runs from this repository's bot branch. Its write-enabled job checks out trusted default-branch tooling, never candidate code or executable artifacts. It verifies the workflow identity, exact candidate SHA, all required unit/browser/real-media jobs, current branch head, current fork main, increasing version, fork identity and upstream ancestry.
5. With automatic merging disabled or protected paths changed, the candidate waits for a reviewed merge. Otherwise the controller verifies strict branch protection and sends an ordinary merge-commit request pinned to the tested head SHA. GitHub still enforces required checks and reviews; no bypass is used.
6. A successful token merge explicitly dispatches **Publish upstream update** with the returned merge SHA, because a token-generated merge does not reliably start push-triggered workflows. This workflow verifies the real bundles and release notes, creates an immutable fork version tag, and explicitly dispatches **Release**. Release retests before creating its record and downloadable script. Retry after a publication-dispatch failure uses the original merge SHA without merging again or moving tags.

The stable update URL serves `user_scripts/bilibili-thread-ripper.user.js` directly from fork main. **Merging a newer stable bundle publishes it immediately**, before the GitHub Release record finishes. Tampermonkey then detects the higher version according to its update settings. Keep all candidate checks before the merge.

## Auto-merge requirements and manual stops

Automatic merging requires all of the following:

- `UPSTREAM_AUTO_MERGE=true` and repository **Allow auto-merge** enabled.
- Merge commits enabled; a fresh candidate containing current fork main and a higher, unused fork version.
- Successful unit, browser and both real-media jobs from the explicitly dispatched candidate workflow. A skipped media job does not qualify.
- Branch protection requiring the native **汇总** check, requiring the branch to be up to date, and enforcing protection for administrators.
- No upstream or candidate changes to workflows, scripts, development/tests, adapter metadata, package configuration or incoming provenance files.

Conflicts, failed or skipped required checks, changed branches, stale main, version collisions, maintainer edits and protected-path changes leave the update for manual handling. The bot does not resolve source conflicts or approve its own PR. Tests reduce regression risk; they do not establish compatibility for every video, account or connection.

## Repository configuration

1. Keep Actions enabled and allow **Settings → Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests**. Default token permissions can remain read-only; write jobs request their limited permissions explicitly. The bot does not submit reviews.
2. Protect main: require a PR and the native **汇总** check from GitHub Actions, require an up-to-date branch, and enforce the rules for administrators. Do not require the bot-only **Upstream candidate** status for unrelated maintainer PRs. Leave bypasses disabled. The controller reads classic branch protection via the API, rather than rulesets.
3. Enable repository **Allow auto-merge**, keep merge commits enabled, and set repository variable `UPSTREAM_AUTO_MERGE` to `true` after the implementation's required checks pass. Unsetting it stops future automatic merges.
4. The built-in `GITHUB_TOKEN` supports routine auto-merges without stored credentials: candidate CI and publication are explicitly dispatched. It cannot push changes to workflow files. Those updates need a maintainer push or the optional App described below and remain manual-review updates.
5. Optional: for pushing workflow-file changes, configure a GitHub App installed only on this fork with Contents, Pull requests, Commit statuses, Actions and Workflows write permissions. Set `UPSTREAM_APP_CLIENT_ID` and secret `UPSTREAM_APP_PRIVATE_KEY`. The App is used only by the PR push job; it is not a prerequisite for routine auto-merges and no write credentials are passed to candidate test code.
6. Keep `CANARY_DIRECT_PUSH` unset. Candidates already include a Canary bundle, and direct writes to protected main are disabled by default in this fork.

GitHub may delay scheduled runs and can disable schedules in inactive public repositories. The manual trigger remains available. Workflow summaries and **Upstream candidate** report the current update result.

## Local checks and recovery

- `npm run sync:dry-run` discovers and prepares an update in a disposable clone without pushing, tagging or creating a PR. It writes a report and candidate bundle under `dist/upstream-sync/`; the working checkout stays untouched. Conflicts produce a failed command and a list of paths.
- `npm run test:upstream` runs temporary-repository integration tests. They are also part of `npm test`. Coverage includes separate changelogs across successive releases, generated/source conflicts, stale branches, versions, ownership, explicit CI, required media checks, guarded token merges and publication retries.
- Review ordinary updates in the PR, then use **Create a merge commit**. Merging preserves imported ancestry so later runs recognize completed updates.
- If source conflicts prevent the first candidate, resolve the merge on a maintainer branch, rebuild both bundles with newer versions, add fork release notes and provenance, and run the full tests. Do not select one side of a generated userscript as the final result.
- For publication recovery, run **Publish upstream update** with the exact original merge SHA. Existing tags are never moved. For rollback, publish known-good source as a new, higher fork version; reverting to an older version alone does not update installations that already received it.
- `npm run release` remains the local maintainer command; it reads `FORK_CHANGELOG.md`. Candidate automation uses its own branch preparation and does not invoke that command unchanged.

## Primary references

- [GitHub: triggering workflows from workflows](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)
- [GitHub: workflow_run events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)
- [GitHub: scheduled workflow behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- [Tampermonkey: update metadata](https://www.tampermonkey.net/documentation.php?locale=en&q=update_url)
