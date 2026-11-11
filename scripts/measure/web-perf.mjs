#!/usr/bin/env node
// Loads the built web app from a LOCAL worker in headless Chromium and reports
// cold first-load cost and the cost of scrolling the "All" inbox.
//
// Needs Playwright, which is not a repo dependency. Install it outside the repo:
//   mkdir -p /tmp/pw && npm i --prefix /tmp/pw playwright-core
//   node scripts/measure/web-perf.mjs --playwright /tmp/pw/node_modules/playwright-core \
//     [--chromium <path to a Chromium binary>] [--seed /tmp/cfx-mail-seed.json] [--runs 5] [--threads 1000]
//
// Build the web app first (npx -y pnpm@12.4.1 --filter @cfmail/web build); the
// worker serves apps/web/dist. Each run uses a fresh browser context, so the
// HTTP cache is empty. Desktop viewport 1440x900, no CPU or network throttling.
// Only GET requests and one sign-in are made; nothing is sent.
/* eslint-disable no-await-in-loop -- runs are measured one after another */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    seed: { type: "string", default: "/tmp/cfx-mail-seed.json" },
    runs: { type: "string", default: "5" },
    threads: { type: "string", default: "1000" },
    playwright: { type: "string", default: "playwright-core" },
    chromium: { type: "string" },
  },
});
const require = createRequire(import.meta.url);
const { chromium } = require(args.playwright);
const seed = JSON.parse(readFileSync(args.seed, "utf8"));
const BASE = new URL(seed.base);
if (!["localhost", "127.0.0.1"].includes(BASE.hostname)) throw new Error("local workers only");

// Collected in the page from the first byte: long tasks and the moment the
// first thread row is in the DOM.
const INIT = () => {
  window.cfxMailPerf = { longTasks: [], firstRowAt: null };
  new PerformanceObserver((list) => {
    for (const e of list.getEntries())
      window.cfxMailPerf.longTasks.push({ start: e.startTime, duration: e.duration });
  }).observe({ type: "longtask", buffered: true });
  const mo = new MutationObserver(() => {
    if (!window.cfxMailPerf.firstRowAt && document.querySelector("[data-index]")) {
      window.cfxMailPerf.firstRowAt = performance.now();
      mo.disconnect();
    }
  });
  document.addEventListener("DOMContentLoaded", () =>
    mo.observe(document.body, { childList: true, subtree: true }),
  );
};

const median = (xs) => {
  const s = xs.toSorted((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const kib = (n) => `${(n / 1024).toFixed(1)} KiB`;

// --expose-gc lets the scroll test collect garbage before it reads the heap.
// Without --enable-precise-memory-info, Chromium rounds performance.memory and
// refreshes it only now and then, so heap readings would be stale.
const browser = await chromium.launch({
  executablePath: args.chromium,
  args: ["--js-flags=--expose-gc", "--enable-precise-memory-info"],
});

async function signedInContext() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const res = await context.request.post(new URL("/api/auth/sign-in/email", BASE).href, {
    headers: { origin: BASE.origin },
    data: { email: seed.admin.email, password: seed.admin.password },
  });
  if (!res.ok()) throw new Error(`sign in: HTTP ${res.status()}`);
  await context.addInitScript(INIT);
  return context;
}

const loads = [];
for (let i = 0; i < Number(args.runs); i++) {
  const context = await signedInContext();
  const page = await context.newPage();
  await page.goto(new URL("/app/m/all", BASE).href, { waitUntil: "networkidle" });
  await page.waitForSelector("[data-index]");
  const m = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const res = performance.getEntriesByType("resource");
    const by = (pred) => res.filter(pred).reduce((n, r) => n + r.encodedBodySize, 0);
    const lt = window.cfxMailPerf.longTasks;
    return {
      ttfb: nav.responseStart,
      dcl: nav.domContentLoadedEventEnd,
      load: nav.loadEventEnd,
      firstRow: window.cfxMailPerf.firstRowAt,
      requests: res.length + 1,
      apiRequests: res.filter((r) => r.name.includes("/api/")).length,
      jsBytes: by((r) => r.name.endsWith(".js")),
      cssBytes: by((r) => r.name.endsWith(".css")),
      apiBytes: by((r) => r.name.includes("/api/")),
      totalBytes: nav.encodedBodySize + by(() => true),
      transferBytes: nav.transferSize + res.reduce((n, r) => n + r.transferSize, 0),
      longTaskCount: lt.length,
      longTaskTotal: lt.reduce((n, t) => n + t.duration, 0),
      blocking: lt.reduce((n, t) => n + Math.max(0, t.duration - 50), 0),
      lastLongTaskEnd: lt.reduce((n, t) => Math.max(n, t.start + t.duration), 0),
    };
  });
  loads.push(m);
  await context.close();
}

