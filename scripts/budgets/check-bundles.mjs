#!/usr/bin/env node
// Bundle size budgets. Fails when a built bundle is bigger than its limit.
//
// Build first, then run from the repo root:
//   npx -y pnpm@12.4.1 build
//   npx -y pnpm@12.4.1 run check:bundles
//
// It reads two build outputs and counts bytes, so the result is the same on a
// busy machine as on a quiet one:
//   apps/worker/dist/index.js   the Worker bundle from the wrangler dry run
//   apps/web/dist               every .js and .css file, source maps excluded,
//                               and .assetsignore: no .map file may be uploaded
// Gzip is level 9, as in scripts/measure/bundle.mjs. Cloudflare serves brotli or
// gzip, so real transfer is a little smaller.
//
// Exit codes: 0 within budget, 1 over budget, 2 a build output is missing.
//
// Each limit is a measured size plus a margin of about 10 to 15 percent,
// rounded up to three significant figures. The measured value sits next to the
// limit so a reviewer sees the headroom. The Worker limits were measured on
// master at 1e89edd; the web limits on the new layout (D-10, branch fp-web at
// 7ebffc0), both on 2026-10-09.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const THIS_FILE = "scripts/budgets/check-bundles.mjs";

// name, limit in bytes, and what it measures. Keys match measure() below.
export const LIMITS = [
  {
    key: "workerRaw",
    label: "Worker bundle, raw",
    limit: 2_500_000, // measured 2,208,568 on 2026-10-09 (+13%)
  },
  {
    key: "workerGzip",
    label: "Worker bundle, gzip",
    limit: 700_000, // measured 625,817 on 2026-10-09 (+12%)
  },
  {
    key: "webJsRaw",
    label: "Web JavaScript, raw (all files)",
    limit: 1_770_000, // measured 1,588,092 on the layout (+11%)
  },
  {
    key: "webJsGzip",
    label: "Web JavaScript, gzip (each file on its own, summed)",
    limit: 595_000, // measured 530,473 on the layout (+12%)
  },
  {
    key: "webCssRaw",
    label: "Web CSS, raw (all files)",
    limit: 91_600, // measured 81,050 on the layout (+13%)
  },
  {
    key: "webCssGzip",
    label: "Web CSS, gzip (each file on its own, summed)",
    limit: 16_800, // measured 14,723 on the layout (+14%)
  },
  {
    key: "webLargestJsRaw",
    label: "Web, largest single JavaScript file, raw",
    limit: 381_000, // measured 336,523 on the layout (+13%)
  },
];

const gzipLength = (buffer) => gzipSync(buffer, { level: 9 }).length;
const sum = (list, key) => list.reduce((total, f) => total + f[key], 0);

// Every file under `dir`, as paths relative to it, in a stable order.
export function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .toSorted();
}

