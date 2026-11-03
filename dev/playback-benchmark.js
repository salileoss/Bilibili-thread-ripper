"use strict";
// Serial, anonymous real-media browser benchmark. Not a test of logged-in 4K or Bilibili's UI.
// node dev/playback-benchmark.js [mainland,overseas,auto]
// BTR_BENCH_SECONDS=30 BTR_BENCH_REPEATS=3 BTR_BENCH_RATE=2 BTR_BENCH_PROGRESSIVE=1
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs"), path = require("node:path");
const root = path.resolve(__dirname, "..");
const modes = (process.argv[2] || "mainland,overseas,auto").split(",");
if (modes.some(mode => !["mainland", "overseas", "auto"].includes(mode))) throw new Error("invalid benchmark mode");
const bvid = process.env.BTR_TEST_BVID || "BV1T1NZ6xEZZ";
const seconds = Math.max(5, Math.min(300, Number(process.env.BTR_BENCH_SECONDS) || 30));
const repeats = Math.max(1, Math.min(10, Number(process.env.BTR_BENCH_REPEATS) || 1));
const rate = Math.max(0.25, Math.min(4, Number(process.env.BTR_BENCH_RATE) || 1));
const codec = ["avc", "hevc", "av1"].includes(process.env.BTR_BENCH_CODEC) ? process.env.BTR_BENCH_CODEC : "avc";
const files = ["range-core.js", "cdn-resolver.js", "sidx.js", "idm-downloader.js", "native-mse-player.js"];
const result = [];
(async () => {
  const pages = await fetch(`https://api.bilibili.com/x/player/pagelist?bvid=${encodeURIComponent(bvid)}`, { signal: AbortSignal.timeout(15000) }).then(response => response.json());
  const cid = pages.data?.[0]?.cid;
  if (!cid) throw new Error("public video unavailable");
  let server = null, browser = null;
  try {
    let up = false;
    try { up = (await fetch("http://127.0.0.1:18763/config").then(response => response.json())).bvid === bvid; } catch (_error) {}
    if (!up) {
      server = spawn(process.execPath, [path.join(__dirname, "server.js")], { cwd: root, stdio: "ignore",
        env: { ...process.env, BTR_TEST_BVID: bvid, BTR_TEST_CID: String(cid) }, windowsHide: true });
      for (let i = 0; i < 50; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
        try { up = (await fetch("http://127.0.0.1:18763/config").then(response => response.json())).bvid === bvid; } catch (_error) {}
        if (up) break;
      }
      if (!up) throw new Error("benchmark server unavailable, or port 18763 serves another video");
    }
    browser = await chromium.launch({ executablePath: process.env.BTR_CHROME_PATH || undefined, headless: true,
      args: ["--autoplay-policy=no-user-gesture-required"] });
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      // Rotate trial order to reduce systematic warm-cache bias; not a cache-cold guarantee.
      const order = modes.slice(repeat % modes.length).concat(modes.slice(0, repeat % modes.length));
      for (const mode of order) {
        const context = await browser.newContext();
        try {
          const page = await context.newPage();
          await page.route("**/benchmark", route => route.fulfill({ contentType: "text/html", body: '<div class="bpx-player-container"><video muted></video></div>' }));
          await page.goto("http://127.0.0.1:18763/benchmark");
          for (const file of files) await page.addScriptTag({ path: path.join(root, "src", file) });
          await page.evaluate(async ({ mode, rate, codec, progressive }) => {
            const playinfo = await fetch("/playinfo").then(response => response.json());
            if (!playinfo.data?.dash) throw new Error("DASH manifest unavailable");
            window.benchErrors = [];
            const video = document.querySelector("video");
            video.playbackRate = rate;
            window.benchPlayer = window.__BILI_NATIVE_MSE_PLAYER_FACTORY__.createNativePlayer({
              container: document.querySelector(".bpx-player-container"), playinfo, initialTime: 0, initialResume: true,
              preferredCodec: codec, getSettings: () => ({ enabled: true, mode, autoConcurrency: true, bufferAheadSeconds: 45, progressiveMedia: progressive }),
              nativeFetch: (url, init) => fetch(`/media?url=${encodeURIComponent(url)}`, init),
              onFatal: error => window.benchErrors.push(error.name || "Error")
            });
          }, { mode, rate, codec, progressive: process.env.BTR_BENCH_PROGRESSIVE === "1" });
          let failure = null;
          try {
            await page.waitForFunction(() => benchPlayer.getDebug().playbackActivated || benchErrors.length, null, { timeout: 60000 });
            await page.waitForTimeout(seconds * 1000);
            await page.evaluate(() => { const video = document.querySelector("video"); video.currentTime = Math.min(video.duration - 10, video.duration * 0.6); });
            await page.waitForTimeout(10000);
          } catch (error) { failure = error.name || "Error"; }
          const sample = await page.evaluate(() => {
            const debug = benchPlayer.getDebug(), video = document.querySelector("video");
            return { performance: debug.performance, transfer: debug.transfer, quality: debug.qualityId, codec: debug.codec,
              actualRate: video.playbackRate, playableWallSeconds: debug.playableWallSeconds, demandBps: debug.playbackDemandBps,
              frames: video.getVideoPlaybackQuality ? { total: video.getVideoPlaybackQuality().totalVideoFrames, dropped: video.getVideoPlaybackQuality().droppedVideoFrames } : null,
              errors: benchErrors };
          });
          const row = { repeat: repeat + 1, mode, bvid, seconds, rate, failure, ...sample };
          result.push(row);
          console.log(JSON.stringify(row));
        } finally { await context.close(); }
      }
    }
  } finally {
    await browser?.close();
    server?.kill();
    fs.mkdirSync(path.join(root, "dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "dist/west-coast-playback.json"), JSON.stringify(result, null, 2) + "\n");
  }
  if (result.some(row => row.failure || row.errors.length)) process.exitCode = 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
