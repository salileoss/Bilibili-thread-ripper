// GitHub delivers review/assignment notifications to the maintainer's configured email.
// No email addresses, mail-service tokens or candidate code are used here.
import { createHash } from "node:crypto";
import { api, FORK } from "./upstream-sync.mjs";

export const REVIEWER = FORK.split("/")[0];
const ALERT = "<!-- btr-upstream-review:v1 -->";
function all(endpoint, request) {
  const result = [];
  for (let page = 1; ; page += 1) {
    const items = request(`${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`) || [];
    result.push(...items);
    if (items.length < 100) return result;
  }
}
function openAlert(request) {
  return all(`repos/${FORK}/issues?state=open`, request).find(issue => !issue.pull_request && issue.user?.type === "Bot"
    && issue.assignees?.some(user => user.login === REVIEWER) && issue.body?.includes(ALERT));
}
export function notifyNeedsReview({ pr, key, reason, url }, request = api) {
  const digest = createHash("sha256").update(`${key}\n${reason}`).digest("hex").slice(0, 20);
  const marker = `<!-- btr-review-reason:${digest} -->`;
  const detail = String(reason).slice(0, 1800).replace(/`/g, "'");
  const body = `${marker}\nUpstream update needs manual attention.\n\n\`\`\`text\n${detail}\n\`\`\`\n\n[Inspect the workflow run](${url}).`;
  if (pr && pr.user?.login !== REVIEWER) {
    const comments = all(`repos/${FORK}/issues/${pr.number}/comments`, request);
    const sent = comments.some(comment => comment.body?.includes(marker));
    const requested = pr.requested_reviewers?.some(user => user.login === REVIEWER);
    const reviewed = all(`repos/${FORK}/pulls/${pr.number}/reviews`, request).some(review => review.user?.login === REVIEWER && review.commit_id === pr.head.sha);
    if (!requested && !reviewed && !sent) request(`repos/${FORK}/pulls/${pr.number}/requested_reviewers`, "POST", { reviewers: [REVIEWER] });
    if (!sent) request(`repos/${FORK}/issues/${pr.number}/comments`, "POST", { body });
    return;
  }
  // A merge conflict can prevent a PR entirely; assignment provides the notification then.
  const issue = openAlert(request);
  if (!issue) {
    request(`repos/${FORK}/issues`, "POST", {
      title: "Upstream update needs review",
      body: `${ALERT}\n${body}${pr ? `\n\n[Update PR](${pr.html_url}).` : ""}`,
      assignees: [REVIEWER]
    });
    return;
  }
  if (issue.body?.includes(marker)) return;
  const comments = all(`repos/${FORK}/issues/${issue.number}/comments`, request);
  if (comments.some(comment => comment.body?.includes(marker))) return;
  request(`repos/${FORK}/issues/${issue.number}/comments`, "POST", { body });
}
export function closeReviewAlert(request = api) {
  const issue = openAlert(request);
  if (issue) request(`repos/${FORK}/issues/${issue.number}`, "PATCH", { state: "closed", state_reason: "completed" });
}
