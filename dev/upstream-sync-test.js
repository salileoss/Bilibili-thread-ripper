"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const root = resolve(__dirname, "..");
(async () => {
const { ancestor, BRANCH, CANARY, compareVersions, FORK_CHANGELOG, git, nextVersion, prepareCandidate, reviewPaths, STABLE, validateIdentity } = await import("../scripts/upstream-sync.mjs");
const { autoMergeAllowed, completeCandidate, dispatchCandidateTests, mergeAndPublish, publishTag, REQUIRED_CANDIDATE_JOBS, verifyCandidate, verifyRelease, verifyTestRun } = await import("../scripts/upstream-control.mjs");
const now = new Date("2026-11-03T12:00:00Z");
function put(repo, file, content) {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), content);
}
function commit(repo, message) { git(repo, "add", "."); git(repo, "commit", "-m", message); return git(repo, "rev-parse", "HEAD"); }
async function fixture({ sourceConflict = false, protectedChange = false, identityChange = false } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "btr-sync-test-"));
  git(repo, "init", "-b", "main");
  git(repo, "config", "core.autocrlf", "false");
  const meta = JSON.parse(readFileSync(join(root, "user_scripts/adapter/meta.json"), "utf8"));
  meta.pageFiles = ["src/test.js", "src/fork.js"];
  put(repo, "user_scripts/adapter/meta.json", JSON.stringify(meta));
  put(repo, "user_scripts/adapter/loader.js", "// loader\n");
  put(repo, "src/test.js", "const runtime = 'base';\n");
  put(repo, "src/fork.js", "const westCoast = false;\n");
  put(repo, "CHANGELOG.md", "# Upstream changes\n\n## [Unreleased]\n\n## [2026.11.2.1] - 2026-11-02\n\n- Base.\n");
  mkdirSync(join(repo, "scripts"));
  for (const file of ["build.mjs", "release-notes.mjs"]) copyFileSync(join(root, "scripts", file), join(repo, "scripts", file));
  const build = await import(pathToFileURL(join(repo, "scripts/build.mjs")).href);
  const bundles = version => {
    put(repo, STABLE, build.buildUserscript(version));
    put(repo, CANARY, build.buildUserscript(version, { channel: "canary" }));
  };
  bundles("2026.11.2.1");
  commit(repo, "base");
  git(repo, "tag", "2026.11.2.1");
  git(repo, "branch", "upstream");
  put(repo, FORK_CHANGELOG, "# Fork changes\n\n## [Unreleased]\n\n- Maintainer notes.\n\n## [2026.11.2.2] - 2026-11-02\n\n- Fork improvements.\n");
  put(repo, "src/fork.js", "const westCoast = true;\n");
  if (sourceConflict) put(repo, "src/test.js", "const runtime = 'fork';\n");
  bundles("2026.11.2.2");
  const baseSha = commit(repo, "fork improvements");
  git(repo, "update-ref", "refs/remotes/origin/main", baseSha);
  git(repo, "checkout", "upstream");
  put(repo, "src/test.js", "const runtime = 'upstream-fixed';\n");
  put(repo, "CHANGELOG.md", "# Upstream changes\n\n## [Unreleased]\n\n## [2026.11.3.1] - 2026-11-03\n\n- Upstream fixes.\n\n## [2026.11.2.1] - 2026-11-02\n\n- Base.\n");
  if (protectedChange) put(repo, ".github/workflows/example.yml", "name: Changed workflow\n");
  if (identityChange) { meta.header.find(([key]) => key === "namespace")[1] = "https://github.com/original/repo"; put(repo, "user_scripts/adapter/meta.json", JSON.stringify(meta)); }
  bundles("2026.11.3.1");
  const upstreamSha = commit(repo, "upstream release");
  git(repo, "checkout", "main");
  return { repo, baseSha, upstreamSha, upstreamTag: "2026.11.3.1", now, build };
}

