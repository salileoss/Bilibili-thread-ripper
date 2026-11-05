"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
(async () => {
  const { closeReviewAlert, notifyNeedsReview, REVIEWER } = await import("../scripts/review-alerts.mjs");
  const args = () => ({ pr: { number: 3, user: { login: "github-actions[bot]" }, head: { sha: "a".repeat(40) }, requested_reviewers: [] }, key: "a".repeat(40), reason: "Protected files require review: scripts/build.mjs", url: "https://github.com/salileoss/Bilibili-thread-ripper/actions/runs/42" });
  function service(pr) {
    const calls = [], comments = [], issues = [], reviews = [];
    let failReview = false;
    const request = (endpoint, method = "GET", body) => {
      calls.push({ endpoint, method, body });
      const page = Number(new URL(`https://api.github.com/${endpoint}`).searchParams.get("page") || 1);
      if (method === "GET" && endpoint.includes("/comments?")) return comments.slice((page - 1) * 100, page * 100);
      if (method === "GET" && endpoint.includes("/reviews?")) return reviews;
      if (method === "GET" && endpoint.includes("/issues?state=open")) return issues.filter(issue => issue.state !== "closed");
      if (method === "POST" && endpoint.endsWith("/requested_reviewers")) {
        if (failReview) { failReview = false; throw new Error("Temporary review request failure"); }
        pr.requested_reviewers = body.reviewers.map(login => ({ login }));
      }
      if (method === "POST" && endpoint.endsWith("/comments")) comments.push(body);
      if (method === "POST" && endpoint.endsWith("/issues")) issues.push({ number: 7, state: "open", ...body, user: { type: "Bot", login: "github-actions[bot]" }, assignees: body.assignees.map(login => ({ login })) });
      if (method === "PATCH" && endpoint.endsWith("/issues/7")) Object.assign(issues[0], body);
      return null;
    };
    return { request, calls, comments, issues, reviews, failNextReview: () => { failReview = true; } };
  }
  test("manual PR review requests notify only the fork maintainer and do not repeat on reruns", () => {
    const input = args(), fake = service(input.pr);
    notifyNeedsReview(input, fake.request);
    notifyNeedsReview(input, fake.request);
    assert.deepEqual(fake.calls.find(call => call.endpoint.endsWith("/requested_reviewers")).body, { reviewers: [REVIEWER] });
    assert.equal(fake.calls.filter(call => call.endpoint.endsWith("/requested_reviewers")).length, 1);
    assert.equal(fake.comments.length, 1);
    assert.equal(fake.issues.length, 0);
    assert.ok(fake.comments[0].body.includes(input.url));
  });
  test("a maintainer review of this exact commit suppresses another review request", () => {
    const input = args(), fake = service(input.pr);
    fake.reviews.push({ user: { login: REVIEWER }, commit_id: input.pr.head.sha });
    notifyNeedsReview(input, fake.request);
    assert.ok(!fake.calls.some(call => call.endpoint.endsWith("/requested_reviewers")));
  });
  test("conflicts without a PR create one assigned issue and alert only for a new blocker", () => {
    const input = { ...args(), pr: null, reason: "Merge blocked: src/player.js" }, fake = service();
    notifyNeedsReview(input, fake.request);
    notifyNeedsReview(input, fake.request);
    assert.equal(fake.issues.length, 1);
    assert.deepEqual(fake.issues[0].assignees.map(user => user.login), [REVIEWER]);
    assert.equal(fake.comments.length, 0);
    const changed = { ...input, reason: "Merge blocked: src/settings.js" };
    notifyNeedsReview(changed, fake.request);
    notifyNeedsReview(changed, fake.request);
    assert.equal(fake.issues.length, 1);
    assert.equal(fake.comments.length, 1);
    closeReviewAlert(fake.request);
    assert.equal(fake.issues[0].state, "closed");
  });
  test("own-authored PRs fall back to an assigned alert instead of an invalid self-review request", () => {
    const input = args(); input.pr.user.login = REVIEWER;
    const fake = service(input.pr);
    notifyNeedsReview(input, fake.request);
    assert.equal(fake.issues.length, 1);
    assert.ok(!fake.calls.some(call => call.endpoint.endsWith("/requested_reviewers")));
  });
  test("resolution does not close a human issue quoting the alert marker", () => {
    const input = { ...args(), pr: null }, fake = service();
    notifyNeedsReview(input, fake.request);
    fake.issues[0].user = { type: "User", login: REVIEWER };
    closeReviewAlert(fake.request);
    assert.equal(fake.issues[0].state, "open");
  });
  test("failed review requests can retry without losing the notification behind a deduplication marker", () => {
    const input = args(), fake = service(input.pr);
    fake.failNextReview();
    assert.throws(() => notifyNeedsReview(input, fake.request), /Temporary/);
    assert.equal(fake.comments.length, 0);
    notifyNeedsReview(input, fake.request);
    assert.equal(fake.comments.length, 1);
    assert.equal(input.pr.requested_reviewers[0].login, REVIEWER);
  });
  test("deduplication checks beyond the first page of comments", () => {
    const input = args(), fake = service(input.pr);
    notifyNeedsReview(input, fake.request);
    const original = fake.comments.pop();
    fake.comments.push(...Array.from({ length: 100 }, () => ({ body: "Other discussion" })), original);
    notifyNeedsReview(input, fake.request);
    assert.equal(fake.comments.length, 101);
    assert.ok(fake.calls.some(call => call.endpoint.endsWith("page=2")));
  });
})().catch(error => { console.error(error); process.exitCode = 1; });
