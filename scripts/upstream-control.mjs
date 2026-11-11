// Only run this driver from the workflow's trusted checkout, never from the candidate.
// Write jobs inspect Git objects/JSON; they do not import candidate JavaScript.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ancestor, api, BOT_EMAIL, BRANCH, CANARY, compareVersions, FORK, git, reviewPaths, STABLE, STATE, STATUS, UPSTREAM, validateIdentity, versionOf } from "./upstream-sync.mjs";
import { closeReviewAlert, notifyNeedsReview } from "./review-alerts.mjs";

const SHA = /^[a-f0-9]{40}$/;
const VERSION = /^\d+\.\d+\.\d+\.\d+$/;
const MARKER = "<!-- btr-upstream-sync:v1 -->";
const runUrl = () => `https://github.com/${FORK}/actions/runs/${process.env.GITHUB_RUN_ID}`;
const output = values => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""));
};
function summary(message) {
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, message + "\n");
}
function alertReview(pr, key, reason, request = api) {
  try { notifyNeedsReview({ pr, key, reason, url: runUrl() }, request); }
  catch (error) { summary(`Review notification could not be sent: ${error.message}`); }
}
export function setStatus(sha, state, description, request = api) {
  if (!SHA.test(sha)) throw new Error("Invalid status SHA");
  request(`repos/${FORK}/statuses/${sha}`, "POST", { state, context: STATUS, description: description.slice(0, 140), target_url: runUrl() });
}
function openPr(request = api) {
  const prs = request(`repos/${FORK}/pulls?state=open&base=main&head=salileoss:${BRANCH}`);
  if (prs.length > 1) throw new Error("Multiple update PRs found");
  const pr = prs[0];
  if (pr && !pr.body?.includes(MARKER)) throw new Error("Existing update PR is not owned by this automation");
  return pr;
}
export function verifyCandidate(repo, result) {
  if (result.repository !== FORK || !SHA.test(result.sha) || !SHA.test(result.baseSha) || !SHA.test(result.upstreamSha) || !VERSION.test(result.stableVersion) || !VERSION.test(result.upstreamTag)) throw new Error("Invalid candidate report");
  const baseSha = git(repo, "rev-parse", "origin/main");
  if (baseSha !== result.baseSha) throw new Error("main moved; prepare and test a fresh candidate");
  if (!ancestor(repo, baseSha, result.sha) || !ancestor(repo, result.upstreamSha, result.sha)) throw new Error("Candidate lost fork or upstream ancestry");
  const state = JSON.parse(git(repo, "show", `${result.sha}:${STATE}`));
  for (const key of Object.keys(state)) if (JSON.stringify(state[key]) !== JSON.stringify(result[key])) throw new Error(`Report/state mismatch: ${key}`);
  if (versionOf(git(repo, "show", `${result.sha}:${STABLE}`)) !== result.stableVersion) throw new Error("Candidate stable version mismatch");
  if (compareVersions(result.stableVersion, versionOf(git(repo, "show", `${baseSha}:${STABLE}`))) <= 0) throw new Error("Candidate would not upgrade installed scripts");
  if (git(repo, "tag", "--list", result.stableVersion)) throw new Error("Candidate version collides with a published tag");
  const emails = git(repo, "log", result.sha, "--not", baseSha, result.upstreamSha, "--format=%ce").split("\n").filter(Boolean);
  if (!emails.length || emails.some(email => email !== BOT_EMAIL)) throw new Error("Candidate contains maintainer commits; manual handling required");
  validateIdentity(JSON.parse(git(repo, "show", `${result.sha}:user_scripts/adapter/meta.json`)));
  const common = git(repo, "merge-base", baseSha, result.upstreamSha);
  return [...new Set([...reviewPaths(git(repo, "diff", "--name-only", common, result.upstreamSha).split("\n")), ...reviewPaths(git(repo, "diff", "--name-only", baseSha, result.sha).split("\n")).filter(path => path !== STATE)])];
}
function prBody(result, paths) {
  return `${MARKER}\nIntegrates [upstream ${result.upstreamTag}](https://github.com/${UPSTREAM}/releases/tag/${result.upstreamTag}) (${result.upstreamSha}) into BTR West Coast **${result.stableVersion}**.\n\nFork base: ${result.baseSha}. Both generated bundles and fork release notes are included; CHANGELOG.md remains upstream-owned.\n\n[Preparation run](${runUrl()}). The \`${STATUS}\` status validates this exact candidate after explicitly dispatched CI; failures block automatic merge.\n\n${paths.length ? `**Manual review required:**\n\n${paths.map(path => `- \`${path}\``).join("\n")}` : "No protected paths changed. Guarded automatic merging applies when UPSTREAM_AUTO_MERGE and the repository setting are enabled."}\n\nMerge using **Create a merge commit** to preserve upstream ancestry. Merging publishes the stable script at its existing update URL.\n`;
}
async function pushCandidate(repo, directory) {
  const result = JSON.parse(readFileSync(resolve(directory, "report.json"), "utf8"));
  const pr = openPr();
  // Cancel any previously queued auto-merge before changing/invalidating the candidate.
  if (pr?.auto_merge) execFileSync("gh", ["pr", "merge", String(pr.number), "--repo", FORK, "--disable-auto"], { stdio: "inherit" });
  if (result.status === "blocked") {
    if (pr) setStatus(pr.head.sha, "failure", "Sync blocked; inspect this run before merging");
    const error = new Error(result.error);
    error.reviewKey = result.upstreamSha || result.upstreamTag || "sync";
    throw error;
  }
  if (result.status !== "candidate") {
    if (pr) setStatus(pr.head.sha, "failure", "Upstream release is already in main; close this superseded PR");
    if (!pr) closeReviewAlert();
    output({ status: "no-update" }); summary("No new upstream release to integrate."); return;
  }
  git(repo, "fetch", "--no-tags", resolve(directory, "candidate.bundle"), `refs/heads/${BRANCH}:refs/remotes/prepared/upstream-sync`);
  if (git(repo, "rev-parse", "refs/remotes/prepared/upstream-sync") !== result.sha) throw new Error("Bundle/report mismatch");
  git(repo, "fetch", "origin", "+refs/heads/main:refs/remotes/origin/main", "+refs/tags/*:refs/tags/*");
  const paths = verifyCandidate(repo, result);
  git(repo, "push", "origin", `${result.sha}:refs/heads/${BRANCH}`);
  const body = { title: `Update West Coast to upstream ${result.upstreamTag}`, body: prBody(result, paths), base: "main", head: BRANCH };
  const updated = pr ? api(`repos/${FORK}/pulls/${pr.number}`, "PATCH", { title: body.title, body: body.body }) : api(`repos/${FORK}/pulls`, "POST", body);
  setStatus(result.sha, "pending", "Running fork regression, browser and real-media tests");
  dispatchCandidateTests(api);
  output({ status: "candidate", sha: result.sha, pr: updated.number, review_required: paths.length > 0 });
  summary(`Update PR: ${updated.html_url}\n\nCandidate: ${result.sha}\n\nManual review: ${paths.length ? paths.join(", ") : "pilot mode"}`);
}
export function dispatchCandidateTests(request = api) {
  // workflow_dispatch runs on the candidate SHA even with GITHUB_TOKEN, without PR-run approval.
  request(`repos/${FORK}/actions/workflows/tests.yml/dispatches`, "POST", { ref: BRANCH, inputs: { online: "true", canary: "false", ignore_failures: "false" } });
}
export function autoMergeAllowed({ enabled, paths, protection, repository }) {
  return enabled === "true" && paths.length === 0 && repository.allow_auto_merge === true && repository.allow_merge_commit === true
    && protection.required_status_checks?.strict === true && protection.required_status_checks.contexts?.includes("汇总") && protection.enforce_admins?.enabled === true;
}
export const REQUIRED_CANDIDATE_JOBS = ["准备", "汇总", "离线 · 单元测试", "离线 · media-record-test", "离线 · userscript-test", "离线 · regression-smoke-test", "离线 · international-site-test", "真实视频 · BV1T1NZ6xEZZ", "真实视频 · BV1GJ411x7h7"];
export function verifyTestRun(run, workflowId, jobs) {
  if (run.event !== "workflow_dispatch" || run.path !== ".github/workflows/tests.yml" || run.workflow_id !== workflowId
    || run.head_branch !== BRANCH || run.repository?.full_name !== FORK || run.head_repository?.full_name !== FORK || !SHA.test(run.head_sha)) throw new Error("Not a trusted candidate CI run");
  if (run.status !== "completed" || run.conclusion !== "success") throw new Error("Candidate tests did not all pass");
  for (const name of REQUIRED_CANDIDATE_JOBS) {
    const matches = jobs.filter(job => job.name === name);
    if (matches.length !== 1 || matches[0].status !== "completed" || matches[0].conclusion !== "success") throw new Error(`Missing or unsuccessful required candidate job: ${name}`);
  }
  return run.head_sha;
}
export function dispatchPublication(sha, request = api) {
  if (!SHA.test(sha)) throw new Error("Invalid merge SHA");
  request(`repos/${FORK}/actions/workflows/upstream-publish.yml/dispatches`, "POST", { ref: "main", inputs: { commit: sha } });
}
export function mergeAndPublish(pr, sha, request = api) {
  if (!Number.isSafeInteger(pr.number) || pr.head.sha !== sha || !SHA.test(sha)) throw new Error("Update PR changed during tests");
  const merged = request(`repos/${FORK}/pulls/${pr.number}/merge`, "PUT", { sha, merge_method: "merge" });
  if (!merged.merged || !SHA.test(merged.sha)) throw new Error("GitHub did not merge the candidate");
  // Token-generated merges do not start push workflows. Publish the exact merge explicitly.
  dispatchPublication(merged.sha, request);
  return merged.sha;
}
export async function completeCandidate(repo, runId, request = api, enabled = process.env.UPSTREAM_AUTO_MERGE) {
  if (!/^\d+$/.test(runId || "")) throw new Error("Expected a workflow run ID");
  const run = request(`repos/${FORK}/actions/runs/${runId}`);
  const workflow = request(`repos/${FORK}/actions/workflows/tests.yml`);
  const pr = openPr(request);
  if (pr && pr.head.sha !== run.head_sha) { summary("Ignoring a CI result for a superseded candidate."); return; }
  let sha;
  try {
    const jobs = request(`repos/${FORK}/actions/runs/${runId}/jobs?per_page=100`);
    sha = verifyTestRun(run, workflow.id, jobs.jobs);
    if (!pr) {
      // A previous completion may have merged successfully before publication dispatch failed.
      const closed = request(`repos/${FORK}/pulls?state=closed&base=main&head=salileoss:${BRANCH}`);
      const merged = closed.find(item => item.merged_at && item.head.sha === sha && item.body?.includes(MARKER));
      if (merged) { dispatchPublication(merged.merge_commit_sha, request); closeReviewAlert(request); summary("Retried publication for the already merged candidate."); }
      else summary("No open automated update PR matches this run.");
      return;
    }
    git(repo, "fetch", "origin", "+refs/heads/main:refs/remotes/origin/main", "+refs/tags/*:refs/tags/*");
    git(repo, "fetch", "--no-tags", "origin", `refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`);
    if (git(repo, "rev-parse", `origin/${BRANCH}`) !== sha) throw new Error("Update branch changed during tests");
    const result = { ...JSON.parse(git(repo, "show", `${sha}:${STATE}`)), sha };
    const paths = verifyCandidate(repo, result);
    setStatus(sha, "success", "All candidate tests passed; required branch checks remain enforced", request);
    if (enabled !== "true" || paths.length) {
      alertReview(pr, sha, paths.length ? `Protected files require review:\n${paths.join("\n")}` : "Automatic merging is disabled; review and merge this tested update.", request);
      summary("Candidate passed. Reviewed merge required (auto-merge off or protected paths)."); return;
    }
    const protection = request(`repos/${FORK}/branches/main/protection`);
    if (!autoMergeAllowed({ enabled, paths, protection, repository: request(`repos/${FORK}`) })) throw new Error("Auto-merge requires strict required checks, admin enforcement and repository merge/auto-merge support");
    const current = openPr(request);
    if (!current || current.head.sha !== sha) throw new Error("Update PR changed during tests");
    const mergedSha = mergeAndPublish(current, sha, request);
    closeReviewAlert(request);
    summary(`Merged update PR #${pr.number} at ${mergedSha} and dispatched publication.`);
  } catch (error) {
    if (pr && SHA.test(run.head_sha)) {
      setStatus(run.head_sha, "failure", error.message, request);
      alertReview(openPr(request), run.head_sha, error.message, request);
    }
    throw error;
  }
}
export async function verifyRelease(repo, sha) {
  if (!SHA.test(sha)) throw new Error("Release needs an exact commit SHA");
  if (!ancestor(repo, sha, "origin/main")) throw new Error("Release commit is not on fork main");
  git(repo, "checkout", "--detach", sha);
  if (!existsSync(resolve(repo, STATE))) return null;
  const state = JSON.parse(readFileSync(resolve(repo, STATE), "utf8"));
  if (state.repository !== FORK || !SHA.test(state.upstreamSha) || !SHA.test(state.baseSha) || !VERSION.test(state.stableVersion)) throw new Error("Invalid release provenance");
  const stable = readFileSync(resolve(repo, STABLE), "utf8").replace(/\r\n/g, "\n");
  if (versionOf(stable) !== state.stableVersion) return null; // A later, manually prepared release.
  if (!ancestor(repo, state.upstreamSha, sha) || !ancestor(repo, state.baseSha, sha)) throw new Error("Release lost upstream/fork ancestry");
  const build = await import(pathToFileURL(resolve(repo, "scripts/build.mjs")).href);
  validateIdentity(build.meta);
  if (stable !== build.buildUserscript(state.stableVersion)) throw new Error("Stable bundle does not match released source");
  if (readFileSync(resolve(repo, CANARY), "utf8").replace(/\r\n/g, "\n") !== build.buildUserscript(state.canaryVersion, { channel: "canary" })) throw new Error("Canary bundle does not match released source");
  const parentVersion = versionOf(git(repo, "show", `${sha}^1:${STABLE}`));
  if (compareVersions(state.stableVersion, parentVersion) <= 0) throw new Error("Release commit must advance the stable version; rerun with the original merge SHA");
  execFileSync(process.execPath, [resolve(repo, "scripts/release-notes.mjs"), state.stableVersion], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  return { tag: state.stableVersion, sha };
}
export function publishTag({ tag, sha }, request = api) {
  if (!VERSION.test(tag) || !SHA.test(sha)) throw new Error("Invalid release tag/SHA");
  const refs = request(`repos/${FORK}/git/matching-refs/tags/${tag}`);
  const exact = refs.find(ref => ref.ref === `refs/tags/${tag}`);
  if (exact && (exact.object.type !== "commit" || exact.object.sha !== sha)) throw new Error("Existing tag points elsewhere; refusing to move it");
  if (!exact) request(`repos/${FORK}/git/refs`, "POST", { ref: `refs/tags/${tag}`, sha });
  // GITHUB_TOKEN tag creation does not trigger push workflows. Dispatch explicitly.
  request(`repos/${FORK}/actions/workflows/release.yml/dispatches`, "POST", { ref: "main", inputs: { tag } });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const command = process.argv[2], repo = process.cwd();
  if (command === "push") {
    try { await pushCandidate(repo, process.argv[3]); }
    catch (error) {
      const pr = openPr();
      if (pr) setStatus(pr.head.sha, "failure", "Sync blocked; inspect this run before merging");
      alertReview(pr, error.reviewKey || pr?.head.sha || "sync", error.message);
      throw error;
    }
  }
  else if (command === "complete") await completeCandidate(repo, process.argv[3]);
  else if (command === "verify-release") {
    const result = await verifyRelease(repo, process.argv[3]);
    output(result ? { ...result, publish: "true" } : { publish: "false" });
    summary(result ? `Verified release ${result.tag} at ${result.sha}` : "This is not an upstream-sync release.");
  } else if (command === "tag") publishTag({ tag: process.env.RELEASE_TAG, sha: process.env.RELEASE_SHA });
  else throw new Error("Use push, complete, verify-release or tag");
}
