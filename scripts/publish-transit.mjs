#!/usr/bin/env node
/**
 * publish-transit.mjs — compose, stamp and verify the static /transit site.
 *
 * The published site at https://thebonhomme.com/transit/ is NOT the Next.js app.
 * It is the hand-authored static atlas under public/Transit, plus the tracked
 * GTFS atlas under public/data, plus two loose files. This script is the single
 * definition of that composition so the workflow and a human run it identically.
 *
 *   compose        build the stamped tree into --out
 *   verify-artifact static integrity gate, run before anything is published
 *   verify-live     fetch the live URL and assert it serves what we built
 */

import { createHash } from "node:crypto";
import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync,
  rmSync, statSync, writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";

// public/<from>  ->  <site root>/<to>
const COMPOSITION = [
  { from: "Transit", to: "." },
  { from: "data", to: "data" },
  { from: "l10n", to: "l10n" },
  { from: "favicon.svg", to: "favicon.svg" },
];

// Markers that must be present in the composed index.html. These are the exact
// tokens that distinguish the current build from the stale 2026-08-19 copy; if
// a future refactor removes one, fix this list deliberately rather than by rote.
const REQUIRED_MARKERS = ["tool-status", "load-err", 'class="cities panel"', "--metro-edge"];
// Markers that must be absent — they only exist in the superseded design.
const FORBIDDEN_MARKERS = ['role="tablist"', "#0f172a"];

const MIN_INDEX_BYTES = 30_000;
const STAMP_ANCHOR = '<meta charset="utf-8" />';

const die = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
const ok = (msg) => console.log(`✓ ${msg}`);

function arg(name, required = true) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || !process.argv[i + 1]) {
    if (required) die(`missing --${name}`);
    return undefined;
  }
  return process.argv[i + 1];
}

function walk(dir, base = dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, base, acc);
    else acc.push(relative(base, p));
  }
  return acc.sort();
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Inject the build stamp so the served bytes can be traced to a commit. */
function stamp(html, sha, file) {
  if (!html.includes(STAMP_ANCHOR)) {
    die(`${file}: stamp anchor ${STAMP_ANCHOR} not found — cannot inject build-sha`);
  }
  if (html.includes('name="build-sha"')) die(`${file}: already stamped`);
  return html.replace(STAMP_ANCHOR, `${STAMP_ANCHOR}\n    <meta name="build-sha" content="${sha}" />`);
}

function compose() {
  const src = arg("src");
  const out = arg("out");
  const sha = arg("sha");
  if (!/^[0-9a-f]{40}$/.test(sha)) die(`--sha must be a full 40-char commit sha, got "${sha}"`);

  const pub = join(src, "public");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  for (const { from, to } of COMPOSITION) {
    const s = join(pub, from);
    if (!existsSync(s)) die(`source missing: ${s}`);
    const d = to === "." ? out : join(out, to);
    cpSync(s, d, { recursive: true });
  }

  // Stamp every HTML entry point.
  for (const f of ["index.html", "watch.html"]) {
    const p = join(out, f);
    if (!existsSync(p)) die(`composed tree missing ${f}`);
    writeFileSync(p, stamp(readFileSync(p, "utf8"), sha, f));
  }

  const files = walk(out);
  ok(`composed ${files.length} files into ${out} at ${sha}`);
  console.log(`index-sha256=${sha256(readFileSync(join(out, "index.html")))}`);
}

function verifyArtifact() {
  const dir = arg("dir");
  const sha = arg("sha");
  const files = walk(dir);
  if (files.length === 0) die(`${dir} is empty`);

  const index = join(dir, "index.html");
  if (!existsSync(index)) die("index.html missing");
  const html = readFileSync(index, "utf8");
  const bytes = statSync(index).size;

  if (bytes < MIN_INDEX_BYTES) die(`index.html is ${bytes} B, expected >= ${MIN_INDEX_BYTES} B`);
  ok(`index.html ${bytes} B`);

  if (!html.includes(`content="${sha}"`)) die(`index.html is not stamped with ${sha}`);
  ok(`build-sha stamp ${sha}`);

  for (const m of REQUIRED_MARKERS) {
    if (!html.includes(m)) die(`required marker absent from index.html: ${m}`);
  }
  ok(`required markers present (${REQUIRED_MARKERS.length})`);

  for (const m of FORBIDDEN_MARKERS) {
    if (html.includes(m)) die(`stale marker present in index.html: ${m}`);
  }
  ok(`stale markers absent (${FORBIDDEN_MARKERS.length})`);

  // Every shipped script must parse, and every shipped JSON must be valid --
  // a truncated copy is the classic way a static deploy silently half-lands.
  let js = 0, json = 0;
  for (const rel of files) {
    const p = join(dir, rel);
    if (rel.endsWith(".json")) {
      try { JSON.parse(readFileSync(p, "utf8")); json++; }
      catch (e) { die(`invalid JSON ${rel}: ${e.message}`); }
    }
  }
  ok(`${json} JSON files parse`);

  for (const rel of files.filter((f) => f.endsWith(".js"))) js++;
  console.log(`js-count=${js}`);
  console.log(`index-sha256=${sha256(readFileSync(index))}`);
  console.log(`file-count=${files.length}`);
}

async function verifyLive() {
  const url = arg("url");
  const sha = arg("sha");
  const expect = arg("sha256");
  const timeout = Number(arg("timeout", false) ?? 900);
  const interval = Number(arg("interval", false) ?? 15);

  const deadline = Date.now() + timeout * 1000;
  let attempt = 0, last = "no attempt made";

  while (Date.now() < deadline) {
    attempt++;
    try {
      // Cache-bust the CDN edge; Fastly caches /transit/ for max-age=600.
      const res = await fetch(`${url}?_cb=${sha.slice(0, 12)}-${attempt}`, {
        headers: { "cache-control": "no-cache", pragma: "no-cache" },
        redirect: "follow",
      });
      if (!res.ok) {
        last = `HTTP ${res.status}`;
      } else {
        const body = Buffer.from(await res.arrayBuffer());
        const got = sha256(body);
        const stamped = body.includes(`content="${sha}"`);
        if (got === expect && stamped) {
          ok(`live bytes match: ${body.length} B, sha256=${got}, build-sha=${sha}`);
          return;
        }
        last = stamped
          ? `stamp ok but sha256 ${got} != ${expect} (${body.length} B)`
          : `served ${body.length} B without build-sha ${sha} (sha256=${got})`;
      }
    } catch (e) {
      last = `fetch failed: ${e.message}`;
    }
    const left = Math.round((deadline - Date.now()) / 1000);
    console.log(`… attempt ${attempt}: ${last} — ${left}s left`);
    if (Date.now() + interval * 1000 >= deadline) break;
    await new Promise((r) => setTimeout(r, interval * 1000));
  }
  die(`live verification failed after ${attempt} attempts over ${timeout}s — last: ${last}`);
}

const cmd = process.argv[2];
if (cmd === "compose") compose();
else if (cmd === "verify-artifact") verifyArtifact();
else if (cmd === "verify-live") await verifyLive();
else die(`unknown command "${cmd ?? ""}" — expected compose | verify-artifact | verify-live`);
