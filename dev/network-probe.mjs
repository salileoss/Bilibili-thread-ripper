// From the machine this runs on: do Bilibili's APIs answer, and how fast do its video nodes
// serve the first megabyte of a real video? Prints hosts and numbers only, no signed addresses.
// With GITHUB_ENV set (in a workflow) it also hands BTR_TEST_BVID and BTR_TEST_CID to the steps
// after it, for dev/native-mse-end-test.js. Usage: `node dev/network-probe.mjs` (BTR_TEST_BVID).
import { appendFileSync, readFileSync } from "node:fs";
import vm from "node:vm";
import { readBounded } from "./probe-response.mjs";

const bvid = process.env.BTR_TEST_BVID || "BV1T1NZ6xEZZ";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
const referer = `https://www.bilibili.com/video/${bvid}/`;
const context = vm.createContext({ URL });
for (const file of ["range-core.js", "cdn-resolver.js"]) vm.runInContext(readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"), context);
const cdn = context.__BILI_CDN_RESOLVER_FACTORY__;
const repeats = Math.max(1, Math.min(10, Math.trunc(Number(process.env.BTR_PROBE_REPEATS)) || 1));

async function get(url, extraHeaders = {}) {
  const started = performance.now();
  try {
    const response = await fetch(url, { headers: { "User-Agent": UA, Referer: referer, ...extraHeaders }, signal: AbortSignal.timeout(20000) });
    const headersMs = performance.now() - started;
    const range = extraHeaders.Range ? context.__BILI_RANGE_CORE__.parseRangeHeader(extraHeaders.Range) : null;
    const result = await readBounded(response, range?.length || 4 * 1024 * 1024, range);
    return { status: response.status, headersMs: Math.round(headersMs), firstByteMs: result.firstByteAt === null ? null : Math.round(result.firstByteAt - started), ms: Math.round(performance.now() - started), body: result.body, headers: response.headers };
  } catch (error) {
    return { error: String(error?.cause?.code || error?.name || "Error"), ms: Math.round(performance.now() - started) };
  }
}
const json = (result) => { try { return JSON.parse(result.body.toString("utf8")); } catch (_error) { return null; } };
const line = (...parts) => console.log(parts.join("  "));

const ip = json(await get("https://ipinfo.io/json")) || {};
line("这台机器", [ip.city, ip.region, ip.country, ip.org].filter(Boolean).join(" / ") || "未知");

// The video-info API answers 412 to scripts without a logged-in session, even at home; the
// page list does not, and it carries the cid.
const pages = await get(`https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`);
const pagesData = json(pages);
line("分 P 列表接口", `HTTP ${pages.status ?? pages.error}`, `code=${pagesData?.code}`, `${pages.ms}ms`);
const cid = pagesData?.data?.[0]?.cid;
if (cid && process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `BTR_TEST_CID=${cid}\nBTR_TEST_BVID=${bvid}\n`);

if (cid) {
  const playurl = await get(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=4048&fnver=0&fourk=1&qn=80`);
  const playData = json(playurl);
  const dash = playData?.data?.dash;
  line("播放地址接口", `HTTP ${playurl.status ?? playurl.error}`, `code=${playData?.code}`, `${playurl.ms}ms`, `给到的清晰度=${playData?.data?.quality}`);
  if (dash) {
    const videos = dash.video || [];
    line("视频轨", videos.map((item) => `${item.id}:${String(item.codecs).split(".")[0]}`).join(" "));
    line("音频轨", (dash.audio || []).map((item) => `${item.id}:${item.codecs}`).join(" "));
    const sample = videos[0];
    const original = [sample.baseUrl || sample.base_url, ...(sample.backupUrl || sample.backup_url || [])];
    line("B 站给的节点", [...new Set(original.map((url) => new URL(url).hostname))].join(" "));
    // Bilibili's own addresses are tried as given (an akamaized.net address carries its own
    // signature); the other nodes get an ordinary address moved onto them, as BTR does.
    const targets = cdn.representationUrls(sample, "auto");
    const samples = new Map();
    for (let round = 0; round < repeats; round += 1) {
      const order = [...targets];
      if (repeats > 1) for (let i = order.length - 1; i > 0; i -= 1) {
        const other = Math.floor(Math.random() * (i + 1));
        [order[i], order[other]] = [order[other], order[i]];
      }
      for (const url of order) {
      const host = new URL(url).hostname;
      const result = await get(url, { Range: "bytes=0-1048575" });
      const mbps = result.body && result.ms ? (result.body.length * 8 / 1e6 / (result.ms / 1000)).toFixed(1) : "-";
      line(`  #${round + 1}`, host.padEnd(36), result.error ? `出错 ${result.error}` : `HTTP ${result.status}`, `响应头 ${result.headersMs ?? "-"}ms`, `首字节 ${result.firstByteMs ?? "-"}ms`, `1MiB 用时 ${result.ms}ms`, `${mbps} Mbps`);
      if (!samples.has(host)) samples.set(host, []);
      samples.get(host).push(result);
      }
    }
    for (const [host, results] of samples) {
      const good = results.filter(item => !item.error).sort((a, b) => a.ms - b.ms);
      line("Summary", host, `${good.length}/${results.length} valid`, good.length ? `median=${good[Math.floor(good.length / 2)].ms}ms max=${good.at(-1).ms}ms` : "no valid samples");
    }
  }
}