// The source maps among `names` that Wrangler would upload with the assets.
// `assetsIgnore` is the text of the web build's .assetsignore (gitignore
// syntax), or null. Only a plain `*.map` or `**/*.map` line counts as keeping
// the maps back, and any `!` line that names a map undoes it; anything subtler
// is reported as published, so the check errs on the side of failing.
export function publishedSourceMaps(names, assetsIgnore) {
  const maps = names.filter((n) => n.endsWith(".map"));
  const lines = (assetsIgnore ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const kept = lines.some((l) => l === "*.map" || l === "**/*.map");
  const undone = lines.some((l) => l.startsWith("!") && l.endsWith(".map"));
  return kept && !undone ? [] : maps;
}

// Sizes of one build output. `files` is a list of { name, bytes: Buffer }.
// Pure: the caller does the reading.
export function measure({ workerIndex, webFiles, assetsIgnore = null }) {
  const sized = webFiles
    .filter((f) => !f.name.endsWith(".map"))
    .map((f) => ({ name: f.name, raw: f.bytes.length, gzip: gzipLength(f.bytes) }));
  const js = sized.filter((f) => f.name.endsWith(".js"));
  const css = sized.filter((f) => f.name.endsWith(".css"));
  const largest = js.toSorted((a, b) => b.raw - a.raw)[0];
  return {
    workerRaw: workerIndex.length,
    workerGzip: gzipLength(workerIndex),
    webJsRaw: sum(js, "raw"),
    webJsGzip: sum(js, "gzip"),
    webCssRaw: sum(css, "raw"),
    webCssGzip: sum(css, "gzip"),
    webLargestJsRaw: largest?.raw ?? 0,
    webLargestJsName: largest?.name ?? "(none)",
    publishedMaps: publishedSourceMaps(
      webFiles.map((f) => f.name),
      assetsIgnore,
    ),
  };
}

// One row per budget: what was measured, what is allowed, and whether it fits.
export function evaluate(measured, limits = LIMITS) {
  return limits.map(({ key, label, limit }) => ({
    key,
    label,
    limit,
    value: measured[key],
    ok: measured[key] <= limit,
  }));
}

const fmt = (n) => n.toLocaleString("en-US");

const MAPS_LABEL = "Source maps published with the assets";

export function report(rows, measured) {
  const lines = ["Bundle budgets (bytes)", ""];
  const width = Math.max(MAPS_LABEL.length, ...rows.map((r) => r.label.length));
  for (const r of rows) {
    const share = `${((100 * r.value) / r.limit).toFixed(0)}% of limit`;
    lines.push(
      `${r.ok ? "ok  " : "FAIL"}  ${r.label.padEnd(width)}  ${fmt(r.value).padStart(10)} / ${fmt(r.limit).padStart(10)}  ${share}`,
    );
  }
  // Not a size: no source map may be uploaded, because it publishes the web source.
  const maps = measured.publishedMaps ?? [];
  lines.push(
    `${maps.length === 0 ? "ok  " : "FAIL"}  ${MAPS_LABEL.padEnd(width)}  ${String(maps.length).padStart(10)} / ${"0".padStart(10)}  files`,
  );
  lines.push("", `Largest web JavaScript file: ${measured.webLargestJsName}`);
  if (maps.length > 0) {
    lines.push("");
    for (const name of maps) lines.push(`PUBLISHED: ${name} would be uploaded.`);
    lines.push("Keep source maps back with a `*.map` line in apps/web/public/.assetsignore.");
  }
  const failed = rows.filter((r) => !r.ok);
  if (failed.length > 0) {
    lines.push("");
    for (const r of failed) {
      lines.push(`OVER BUDGET: ${r.label} is ${fmt(r.value)} bytes, the limit is ${fmt(r.limit)}.`);
    }
    lines.push(
      `If this growth is intended, raise the limit in ${THIS_FILE} and say why in the commit.`,
      "If it is not, find what grew: node scripts/measure/bundle.mjs apps/worker/dist",
    );
  }
  return lines.join("\n");
}

// The edge: read the build outputs. Returns { missing } when one is absent.
export function readBuild({ workerDir, webDir }) {
  const workerIndexPath = path.join(workerDir, "index.js");
  const missing = [workerIndexPath, webDir].filter((p) => !existsSync(p));
  if (missing.length > 0) return { missing };
  const webFiles = listFiles(webDir)
    .filter((name) => /\.(js|css|map)$/.test(name))
    .map((name) => ({ name, bytes: readFileSync(path.join(webDir, name)) }));
  const ignorePath = path.join(webDir, ".assetsignore");
  const assetsIgnore = existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : null;
  return { workerIndex: readFileSync(workerIndexPath), webFiles, assetsIgnore };
}

export function run({ workerDir, webDir, limits = LIMITS }) {
  const build = readBuild({ workerDir, webDir });
  if (build.missing) {
    return {
      code: 2,
      output: `Build output not found: ${build.missing.join(", ")}\nRun the build first: npx -y pnpm@12.4.1 build`,
    };
  }
  const measured = measure(build);
  const rows = evaluate(measured, limits);
  const ok = rows.every((r) => r.ok) && measured.publishedMaps.length === 0;
  return { code: ok ? 0 : 1, output: report(rows, measured) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [
    workerDir = path.join(ROOT, "apps/worker/dist"),
    webDir = path.join(ROOT, "apps/web/dist"),
  ] = process.argv.slice(2);
  const { code, output } = run({ workerDir, webDir });
  (code === 0 ? console.log : console.error)(output);
  process.exitCode = code;
}