test("versions increase across date changes, existing tags and clocks behind the last release", () => {
  assert.equal(nextVersion(["2026.11.3.2", "2026.11.3.10"], now), "2026.11.3.11");
  assert.equal(nextVersion(["2026.11.2.99"], now), "2026.11.3.1");
  assert.equal(nextVersion(["2027.1.1.2"], now), "2027.1.1.3");
  assert.equal(compareVersions("2026.11.3.10", "2026.11.3.9"), 1);
  assert.throws(() => compareVersions("bad", "2026.11.3.1"));
});
test("no-update is a no-op when the release is already in main", async () => {
  const f = await fixture();
  const result = await prepareCandidate({ ...f, upstreamSha: f.baseSha });
  assert.equal(result.status, "no-update");
  assert.equal(git(f.repo, "rev-parse", "HEAD"), f.baseSha);
  assert.equal(git(f.repo, "status", "--porcelain"), "");
});
test("clean merge rebuilds conflicting generated bundles and preserves fork and upstream source", async () => {
  const f = await fixture();
  const result = await prepareCandidate(f);
  assert.equal(result.status, "candidate");
  assert.equal(readFileSync(join(f.repo, "src/fork.js"), "utf8"), "const westCoast = true;\n");
  assert.match(readFileSync(join(f.repo, "src/test.js"), "utf8"), /upstream-fixed/);
  assert.ok(ancestor(f.repo, f.baseSha, result.sha));
  assert.ok(ancestor(f.repo, f.upstreamSha, result.sha));
  assert.equal(readFileSync(join(f.repo, STABLE), "utf8"), f.build.buildUserscript(result.stableVersion));
  assert.equal(readFileSync(join(f.repo, CANARY), "utf8"), f.build.buildUserscript(result.canaryVersion, { channel: "canary" }));
  assert.equal(git(f.repo, "status", "--porcelain"), "");
  assert.equal(git(f.repo, "rev-parse", "main"), f.baseSha, "published main stays unchanged");
  assert.equal(git(f.repo, "tag", "--list"), "2026.11.2.1", "upstream release tag is not imported");
  assert.deepEqual(verifyCandidate(f.repo, result), []);
  assert.equal(readFileSync(join(f.repo, "CHANGELOG.md"), "utf8").trim(), git(f.repo, "show", `${f.upstreamSha}:CHANGELOG.md`), "upstream changelog stays byte-for-byte upstream-owned");
  assert.match(readFileSync(join(f.repo, FORK_CHANGELOG), "utf8"), /Fork improvements/);
});
test("reruns reuse the same candidate, commit and version", async () => {
  const f = await fixture(), first = await prepareCandidate(f);
  const second = await prepareCandidate({ ...f, existing: BRANCH });
  assert.equal(second.changed, false);
  assert.equal(second.sha, first.sha);
  assert.equal(second.stableVersion, first.stableVersion);
});
test("a later release retains previously published fork changelog entries", async () => {
  const f = await fixture(), first = await prepareCandidate(f);
  git(f.repo, "checkout", "main");
  git(f.repo, "merge", "--no-ff", BRANCH, "-m", "Merge first update");
  git(f.repo, "update-ref", "refs/remotes/origin/main", git(f.repo, "rev-parse", "HEAD"));
  git(f.repo, "tag", first.stableVersion);
  git(f.repo, "checkout", "upstream");
  put(f.repo, "src/test.js", "const runtime = 'second-upstream-fix';\n");
  put(f.repo, "CHANGELOG.md", readFileSync(join(f.repo, "CHANGELOG.md"), "utf8").replace("## [Unreleased]", "## [Unreleased]\n\n## [2026.11.4.1] - 2026-11-04\n\n- Another upstream release."));
  const upstreamSha = commit(f.repo, "next upstream release");
  git(f.repo, "checkout", "main");
  const next = await prepareCandidate({ ...f, upstreamSha, upstreamTag: "2026.11.4.1", existing: BRANCH });
  const changelog = readFileSync(join(f.repo, FORK_CHANGELOG), "utf8");
  assert.ok(changelog.includes(`## [${first.stableVersion}]`));
  assert.ok(changelog.includes(`## [${next.stableVersion}]`));
  assert.equal(readFileSync(join(f.repo, "CHANGELOG.md"), "utf8").trim(), git(f.repo, "show", `${upstreamSha}:CHANGELOG.md`));
});
test("candidate Git bundle can be transported without checkout or execution in the writer", async () => {
  const f = await fixture(), result = await prepareCandidate(f);
  const transport = mkdtempSync(join(tmpdir(), "btr-bundle-test-")), bundle = join(transport, "candidate.bundle");
  git(f.repo, "bundle", "create", bundle, `refs/heads/${BRANCH}`, "^origin/main");
  const writer = join(transport, "writer");
  git(transport, "clone", "--no-hardlinks", "--branch", "main", f.repo, writer);
  git(writer, "fetch", "--no-tags", bundle, `refs/heads/${BRANCH}:refs/remotes/prepared/upstream-sync`);
  assert.equal(git(writer, "rev-parse", "refs/remotes/prepared/upstream-sync"), result.sha);
  assert.deepEqual(verifyCandidate(writer, result), []);
});
test("an existing version tag causes the pending candidate to be rebuilt at a higher version", async () => {
  const f = await fixture(), first = await prepareCandidate(f);
  git(f.repo, "tag", first.stableVersion, f.baseSha);
  assert.throws(() => verifyCandidate(f.repo, first), /collides/);
  const next = await prepareCandidate({ ...f, existing: BRANCH });
  assert.ok(compareVersions(next.stableVersion, first.stableVersion) > 0);
  const changelog = readFileSync(join(f.repo, FORK_CHANGELOG), "utf8");
  assert.equal((changelog.match(/West Coast upstream update/g) || []).length, 1);
  assert.match(changelog, /## \[Unreleased\]\n\n- Maintainer notes\.\n\n## \[/);
});
test("main moving invalidates the old candidate and a later run incorporates it without rewriting history", async () => {
  const f = await fixture(), first = await prepareCandidate(f);
  git(f.repo, "checkout", "main");
  put(f.repo, "README.md", "A maintainer change on main.\n");
  const newMain = commit(f.repo, "maintainer change");
  git(f.repo, "update-ref", "refs/remotes/origin/main", newMain);
  assert.throws(() => verifyCandidate(f.repo, first), /main moved/);
  const next = await prepareCandidate({ ...f, existing: BRANCH });
  assert.ok(ancestor(f.repo, first.sha, next.sha));
  assert.ok(ancestor(f.repo, newMain, next.sha));
  assert.equal(next.baseSha, newMain);
  assert.equal(readFileSync(join(f.repo, "README.md"), "utf8"), "A maintainer change on main.\n");
});
test("source conflicts abort the merge without changing published main or leaving conflict markers", async () => {
  const f = await fixture({ sourceConflict: true });
  await assert.rejects(prepareCandidate(f), /Merge blocked:.*src\/test.js/);
  assert.equal(git(f.repo, "rev-parse", "main"), f.baseSha);
  assert.equal(git(f.repo, "status", "--porcelain"), "");
  assert.doesNotMatch(readFileSync(join(f.repo, "src/test.js"), "utf8"), /<<<<<<</);
});
test("maintainer commits freeze the existing update branch", async () => {
  const f = await fixture(), first = await prepareCandidate(f);
  put(f.repo, "README.md", "A manual resolution.\n");
  git(f.repo, "add", ".");
  git(f.repo, "-c", "user.email=maintainer@example.com", "commit", "-m", "manual change");
  await assert.rejects(prepareCandidate({ ...f, existing: BRANCH }), /maintainer commits/);
  assert.ok(ancestor(f.repo, first.sha, "HEAD"));
});
test("workflow changes are flagged for manual review and metadata cannot switch update ownership", async () => {
  const f = await fixture({ protectedChange: true }), result = await prepareCandidate(f);
  assert.deepEqual(result.reviewRequiredPaths, [".github/workflows/example.yml"]);
  assert.deepEqual(verifyCandidate(f.repo, result), result.reviewRequiredPaths);
  const other = await fixture({ identityChange: true });
  await assert.rejects(prepareCandidate(other), /namespace changed/);
  assert.equal(git(other.repo, "rev-parse", "main"), other.baseSha);
  assert.ok(reviewPaths(["scripts/build.mjs", "dev/run-tests.js", "src/idm-downloader.js"]).length === 2);
  const meta = JSON.parse(readFileSync(join(root, "user_scripts/adapter/meta.json"), "utf8"));
  meta.header.push(["updateURL", "https://example.com/script"]);
  assert.throws(() => validateIdentity(meta), /updateURL changed/);
});
test("merge-commit release is verified; a stale/wrong-version release is rejected", async () => {
  const f = await fixture(), result = await prepareCandidate(f);
  git(f.repo, "checkout", "main");
  git(f.repo, "merge", "--no-ff", BRANCH, "-m", "Merge update PR");
  const sha = git(f.repo, "rev-parse", "HEAD");
  git(f.repo, "update-ref", "refs/remotes/origin/main", sha);
  assert.deepEqual(await verifyRelease(f.repo, sha), { tag: result.stableVersion, sha });
  assert.equal(await verifyRelease(f.repo, f.upstreamSha), null, "ordinary upstream commits are not fork releases");
  git(f.repo, "checkout", "main");
  put(f.repo, "README.md", "Later unrelated commit.\n");
  const later = commit(f.repo, "later change");
  git(f.repo, "update-ref", "refs/remotes/origin/main", later);
  await assert.rejects(verifyRelease(f.repo, later), /advance the stable version/);
});
test("publication creates the exact tag once, explicitly dispatches Release, and never moves a tag", () => {
  const sha = "a".repeat(40), calls = [];
  let refs = [];
  const request = (endpoint, method = "GET", body) => {
    calls.push({ endpoint, method, body });
    if (method === "GET") return refs;
    if (endpoint.endsWith("/git/refs")) refs = [{ ref: `refs/tags/${body.ref.split("/").pop()}`, object: { type: "commit", sha: body.sha } }];
    return null;
  };
  publishTag({ tag: "2026.11.3.1", sha }, request);
  publishTag({ tag: "2026.11.3.1", sha }, request);
  assert.equal(calls.filter(call => call.endpoint.endsWith("/git/refs")).length, 1);
  assert.equal(calls.filter(call => call.endpoint.endsWith("/dispatches")).length, 2);
  assert.deepEqual(calls.at(-1).body, { ref: "main", inputs: { tag: "2026.11.3.1" } });
  assert.throws(() => publishTag({ tag: "2026.11.3.1", sha: "b".repeat(40) }, request), /refusing to move/);
});
test("auto-merge is opt-in and rejects protected paths or weak branch protection", () => {
  const options = { enabled: "true", paths: [], protection: { required_status_checks: { strict: true, contexts: ["汇总"] }, enforce_admins: { enabled: true } }, repository: { allow_auto_merge: true, allow_merge_commit: true } };
  assert.equal(autoMergeAllowed(options), true);
  for (const override of [{ enabled: "false" }, { paths: ["scripts/build.mjs"] }, { protection: {} }, { protection: { required_status_checks: { strict: true, contexts: ["unrelated"] }, enforce_admins: { enabled: true } } }, { repository: { allow_auto_merge: true, allow_merge_commit: false } }]) assert.equal(Boolean(autoMergeAllowed({ ...options, ...override })), false);
});
const runFor = sha => ({ id: 42, event: "workflow_dispatch", workflow_id: 17, path: ".github/workflows/tests.yml", head_branch: BRANCH, repository: { full_name: "salileoss/Bilibili-thread-ripper" }, head_repository: { full_name: "salileoss/Bilibili-thread-ripper" }, head_sha: sha, status: "completed", conclusion: "success" });
const passedJobs = () => REQUIRED_CANDIDATE_JOBS.map(name => ({ name, status: "completed", conclusion: "success" }));
test("explicit candidate CI includes real media and does not publish Canary", () => {
  const calls = [];
  dispatchCandidateTests((...args) => calls.push(args));
  assert.deepEqual(calls[0], ["repos/salileoss/Bilibili-thread-ripper/actions/workflows/tests.yml/dispatches", "POST", { ref: BRANCH, inputs: { online: "true", canary: "false", ignore_failures: "false" } }]);
});
test("CI completion rejects unrelated runs, skipped media and incomplete regression coverage", () => {
  const run = runFor("a".repeat(40));
  assert.equal(verifyTestRun(run, 17, passedJobs()), run.head_sha);
  for (const override of [{ event: "pull_request" }, { workflow_id: 99 }, { head_branch: "main" }, { head_repository: { full_name: "other/repo" } }, { path: ".github/workflows/other.yml" }, { conclusion: "failure" }]) assert.throws(() => verifyTestRun({ ...run, ...override }, 17, passedJobs()));
  assert.throws(() => verifyTestRun(run, 17, passedJobs().filter(job => !job.name.includes("regression-smoke"))), /required candidate job/);
  const skipped = passedJobs(); skipped.find(job => job.name.startsWith("真实视频")).conclusion = "skipped";
  assert.throws(() => verifyTestRun(run, 17, skipped), /required candidate job/);
});

test("CI completion requires the browser groups actually dispatched by Tests", () => {
  const { browser } = JSON.parse(execFileSync(process.execPath, [join(root, "dev/run-tests.js"), "--list"], { encoding: "utf8" }));
  const run = runFor("a".repeat(40));
  const jobs = ["准备", "汇总", "离线 · 单元测试", ...browser.map(name => `离线 · ${name}`), "真实视频 · BV1T1NZ6xEZZ", "真实视频 · BV1GJ411x7h7"]
    .map(name => ({ name, status: "completed", conclusion: "success" }));
  assert.equal(verifyTestRun(run, 17, jobs), run.head_sha);
  for (const name of browser) {
    const incomplete = jobs.map(job => job.name === `离线 · ${name}` ? { ...job, conclusion: "skipped" } : job);
    assert.throws(() => verifyTestRun(run, 17, incomplete), /required candidate job/);
  }
});
test("a token merge pins the candidate SHA and explicitly publishes the returned merge SHA", () => {
  const sha = "a".repeat(40), mergedSha = "b".repeat(40), calls = [];
  mergeAndPublish({ number: 3, head: { sha } }, sha, (endpoint, method, body) => { calls.push({ endpoint, method, body }); return { merged: true, sha: mergedSha }; });
  assert.deepEqual(calls[0], { endpoint: "repos/salileoss/Bilibili-thread-ripper/pulls/3/merge", method: "PUT", body: { sha, merge_method: "merge" } });
  assert.deepEqual(calls[1].body, { ref: "main", inputs: { commit: mergedSha } });
  assert.throws(() => mergeAndPublish({ number: 3, head: { sha: mergedSha } }, sha), /changed during tests/);
  assert.throws(() => mergeAndPublish({ number: 3, head: { sha } }, sha, () => ({ merged: false })), /did not merge/);
});
async function completionFixture(options = {}) {
  const f = await fixture(options), result = await prepareCandidate(f);
  const origin = mkdtempSync(join(tmpdir(), "btr-completion-origin-"));
  git(f.repo, "clone", "--bare", f.repo, origin);
  git(f.repo, "remote", "add", "origin", origin);
  let pr = { number: 3, body: "<!-- btr-upstream-sync:v1 -->", head: { sha: result.sha } }, mergedPr;
  const calls = [], jobs = passedJobs();
  let failPublication = false;
  const request = (endpoint, method = "GET", body) => {
    calls.push({ endpoint, method, body });
    if (endpoint.endsWith("/actions/runs/42")) return runFor(result.sha);
    if (endpoint.endsWith("/actions/workflows/tests.yml")) return { id: 17 };
    if (endpoint.includes("/jobs?")) return { jobs };
    if (endpoint.includes("pulls?state=open")) return pr ? [pr] : [];
    if (endpoint.includes("pulls?state=closed")) return mergedPr ? [mergedPr] : [];
    if (endpoint.endsWith("/branches/main/protection")) return { required_status_checks: { strict: true, contexts: ["汇总"] }, enforce_admins: { enabled: true } };
    if (endpoint === "repos/salileoss/Bilibili-thread-ripper") return { allow_auto_merge: true, allow_merge_commit: true };
    if (method === "PUT" && endpoint.endsWith("/merge")) {
      const tree = git(f.repo, "rev-parse", `${result.sha}^{tree}`);
      const sha = git(f.repo, "commit-tree", tree, "-p", result.baseSha, "-p", result.sha, "-m", "Reviewed merge");
      git(f.repo, "push", "origin", `${sha}:refs/heads/main`);
      mergedPr = { ...pr, merged_at: "2026-11-04T00:00:00Z", merge_commit_sha: sha }; pr = null;
      return { merged: true, sha };
    }
    if (endpoint.endsWith("/upstream-publish.yml/dispatches") && failPublication) { failPublication = false; throw new Error("Transient publication failure"); }
    return null;
  };
  return { ...f, result, request, calls, jobs, failNextPublication: () => { failPublication = true; } };
}
test("built-in token completion merges only a fresh fully tested candidate and retries publication without merging twice", async () => {
  const f = await completionFixture();
  f.failNextPublication();
  await assert.rejects(completeCandidate(f.repo, "42", f.request, "true"), /Transient publication/);
  await completeCandidate(f.repo, "42", f.request, "true");
  assert.equal(f.calls.filter(call => call.method === "PUT").length, 1);
  assert.equal(f.calls.filter(call => call.endpoint.endsWith("/upstream-publish.yml/dispatches")).length, 2);
});
test("failed media and protected-path changes never reach the merge API", async () => {
  const failed = await completionFixture();
  failed.jobs.find(job => job.name.startsWith("真实视频")).conclusion = "failure";
  await assert.rejects(completeCandidate(failed.repo, "42", failed.request, "true"), /required candidate job/);
  assert.ok(!failed.calls.some(call => call.method === "PUT"));
  const guarded = await completionFixture({ protectedChange: true });
  await completeCandidate(guarded.repo, "42", guarded.request, "true");
  assert.ok(!guarded.calls.some(call => call.method === "PUT"));
  assert.ok(guarded.calls.some(call => call.body?.state === "success"));
});
test("main moving after native CI blocks token auto-merge", async () => {
  const f = await completionFixture();
  const tree = git(f.repo, "rev-parse", `${f.baseSha}^{tree}`);
  const moved = git(f.repo, "commit-tree", tree, "-p", f.baseSha, "-m", "main moved");
  git(f.repo, "push", "origin", `${moved}:refs/heads/main`);
  await assert.rejects(completeCandidate(f.repo, "42", f.request, "true"), /main moved/);
  assert.ok(!f.calls.some(call => call.method === "PUT"));
});
})().catch(error => { console.error(error); process.exitCode = 1; });
