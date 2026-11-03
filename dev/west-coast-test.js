"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
function load() {
  const context = vm.createContext({ URL, AbortController, DOMException, Response, ReadableStream, Headers,
    Uint8Array, Promise, setTimeout, clearTimeout, performance, console });
  context.globalThis = context;
  context.__now = 1e12;
  vm.runInContext("Date.now = () => globalThis.__now", context);
  for (const file of ["range-core.js", "cdn-resolver.js", "idm-downloader.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../src", file), "utf8"), context);
  }
  return { cdn: context.__BILI_CDN_RESOLVER_FACTORY__, idm: context.__BILI_IDM_DOWNLOADER_FACTORY__,
    core: context.__BILI_RANGE_CORE__, advance: ms => { context.__now += ms; } };
}
const url = (host, file = "video") => `https://${host}/upgcxcode/${file}.m4s?deadline=2000000000&sign=private`;
const ORIGINAL = "upos-hz-mirrorakam.akamaized.net", OVERSEAS = "upos-sz-mirroraliov.bilivideo.com";
const MAINLAND = "upos-sz-mirrorhw.bilivideo.com";

test("Auto keeps exact original addresses eligible for metadata, media and rescue", () => {
  const { cdn, core } = load();
  assert.equal(core.normalizeSettings({ mode: "auto" }).mode, "auto");
  const representation = { baseUrl: url(ORIGINAL) };
  const resolver = cdn.createResolver(representation, () => "auto");
  for (const candidates of [resolver.startupCandidates(), resolver.rangeCandidates(), resolver.rescueCandidates()]) {
    assert.ok(candidates.includes(representation.baseUrl));
  }
  assert.ok(resolver.urls().includes(url(OVERSEAS)));
  assert.ok(resolver.urls().includes(url(MAINLAND)));
  assert.ok(resolver.rangeCandidates().length <= 4, "bounded exploration");
  const custom = cdn.createResolver(representation, () => "custom", null, () => [MAINLAND]);
  assert.ok(custom.urls().every(value => new URL(value).hostname === MAINLAND));
  assert.ok(custom.startupCandidates().every(value => new URL(value).hostname === MAINLAND));
});

test("metadata latency ranks the first media candidate without pretending to measure bandwidth", () => {
  const { cdn } = load();
  const resolver = cdn.createResolver({ baseUrl: url(ORIGINAL) }, () => "auto");
  resolver.success(url(ORIGINAL), 0, { firstByteMs: 60 });
  assert.equal(resolver.speed(url(ORIGINAL)), 0);
  assert.equal(resolver.rangeCandidates()[0], url(ORIGINAL));
});

test("Auto shares conservative host priors across files, not validity or permanent health", () => {
  const { cdn, advance } = load();
  const first = cdn.createResolver({ baseUrl: url(ORIGINAL) }, () => "auto");
  first.success(url(OVERSEAS), 2e6, { firstByteMs: 80, bodyBps: 3e6 });
  const next = cdn.createResolver({ baseUrl: url(ORIGINAL, "next") }, () => "auto");
  assert.ok(next.speed(url(OVERSEAS, "next")) > 0);
  assert.ok(next.speed(url(OVERSEAS, "next")) < first.speed(url(OVERSEAS)));
  assert.equal(next.status().find(item => item.host === OVERSEAS).state, "untested");
  assert.equal(next.rangeCandidates()[0], url(OVERSEAS, "next"));
  advance(90001);
  assert.equal(next.speed(url(OVERSEAS, "next")), 0);
});

test("Auto ranks latency for small requests and transfer rate for large ones", () => {
  const { cdn } = load();
  const resolver = cdn.createResolver({ baseUrl: url(ORIGINAL) }, () => "auto");
  resolver.success(url(ORIGINAL), 1e6, { firstByteMs: 20, bodyBps: 1e6 });
  resolver.success(url(OVERSEAS), 4e6, { firstByteMs: 400, bodyBps: 5e6 });
  assert.equal(resolver.startupCandidates()[0], url(ORIGINAL));
  assert.equal(resolver.rangeCandidates(4 * 1024 * 1024)[0], url(OVERSEAS));
});

