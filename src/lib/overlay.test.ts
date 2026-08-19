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
