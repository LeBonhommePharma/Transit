import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { escapeHtml } from "./escape";
import { planTrip } from "./planner";
import { cityForPoint, firstStopFromQuery, placeFromStop, searchAtlas } from "./search";
import { parseClock24 } from "./time";
import type { Atlas, Timetable } from "./atlas/types";
import { daytimeClock } from "./clock";
import { activeServiceIndexes } from "./services";
import { minutesOfDay } from "./time";

function loadCity(city: string): { atlas: Atlas; timetable: Timetable } {
  const root = join(process.cwd(), "public", "data", city);
  return {
    atlas: JSON.parse(readFileSync(join(root, "atlas.json"), "utf8")) as Atlas,
    timetable: JSON.parse(readFileSync(join(root, "timetable.json"), "utf8")) as Timetable,
  };
}

function cssBlock(html: string, start: string): string {
  const i = html.indexOf(start);
  assert.ok(i >= 0, `missing ${start}`);
  const open = html.indexOf("{", i);
  let depth = 0;
  for (let n = open; n < html.length; n++) {
    if (html[n] === "{") depth += 1;
    else if (html[n] === "}") {
      depth -= 1;
      if (depth === 0) return html.slice(open + 1, n);
    }
  }
  return "";
}

function cssToken(block: string, name: string): string {
  const m = block.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})`));
  assert.ok(m, `missing token ${name}`);
  return m![1];
}

function relativeLuminance(hex: string): number {
  const raw = hex.replace("#", "");
  const full = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw;
  const chan = (i: number) => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan(0) + 0.7152 * chan(2) + 0.0722 * chan(4);
}

function contrastRatio(a: string, b: string): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

type CssDecl = { sel: string; prop: string; value: string; media: string | null };

function extractStyle(html: string): string {
  const m = html.match(/<style>([\s\S]*?)<\/style>/);
  assert.ok(m, "missing shipped <style>");
  return m![1];
}

function matchingBrace(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function walkDecls(css: string, media: string | null = null): CssDecl[] {
  const out: CssDecl[] = [];
  let i = 0;
  while (i < css.length) {
    const brace = css.indexOf("{", i);
    if (brace < 0) break;
    const sel = css.slice(i, brace).trim();
    const close = matchingBrace(css, brace);
    if (close < 0) break;
    const body = css.slice(brace + 1, close);
    if (sel.startsWith("@media")) {
      out.push(...walkDecls(body, sel.replace(/^@media\s*/, "").trim()));
    } else {
      for (const part of body.split(";")) {
        const colon = part.indexOf(":");
        if (colon < 0) continue;
        const prop = part.slice(0, colon).trim();
        const value = part.slice(colon + 1).trim();
        if (!prop || !value) continue;
        for (const one of sel.split(",")) {
          out.push({ sel: one.trim(), prop, value, media });
        }
      }
    }
    i = close + 1;
  }
  return out;
}

function mediaApplies(media: string | null, widthPx: number): boolean {
  if (!media) return true;
  const max = media.match(/max-width:\s*(\d+)px/);
  const min = media.match(/min-width:\s*(\d+)px/);
  if (max && widthPx > Number(max[1])) return false;
  if (min && widthPx < Number(min[1])) return false;
  return true;
}

function winningDecl(html: string, selector: string, prop: string, widthPx: number): string | null {
  let win: string | null = null;
  for (const d of walkDecls(extractStyle(html))) {
    if (d.sel !== selector || d.prop !== prop) continue;
    if (!mediaApplies(d.media, widthPx)) continue;
    win = d.value;
  }
  return win;
}

type CascadeEl = { tag: string; classNames: string[]; id?: string; attrs?: string[]; parent?: CascadeEl | null };

function selectorSpecificity(sel: string): [number, number, number] {
  const ids = sel.match(/#[\w-]+/g)?.length ?? 0;
  const classes = sel.match(/\.[\w-]+/g)?.length ?? 0;
  const tags = sel.match(/(^|[\s>+~])([A-Za-z][\w-]*)/g)?.length ?? 0;
  return [ids, classes, tags];
}

function specBeats(a: [number, number, number], b: [number, number, number]): boolean {
  if (a[0] !== b[0]) return a[0] > b[0];
  if (a[1] !== b[1]) return a[1] > b[1];
  return a[2] > b[2];
}

function compoundMatches(part: string, el: CascadeEl): boolean {
  const tag = part.match(/^[A-Za-z][\w-]*/)?.[0];
  const classes = [...part.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
  const ids = [...part.matchAll(/#([\w-]+)/g)].map((m) => m[1]);
  const attrs = [...part.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1].replace(/=.*$/, "").trim());
  if (tag && el.tag.toLowerCase() !== tag.toLowerCase()) return false;
  if (ids.length && !ids.every((id) => el.id === id)) return false;
  if (attrs.length && !attrs.every((name) => (el.attrs || []).includes(name))) return false;
  if (!tag && !classes.length && !ids.length && !attrs.length) return false;
  return classes.every((name) => el.classNames.includes(name));
}

function selectorMatches(sel: string, el: CascadeEl): boolean {
  const parts = sel.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return false;
  let cur: CascadeEl | null | undefined = el;
  for (let i = parts.length - 1; i >= 0; i--) {
    while (cur && !compoundMatches(parts[i], cur)) cur = cur.parent;
    if (!cur) return false;
    if (i > 0) cur = cur.parent;
  }
  return true;
}

function themeGlyph(theme: "day" | "night", glyph: "moon" | "sun"): CascadeEl {
  const html: CascadeEl = { tag: "html", classNames: [theme] };
  const toolbar: CascadeEl = { tag: "div", classNames: ["toolbar"], parent: html };
  const button: CascadeEl = { tag: "button", classNames: ["icon"], parent: toolbar };
  return { tag: "svg", classNames: [glyph === "moon" ? "i-moon" : "i-sun"], parent: button };
}

function winningDisplay(html: string, el: CascadeEl, widthPx = 1024): string | null {
  let win: string | null = null;
  let best: [number, number, number] = [-1, -1, -1];
  let bestOrder = -1;
  let order = 0;
  for (const d of walkDecls(extractStyle(html))) {
    if (d.prop !== "display") continue;
    if (!mediaApplies(d.media, widthPx)) continue;
    if (!selectorMatches(d.sel, el)) continue;
    const spec = selectorSpecificity(d.sel);
    if (specBeats(spec, best) || (spec[0] === best[0] && spec[1] === best[1] && spec[2] === best[2] && order > bestOrder)) {
      win = d.value;
      best = spec;
      bestOrder = order;
    }
    order += 1;
  }
  return win;
}

describe("overlay polish and escape", () => {
  it("escapes untrusted overlay names and drives the shipped helper", async () => {
    const dirty = `<img src=x onerror=alert(1)> & "stop"`;
    const out = escapeHtml(dirty);
    assert.equal(out.includes("<"), false);
    assert.equal(out.includes(">"), false);
    assert.match(out, /&lt;img/);
    assert.match(out, /&amp;/);
    assert.match(out, /&quot;stop&quot;/);
    assert.equal(escapeHtml(null), "");
    assert.equal(escapeHtml(undefined), "");
    const shipped = (await import(pathToFileURL(join(process.cwd(), "public", "Transit", "rive-kit.js")).href)) as {
      escapeHtml: typeof escapeHtml;
    };
    assert.equal(shipped.escapeHtml(dirty), escapeHtml(dirty));
    assert.equal(shipped.escapeHtml("<script>"), "&lt;script&gt;");
    const src = readFileSync(join(process.cwd(), "public", "Transit", "app.js"), "utf8");
    assert.match(src, /escapeHtml\(title\)/);
    assert.match(src, /escapeHtml\(hit\.stop\.name\)/);
    assert.match(src, /from "\.\/rive-kit\.js"/);
    assert.doesNotMatch(src, /function escapeHtml/);
  });

  it("keeps named overlay controls, day/night tokens, focus, and a phone-width rail", () => {
    const html = readFileSync(join(process.cwd(), "public", "Transit", "index.html"), "utf8");
    for (const id of ["cities", "sheet", "dest", "at", "heading", "wx", "nav", "map-hud", "fold", "perms"]) {
      if (id === "cities") {
        assert.match(html, /class="cities"/);
      } else {
        assert.match(html, new RegExp(`id="${id}"`));
      }
    }
    assert.match(html, /id="status-rail"/);
    assert.match(html, /class="skip"/);
    assert.match(html, /viewport-fit=cover/);
    assert.match(html, /html\.day/);
    assert.match(html, /html\.night/);
    assert.match(html, /--paper/);
    assert.match(html, /--hair/);
    assert.match(html, /--ring/);
    assert.match(html, /--z-rail/);
    assert.match(html, /--z-sheet/);
    assert.match(html, /--z-hud/);
    assert.match(html, /safe-area-inset-top/);
    assert.match(html, /flex-wrap:\s*nowrap/);
    assert.match(html, /overflow-x:\s*auto/);
    assert.match(html, /:focus-visible/);
    assert.match(html, /prefers-reduced-motion/);
    assert.match(html, /prefers-reduced-transparency/);
    assert.match(html, /min-height:\s*44px/);
    assert.doesNotMatch(html, /fonts\.googleapis|cdn\.jsdelivr|unpkg\.com/);
    assert.match(html, /air-quality-api\.open-meteo\.com/);
    assert.match(
      html,
      /connect-src 'self' https:\/\/api\.stm\.info https:\/\/quebec\.publicbikesystem\.net https:\/\/gbfs\.velobixi\.com https:\/\/overpass-api\.de https:\/\/overpass\.kumi\.systems https:\/\/tiles\.openfreemap\.org https:\/\/api\.open-meteo\.com https:\/\/air-quality-api\.open-meteo\.com/,
    );
    const rail = Number(html.match(/--rail:\s*([\d.]+)rem/)?.[1]);
    assert.ok(Number.isFinite(rail) && rail > 0);
    const citiesW = 375 - 12 - 12 - rail * 16;
    assert.ok(citiesW >= 180, `375px city strip too narrow: ${citiesW}`);
    assert.match(html, /\.at \{[^}]*flex:\s*0 0 auto/);
    assert.match(html, /\.tools, \.seg \{[\s\S]*?overflow-x:\s*auto/);
    assert.match(html, /overflow-wrap:\s*anywhere/);
    const navRight = winningDecl(html, "#nav", "right", 375);
    assert.ok(navRight, "missing winning #nav right at 375px");
    assert.match(navRight, /var\(--rail\)/);
    assert.doesNotMatch(navRight, /^var\(--safe-right\)\s*$/);
    const geoMax = winningDecl(html, "#geo-ask", "max-width", 375);
    assert.ok(geoMax);
    assert.match(geoMax, /var\(--rail\)/);
    const nextCfg = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");
    const headerCsp = nextCfg.match(/Content-Security-Policy", value: "([^"]+)"/)?.[1] ?? "";
    const metaCsp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] ?? "";
    assert.match(headerCsp, /connect-src[^"]*https:\/\/api\.open-meteo\.com/);
    assert.match(headerCsp, /connect-src[^"]*https:\/\/air-quality-api\.open-meteo\.com/);
    assert.match(metaCsp, /https:\/\/api\.open-meteo\.com/);
    assert.match(metaCsp, /https:\/\/air-quality-api\.open-meteo\.com/);
    const day = cssBlock(html, ":root, html.day");
    const night = cssBlock(html, "html.night");
    assert.ok(contrastRatio(cssToken(day, "--ink"), cssToken(day, "--paper")) >= 4.5);
    assert.ok(contrastRatio(cssToken(day, "--muted"), cssToken(day, "--paper")) >= 4.5);
    assert.ok(contrastRatio(cssToken(day, "--chip-ink"), cssToken(day, "--chip")) >= 4.5);
    assert.ok(contrastRatio(cssToken(night, "--ink"), cssToken(night, "--paper")) >= 4.5);
    assert.ok(contrastRatio(cssToken(night, "--muted"), cssToken(night, "--paper")) >= 4.5);
    assert.ok(contrastRatio(cssToken(night, "--chip-ink"), cssToken(night, "--chip")) >= 4.5);
  });

  it("shows one theme glyph and one Jour/Nuit label per day or night", async () => {
    const html = readFileSync(join(process.cwd(), "public", "Transit", "index.html"), "utf8");
    const dayMoon = winningDisplay(html, themeGlyph("day", "moon"));
    const daySun = winningDisplay(html, themeGlyph("day", "sun"));
    const nightMoon = winningDisplay(html, themeGlyph("night", "moon"));
    const nightSun = winningDisplay(html, themeGlyph("night", "sun"));
    assert.notEqual(dayMoon, "none", `day moon display=${String(dayMoon)}`);
    assert.equal(daySun, "none");
    assert.equal(nightMoon, "none");
    assert.notEqual(nightSun, "none", `night sun display=${String(nightSun)}`);
    assert.notEqual(dayMoon, daySun);
    assert.notEqual(nightMoon, nightSun);

    const kit = (await import(pathToFileURL(join(process.cwd(), "public", "Transit", "rive-kit.js")).href)) as {
      themeButtonLabel: (theme: string) => string;
    };
    assert.equal(kit.themeButtonLabel("day"), "Nuit");
    assert.equal(kit.themeButtonLabel("night"), "Jour");
    assert.notEqual(kit.themeButtonLabel("day"), kit.themeButtonLabel("night"));
    const src = readFileSync(join(process.cwd(), "public", "Transit", "app.js"), "utf8");
    const apply = src.match(/function applyTheme\([\s\S]*?\n\}/);
    assert.ok(apply);
    assert.match(apply[0], /themeButtonLabel\(state\.theme\)/);
    assert.doesNotMatch(apply[0], /setAttribute\("aria-label", "Nuit"\)[\s\S]*setAttribute\("aria-label", "Jour"\)/);
    assert.match(html, /id="theme"[^>]*aria-label="Nuit"/);
    assert.match(html, /id="theme"[^>]*title="Nuit"/);
    assert.match(html, /--sodium/);
    assert.doesNotMatch(html, /fonts\.googleapis/);
  });

  it("yields no trip on junk clock or dest and stays outside coverage", () => {
    const { atlas, timetable } = loadCity("quebec");
    const clock = daytimeClock();
    const at = minutesOfDay(clock);
    const active = activeServiceIndexes(atlas, clock);
    const youville = firstStopFromQuery(atlas, "Youville");
    assert.ok(youville);
    const dest = placeFromStop(youville!);
    assert.equal(parseClock24("nope"), null);
    assert.equal(parseClock24(""), null);
    assert.equal(parseClock24("99:99"), null);
    assert.deepEqual(searchAtlas(atlas, "@@@", 6), []);
    assert.equal(firstStopFromQuery(atlas, "zzzz-not-a-stop"), null);
    assert.deepEqual(planTrip(atlas, timetable, dest, dest, Number.NaN, active), []);
    assert.equal(cityForPoint(-75.7, 45.42), null);
    const html = readFileSync(join(process.cwd(), "public", "Transit", "index.html"), "utf8");
    assert.match(html, /data-city="sherbrooke"/);
    assert.match(html, /data-city="trois-rivieres"/);
  });
});
