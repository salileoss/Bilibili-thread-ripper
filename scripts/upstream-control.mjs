// Only run this driver from the workflow's trusted checkout, never from the candidate.
// Write jobs inspect Git objects/JSON; they do not import candidate JavaScript.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ancestor, api, BOT_EMAIL, BRANCH, CANARY, compareVersions, FORK, git, reviewPaths, STABLE, STATE, STATUS, UPSTREAM, validateIdentity, versionOf } from "./upstream-sync.mjs";

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
export function setStatus(sha, state, description, request = api) {
  if (!SHA.test(sha)) throw new Error("Invalid status SHA");
  request(`repos/${FORK}/statuses/${sha}`, "POST", { state, context: STATUS, description: description.slice(0, 140), target_url: runUrl() });
}
function openPr() {
  const prs = api(`repos/${FORK}/pulls?state=open&base=main&head=salileoss:${BRANCH}`);
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
  return `${MARKER}\nIntegrates [upstream ${result.upstreamTag}](https://github.com/${UPSTREAM}/releases/tag/${result.upstreamTag}) (${result.upstreamSha}) into BTR West Coast **${result.stableVersion}**.\n\nFork base: ${result.baseSha}. Both generated bundles and release notes are included.\n\n[Validation run](${runUrl()}). The \`${STATUS}\` status validates this exact candidate; failures block automatic merge.\n\n${paths.length ? `**Manual review required:**\n\n${paths.map(path => `- \`${path}\``).join("\n")}` : "No protected paths changed. Automatic merging remains off unless UPSTREAM_AUTO_MERGE is enabled and a GitHub App is configured."}\n\nMerge using **Create a merge commit** to preserve upstream ancestry. Merging publishes the stable script at its existing update URL.\n`;
}
async function pushCandidate(repo, directory) {
  const result = JSON.parse(readFileSync(resolve(directory, "report.json"), "utf8"));
  const pr = openPr();
  // Cancel any previously queued auto-merge before changing/invalidating the candidate.
  if (pr?.auto_merge) execFileSync("gh", ["pr", "merge", String(pr.number), "--repo", FORK, "--disable-auto"], { stdio: "inherit" });
  if (result.status === "blocked") {
    if (pr) setStatus(pr.head.sha, "failure", "Sync blocked; inspect this run before merging");
    throw new Error(result.error);
  }
  if (result.status !== "candidate") {
    if (pr) setStatus(pr.head.sha, "failure", "Upstream release is already in main; close this superseded PR");
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
  output({ status: "candidate", sha: result.sha, pr: updated.number, review_required: paths.length > 0 });
  summary(`Update PR: ${updated.html_url}\n\nCandidate: ${result.sha}\n\nManual review: ${paths.length ? paths.join(", ") : "pilot mode"}`);
}
export function autoMergeAllowed({ enabled, app, paths, protection, repository }) {
  return enabled === "true" && app === "true" && paths.length === 0 && repository.allow_auto_merge === true && repository.allow_merge_commit === true
    && protection.required_status_checks?.strict === true && protection.required_status_checks.contexts?.includes("汇总") && protection.enforce_admins?.enabled === true;
}
async function finish(repo, directory) {
  const result = JSON.parse(readFileSync(resolve(directory, "report.json"), "utf8"));
  let paths;
  try {
    if (process.env.TEST_RESULT !== "success") throw new Error("Candidate tests did not all pass");
    git(repo, "fetch", "origin", "+refs/heads/main:refs/remotes/origin/main", "+refs/tags/*:refs/tags/*");
    git(repo, "fetch", "--no-tags", "origin", `refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`);
    if (git(repo, "rev-parse", `origin/${BRANCH}`) !== result.sha) throw new Error("Update branch changed during tests");
    paths = verifyCandidate(repo, result);
    setStatus(result.sha, "success", "All candidate tests passed; reviewed merge is available");
  } catch (error) { setStatus(result.sha, "failure", error.message); throw error; }
  if (process.env.UPSTREAM_AUTO_MERGE !== "true" || process.env.HAS_APP !== "true" || paths.length) {
    summary("Candidate passed. Merge-commit review required (pilot mode or protected paths)."); return;
  }
  const protection = api(`repos/${FORK}/branches/main/protection`);
  if (!autoMergeAllowed({ enabled: process.env.UPSTREAM_AUTO_MERGE, app: process.env.HAS_APP, paths, protection, repository: api(`repos/${FORK}`) })) throw new Error("Auto-merge requires strict required checks, admin enforcement and repository merge/auto-merge support");
  const pr = openPr();
  if (!pr || pr.head.sha !== result.sha) throw new Error("Update PR changed during tests");
  execFileSync("gh", ["pr", "merge", String(pr.number), "--repo", FORK, "--auto", "--merge", "--match-head-commit", result.sha], { stdio: "inherit" });
  summary(`Enabled merge-commit auto-merge for PR #${pr.number}.`);
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
      throw error;
    }
  }
  else if (command === "finish") await finish(repo, process.argv[3]);
  else if (command === "verify-release") {
    const result = await verifyRelease(repo, process.argv[3]);
    output(result ? { ...result, publish: "true" } : { publish: "false" });
    summary(result ? `Verified release ${result.tag} at ${result.sha}` : "This is not an upstream-sync release.");
  } else if (command === "tag") publishTag({ tag: process.env.RELEASE_TAG, sha: process.env.RELEASE_SHA });
  else throw new Error("Use push, finish, verify-release or tag");
}
