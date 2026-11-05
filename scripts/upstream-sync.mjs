// Trusted sync driver. Candidate build code runs only in the read-only preparation job.
// `node scripts/upstream-sync.mjs dry-run` works in a disposable clone, never this checkout.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const FORK = "salileoss/Bilibili-thread-ripper";
export const UPSTREAM = "MrTangLuyao/Bilibili-thread-ripper";
export const BRANCH = "automation/upstream-sync";
export const STATUS = "Upstream candidate";
export const STATE = "upstream-sync.json";
export const FORK_CHANGELOG = "FORK_CHANGELOG.md";
export const STABLE = "user_scripts/bilibili-thread-ripper.user.js";
export const CANARY = "canary/bilibili-thread-ripper-canary.user.js";
export const BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";
const VERSION = /^\d+\.\d+\.\d+\.\d+$/;
const SHA = /^[a-f0-9]{40}$/;
const normalize = text => text.replace(/\r\n/g, "\n");
export const versionOf = text => /^\/\/ @version\s+(\S+)/m.exec(text)?.[1];
export function compareVersions(a, b) {
  if (!VERSION.test(a) || !VERSION.test(b)) throw new Error("Expected four numeric version parts");
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  const index = x.findIndex((part, i) => part !== y[i]);
  return index < 0 ? 0 : Math.sign(x[index] - y[index]);
}
export function nextVersion(previous, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Melbourne", year: "numeric", month: "numeric", day: "numeric" })
    .formatToParts(now).filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
  let latest = `${parts.year}.${parts.month}.${parts.day}.0`;
  for (const value of previous.filter(value => VERSION.test(value || ""))) if (compareVersions(value, latest) > 0) latest = value;
  const numbers = latest.split(".").map(Number);
  numbers[3] += 1;
  return numbers.join(".");
}
export function git(repo, ...args) {
  return execFileSync("git", ["-c", `safe.directory=${resolve(repo).replace(/\\/g, "/")}`, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
    "-c", "user.name=github-actions[bot]", "-c", `user.email=${BOT_EMAIL}`, ...args], { cwd: repo, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}
export function ancestor(repo, older, newer) {
  try { git(repo, "merge-base", "--is-ancestor", older, newer); return true; }
  catch (error) { if (error.status === 1) return false; throw error; }
}
export function api(endpoint, method = "GET", body) {
  return JSON.parse(execFileSync("gh", ["api", endpoint, "--method", method, ...(body ? ["--input", "-"] : [])], {
    encoding: "utf8", input: body ? JSON.stringify(body) : undefined, stdio: ["pipe", "pipe", "pipe"] }) || "null");
}
export function reviewPaths(paths) {
  return paths.filter(path => /^(?:\.github\/workflows\/|scripts\/|dev\/|user_scripts\/adapter\/|package(?:-lock)?\.json$|upstream-sync\.json$)/.test(path));
}
export function validateIdentity(meta) {
  const entries = key => meta.header.filter(([name]) => name === key).map(([, value]) => value);
  const expected = { name: "BTR West Coast", namespace: `https://github.com/${FORK}`, updateURL: `https://raw.githubusercontent.com/${FORK}/main/${STABLE}`, downloadURL: `https://raw.githubusercontent.com/${FORK}/main/${STABLE}` };
  if (meta.output !== STABLE) throw new Error("Fork output path changed; manual repair required");
  for (const [key, value] of Object.entries(expected)) if (JSON.stringify(entries(key)) !== JSON.stringify([value])) throw new Error(`Fork ${key} changed; manual repair required`);
}
function readState(repo) {
  return existsSync(join(repo, STATE)) ? JSON.parse(readFileSync(join(repo, STATE), "utf8")) : null;
}
function merge(repo, ref) {
  if (ancestor(repo, ref, "HEAD")) return;
  try { git(repo, "merge", "--no-ff", "--no-commit", ref); }
  catch (error) {
    const conflicts = git(repo, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
    if (!conflicts.length || conflicts.some(path => ![STABLE, CANARY].includes(path))) {
      git(repo, "merge", "--abort");
      throw new Error(`Merge blocked: ${conflicts.join(", ") || error.stderr}`);
    }
    // These files are rebuilt from merged source below; never apply this rule to source.
    git(repo, "checkout", "--ours", "--", ...conflicts);
    git(repo, "add", "--", ...conflicts);
  }
  git(repo, "commit", "-m", `Merge ${ref}\n\nBTR-Upstream-Sync: v1`);
}

export async function prepareCandidate({ repo, upstreamSha, upstreamTag, base = "origin/main", existing = "", now = new Date() }) {
  if (!SHA.test(upstreamSha) || !VERSION.test(upstreamTag)) throw new Error("Invalid upstream release SHA/tag");
  if (git(repo, "status", "--porcelain")) throw new Error("Preparation requires a clean disposable checkout");
  const baseSha = git(repo, "rev-parse", `${base}^{commit}`);
  if (ancestor(repo, upstreamSha, baseSha)) return { status: "no-update", baseSha, upstreamSha, upstreamTag };
  // GitHub need not delete merged PR branches. Reuse their name from the newer main.
  if (existing && ancestor(repo, existing, baseSha)) existing = "";
  if (existing) {
    const emails = git(repo, "log", existing, "--not", baseSha, upstreamSha, "--format=%ce").split("\n").filter(Boolean);
    if (!emails.length || emails.some(email => email !== BOT_EMAIL)) throw new Error("Update branch has maintainer commits or unknown ownership; resolve it manually");
  }
  git(repo, "checkout", "-B", BRANCH, existing || baseSha);
  const oldState = readState(repo);
  const priorStable = versionOf(git(repo, "show", `HEAD:${STABLE}`));
  const priorCanary = versionOf(git(repo, "show", `HEAD:${CANARY}`));
  const baseVersion = versionOf(git(repo, "show", `${baseSha}:${STABLE}`));
  const baseCanary = versionOf(git(repo, "show", `${baseSha}:${CANARY}`));
  const tags = git(repo, "tag", "--list").split("\n");
  if (oldState?.baseSha === baseSha && oldState.upstreamSha === upstreamSha && !tags.includes(oldState.stableVersion)) {
    return { ...oldState, status: "candidate", sha: git(repo, "rev-parse", "HEAD"), changed: false };
  }
  const common = git(repo, "merge-base", baseSha, upstreamSha);
  const reviewRequiredPaths = reviewPaths(git(repo, "diff", "--name-only", common, upstreamSha).split("\n").filter(Boolean));
  merge(repo, baseSha);
  merge(repo, upstreamSha);
  const build = await import(`${pathToFileURL(join(repo, "scripts/build.mjs")).href}?candidate=${Date.now()}`);
  validateIdentity(build.meta);
  const stableVersion = nextVersion([baseVersion, priorStable, ...tags], now);
  const previousCanary = normalize(readFileSync(join(repo, CANARY), "utf8"));
  const canaryVersion = compareVersions(priorCanary, baseCanary) >= 0 && previousCanary === build.buildUserscript(priorCanary, { channel: "canary" })
    ? priorCanary : nextVersion([priorCanary, baseCanary], now);
  writeFileSync(join(repo, STABLE), build.buildUserscript(stableVersion));
  writeFileSync(join(repo, CANARY), build.buildUserscript(canaryVersion, { channel: "canary" }));
  let changelog = normalize(readFileSync(join(repo, FORK_CHANGELOG), "utf8"));
  if (existing && oldState?.stableVersion && compareVersions(oldState.stableVersion, baseVersion) > 0) {
    const heading = `## [${oldState.stableVersion}]`;
    const start = changelog.indexOf(heading);
    if (start >= 0) { const end = changelog.indexOf("\n## [", start + heading.length); changelog = changelog.slice(0, start) + (end < 0 ? "" : changelog.slice(end + 1)); }
  }
  if (!/^## \[Unreleased\]$/m.test(changelog)) throw new Error("Missing Unreleased changelog section");
  const date = stableVersion.split(".").slice(0, 3).map((part, i) => i ? part.padStart(2, "0") : part).join("-");
  const notes = `\n\n## [${stableVersion}] - ${date}\n\n### BTR West Coast upstream update\n\n- Integrate [upstream ${upstreamTag}](https://github.com/${UPSTREAM}/releases/tag/${upstreamTag}) (${upstreamSha}).\n- Retain the fork identity, saved settings and West Coast routing improvements.\n- [Upstream changes](https://github.com/${UPSTREAM}/compare/${common}...${upstreamSha}).`;
  const firstRelease = changelog.search(/^## \[\d+\.\d+\.\d+\.\d+\]/m);
  // Keep maintainer-authored Unreleased notes in place when replacing a pending candidate.
  const at = firstRelease < 0 ? changelog.length : firstRelease;
  changelog = changelog.slice(0, at).trimEnd() + notes + "\n\n" + changelog.slice(at);
  writeFileSync(join(repo, FORK_CHANGELOG), changelog);
  const state = { schema: 1, repository: FORK, baseSha, baseVersion, upstreamSha, upstreamTag, stableVersion, canaryVersion, reviewRequiredPaths };
  writeFileSync(join(repo, STATE), JSON.stringify(state, null, 2) + "\n");
  git(repo, "add", "--", STABLE, CANARY, FORK_CHANGELOG, STATE);
  git(repo, "commit", "-m", `Prepare West Coast ${stableVersion} from upstream ${upstreamTag}\n\nBTR-Upstream-Sync: v1`);
  return { ...state, status: "candidate", sha: git(repo, "rev-parse", "HEAD"), changed: true };
}

export function report(result, directory) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "report.json"), JSON.stringify(result, null, 2) + "\n");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `status=${result.status}\nsha=${result.sha || ""}\n`);
  const summary = `Upstream sync: **${result.status}**\n\n${result.error || (result.upstreamTag ? `Upstream ${result.upstreamTag} (${result.upstreamSha})` : "")}\n`;
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
}
async function prepare(directory) {
  let result;
  const releaseInfo = {};
  try {
    const release = api(`repos/${UPSTREAM}/releases/latest`);
    releaseInfo.upstreamTag = release.tag_name;
    if (release.draft || release.prerelease || !VERSION.test(release.tag_name)) throw new Error("Upstream latest release is not a supported stable version");
    const repo = mkdtempSync(join(tmpdir(), "btr-upstream-"));
    git(repo, "clone", "--no-tags", "--branch", "main", `https://github.com/${FORK}.git`, ".");
    git(repo, "fetch", "origin", "+refs/tags/*:refs/tags/*");
    const branch = git(repo, "ls-remote", "--heads", "origin", `refs/heads/${BRANCH}`);
    let existing = "";
    if (branch) { git(repo, "fetch", "--no-tags", "origin", `refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`); existing = `origin/${BRANCH}`; }
    git(repo, "fetch", "--no-tags", `https://github.com/${UPSTREAM}.git`, `refs/tags/${release.tag_name}`);
    const upstreamSha = git(repo, "rev-parse", "FETCH_HEAD^{commit}");
    releaseInfo.upstreamSha = upstreamSha;
    result = await prepareCandidate({ repo, upstreamSha, upstreamTag: release.tag_name, existing });
    if (result.status === "candidate") {
      mkdirSync(directory, { recursive: true });
      git(repo, "bundle", "create", resolve(directory, "candidate.bundle"), `refs/heads/${BRANCH}`, "^origin/main");
    }
  } catch (error) { result = { ...releaseInfo, status: "blocked", error: String(error.message) }; }
  report(result, directory);
  if (result.status === "blocked") process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!["prepare", "dry-run"].includes(process.argv[2])) throw new Error("Use prepare [output-directory] or dry-run [output-directory]");
  await prepare(resolve(process.argv[3] || "dist/upstream-sync"));
}