console.log(`## Cold first load of /app/m/all (${loads.length} runs, fresh cache each)\n`);
console.log("| Measure | Median | Worst |\n|---|---:|---:|");
const row = (name, key, fmt = (v) => `${v.toFixed(0)} ms`) => {
  const xs = loads.map((l) => l[key] ?? Number.NaN);
  console.log(`| ${name} | ${fmt(median(xs))} | ${fmt(Math.max(...xs))} |`);
};
row("Time to first byte", "ttfb");
row("DOMContentLoaded", "dcl");
row("Load event", "load");
row("First thread row in the DOM", "firstRow");
row("End of last long task (main thread quiet after this)", "lastLongTaskEnd");
row("Long tasks (> 50 ms), count", "longTaskCount", (v) => v.toFixed(0));
row("Long tasks, total time", "longTaskTotal");
row("Blocking time (sum of time over 50 ms)", "blocking");
row("Requests (document + resources)", "requests", (v) => v.toFixed(0));
row("API requests", "apiRequests", (v) => v.toFixed(0));
row("JavaScript downloaded (body bytes)", "jsBytes", kib);
row("CSS downloaded (body bytes)", "cssBytes", kib);
row("API responses (body bytes)", "apiBytes", kib);
row("All bodies", "totalBytes", kib);
row("Transferred, as the browser reports it", "transferBytes", kib);

// Scroll the All inbox until `--threads` rows have loaded, page by page, and
// count long tasks while doing it.
const scrolls = [];
for (let i = 0; i < Math.min(3, Number(args.runs)); i++) {
  const context = await signedInContext();
  const page = await context.newPage();
  await page.goto(new URL("/app/m/all", BASE).href, { waitUntil: "networkidle" });
  await page.waitForSelector("[data-index]");
  const heapStartMb = await page.evaluate(() => {
    window.gc?.();
    window.cfxMailPerf.longTasks = [];
    return performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null;
  });
  const target = Number(args.threads);
  const t0 = Date.now();
  let maxIndex = 0;
  let stalls = 0;
  while (maxIndex < target - 1 && stalls < 40) {
    const before = maxIndex;
    maxIndex = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("[data-index]")];
      const scroller = rows[0]?.closest(".overflow-y-auto");
      if (scroller) scroller.scrollTop += scroller.clientHeight;
      return Math.max(...rows.map((r) => Number(r.getAttribute("data-index"))));
    });
    await page.waitForTimeout(50);
    stalls = maxIndex === before ? stalls + 1 : 0;
  }
  await page.waitForLoadState("networkidle");
  const r = await page.evaluate(() => {
    const lt = window.cfxMailPerf.longTasks;
    return {
      rowsInDom: document.querySelectorAll("[data-index]").length,
      longTaskCount: lt.length,
      longTaskTotal: lt.reduce((n, t) => n + t.duration, 0),
      longestTask: lt.reduce((n, t) => Math.max(n, t.duration), 0),
      heapMb: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null,
    };
  });
  const heapRetainedMb = await page.evaluate(() => {
    window.gc?.();
    return performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null;
  });
  scrolls.push({ ...r, heapStartMb, heapRetainedMb, reached: maxIndex + 1, ms: Date.now() - t0 });
  await context.close();
}
console.log(`\n## Scrolling the All inbox to ${args.threads} threads (${scrolls.length} runs)\n`);
console.log(
  "| Run | Threads reached | Rows in DOM at end | Long tasks | Long-task time | Longest task | JS heap | Heap after GC, start | Heap after GC, end | Wall time |",
);
console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
for (const [i, s] of scrolls.entries()) {
  console.log(
    `| ${i + 1} | ${s.reached} | ${s.rowsInDom} | ${s.longTaskCount} | ${s.longTaskTotal.toFixed(0)} ms | ${s.longestTask.toFixed(0)} ms | ${s.heapMb?.toFixed(1) ?? "n/a"} MB | ${s.heapStartMb?.toFixed(1) ?? "n/a"} MB | ${s.heapRetainedMb?.toFixed(1) ?? "n/a"} MB | ${s.ms} ms |`,
  );
}
await browser.close();