test("neutral concurrency trials roll back and healthy playback can test fewer requests", () => {
  const { idm } = load();
  let at = 100000;
  const auto = idm.createAutoConcurrency({ now: () => at });
  const flow = (bps, ms, ahead) => {
    auto.demand(auto.threads(), auto.threads(), 3);
    for (let i = 0; i < ms; i += 250) {
      at += 250; auto.activity(); auto.delivered(bps / 4);
      if (ahead !== undefined) auto.buffer(ahead, true);
    }
  };
  flow(1e6, 5000); auto.stall(); flow(1.05e6, 11000);
  assert.equal(auto.threads(), 8, "5% improvement is below the useful gain threshold");
  at += 95000; auto.stall(); flow(2e6, 11000);
  assert.equal(auto.threads(), 12);
  flow(2e6, 31000, 25);
  assert.equal(auto.threads(), 8, "comfortable buffer permits a downward trial");
  assert.equal(auto.stall(), true);
  assert.equal(auto.threads(), 12, "pressure promptly restores the prior budget");
});

test("diagnostics count delivered bytes once and distinguish first body byte from headers", async () => {
  const { idm, cdn } = load();
  const representation = { baseUrl: url(ORIGINAL) };
  const downloader = idm.createDownloader({ getSettings: () => ({ mode: "auto", concurrency: 4 }),
    nativeFetch: async (_url, init) => {
      const [, a, b] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
      const start = Number(a), end = Number(b);
      return new Response(new Uint8Array(end - start + 1), { status: 206,
        headers: { "Content-Range": `bytes ${start}-${end}/1048576` } });
    } });
  await downloader.downloadRange({ start: 0, end: 65535, length: 65536 }, cdn.createResolver(representation, () => "auto"), { kind: "video" });
  const stats = downloader.getDiagnostics();
  assert.equal(stats.deliveredBytes, 65536);
  assert.equal(stats.networkBytes, 65536);
  assert.equal(stats.completedRanges, 1);
  assert.ok(stats.firstBodyByteMs >= 0);
  assert.ok(stats.usefulBps > 0);
  assert.ok(!JSON.stringify(stats).includes("private"));
});

test("network probe rejects ignored ranges, truncated bytes and oversized responses", async () => {
  const { readBounded } = await import("./probe-response.mjs");
  const range = { start: 10, end: 13 };
  const response = (bytes, status = 206, contentRange = "bytes 10-13/100") => new Response(new Uint8Array(bytes), { status, headers: { "Content-Range": contentRange } });
  assert.equal((await readBounded(response(4), 4, range)).body.length, 4);
  await assert.rejects(readBounded(response(4, 200), 4, range), /Content-Range/);
  await assert.rejects(readBounded(response(4, 206, "bytes 0-3/100"), 4, range), /Content-Range/);
  await assert.rejects(readBounded(response(3), 4, range), /truncated/);
  await assert.rejects(readBounded(response(5), 4, range), /limit/);
});

test("published fork bundles exactly match their source and own their update URLs", async () => {
  const { pathToFileURL } = require("node:url");
  const root = path.resolve(__dirname, "..");
  const build = await import(pathToFileURL(path.join(root, "scripts/build.mjs")).href);
  for (const [file, channel] of [["user_scripts/bilibili-thread-ripper.user.js", "stable"], ["canary/bilibili-thread-ripper-canary.user.js", "canary"]]) {
    const text = fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");
    const version = /^\/\/ @version\s+(\S+)/m.exec(text)[1];
    assert.equal(text, build.buildUserscript(version, { channel }));
    assert.match(text.slice(0, text.indexOf("// ==/UserScript==")), /@updateURL\s+https:\/\/raw\.githubusercontent\.com\/salileoss\//);
  }
});
