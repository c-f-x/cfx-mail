#!/usr/bin/env node
// Reports the size of the built web app and the Worker bundle, raw and gzip.
// Build first:
//   npx -y pnpm@12.4.1 --filter @cfmail/web build
//   cd apps/worker && npx -y pnpm@12.4.1 exec wrangler deploy --dry-run \
//     --outdir=/tmp/cfx-mail-worker-dist --metafile=/tmp/cfx-mail-worker-meta.json
// Then, from the repo root:
//   node scripts/measure/bundle.mjs /tmp/cfx-mail-worker-dist /tmp/cfx-mail-worker-meta.json
// Gzip is level 9 (Cloudflare serves brotli or gzip; real transfer is a little smaller).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const [workerDist, workerMeta] = process.argv.slice(2);
const kib = (n) => `${(n / 1024).toFixed(1)} KiB`;
const gz = (buf) => gzipSync(buf, { level: 9 }).length;

const webDist = "apps/web/dist";
const assets = readdirSync(join(webDist, "assets")).map((name) => {
  const buf = readFileSync(join(webDist, "assets", name));
  return { name, raw: buf.length, gzip: gz(buf) };
});
const sum = (list, key) => list.reduce((n, a) => n + a[key], 0);
const js = assets.filter((a) => a.name.endsWith(".js"));
const css = assets.filter((a) => a.name.endsWith(".css"));
const maps = assets.filter((a) => a.name.endsWith(".map"));

console.log("## Web app (apps/web/dist)\n");
console.log("| Kind | Files | Raw | Gzip |\n|---|---:|---:|---:|");
console.log(`| JavaScript | ${js.length} | ${kib(sum(js, "raw"))} | ${kib(sum(js, "gzip"))} |`);
console.log(`| CSS | ${css.length} | ${kib(sum(css, "raw"))} | ${kib(sum(css, "gzip"))} |`);
console.log(
  `| Source maps (published with the assets) | ${maps.length} | ${kib(sum(maps, "raw"))} | ${kib(sum(maps, "gzip"))} |`,
);

// The first load fetches index.html, its entry script, every modulepreload and
// the stylesheet. Route chunks load afterwards.
const html = readFileSync(join(webDist, "index.html"), "utf8");
const firstLoad = new Set([...html.matchAll(/(?:src|href)="\/assets\/([^"]+)"/g)].map((m) => m[1]));
const first = assets.filter((a) => firstLoad.has(a.name));
console.log(
  `\nFirst load, before any route chunk: ${first.length} files, ${kib(sum(first, "raw"))} raw, ${kib(sum(first, "gzip"))} gzip (index.html excluded).`,
);

console.log("\n| Largest JS chunks | Raw | Gzip | In first load |\n|---|---:|---:|---|");
for (const a of js.toSorted((x, y) => y.raw - x.raw).slice(0, 12)) {
  console.log(
    `| ${a.name} | ${kib(a.raw)} | ${kib(a.gzip)} | ${firstLoad.has(a.name) ? "yes" : "no"} |`,
  );
}

if (workerDist) {
  const file = join(workerDist, "index.js");
  const buf = readFileSync(file);
  console.log("\n## Worker (wrangler dry run)\n");
  console.log(`index.js: ${kib(statSync(file).size)} raw, ${kib(gz(buf))} gzip.`);
}

if (workerMeta) {
  const meta = JSON.parse(readFileSync(workerMeta, "utf8"));
  const out = Object.values(meta.outputs).find((o) => o.entryPoint);
  const byPackage = new Map();
  let total = 0;
  for (const [path, input] of Object.entries(out.inputs)) {
    const pkg = path.match(/node_modules\/\.pnpm\/[^/]+\/node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1];
    const zodLocale = /zod\/v4\/locales\//.test(path);
    const key = zodLocale
      ? "zod (locales only)"
      : (pkg ?? (path.startsWith("src/") ? "our worker code" : "our packages"));
    byPackage.set(key, (byPackage.get(key) ?? 0) + input.bytesInOutput);
    total += input.bytesInOutput;
  }
  console.log("\n| Worker bundle by package (minified bytes) | Size | Share |\n|---|---:|---:|");
  for (const [k, v] of [...byPackage].toSorted((a, b) => b[1] - a[1]).slice(0, 14)) {
    console.log(`| ${k} | ${kib(v)} | ${((100 * v) / total).toFixed(1)}% |`);
  }
}
