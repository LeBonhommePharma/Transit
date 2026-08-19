import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { daytimeClock } from "./clock";
import { formatShownLine, shownConditions } from "./conditions";
import { renderTransitSnapshot, runTui } from "./tui";

const WET = {
  current: {
    precipitation: 2.1,
    rain: 2.1,
    temperature_2m: 3,
    wind_speed_10m: 24,
    wind_direction_10m: 90,
    uv_index: 5,
    european_aqi: 61,
  },
};

describe("Transit TUI", () => {
  it("prints a city/stop snapshot with weather and survives a second run", async () => {
    const now = daytimeClock();
    const first = renderTransitSnapshot({ city: "quebec", query: "Youville", weather: WET, now });
    const second = renderTransitSnapshot({ city: "quebec", query: "Youville", weather: WET, now });
    assert.match(first, /Rive/);
    assert.match(first, /Youville/i);
    assert.match(first, /pluie|chaussée|vent|UV|AQI/);
    assert.match(first, /\d+ min/);
    assert.equal(second, first);
    assert.match(first, /801|800|807|80/);
    assert.match(first, new RegExp(formatShownLine(shownConditions(WET)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const calm = renderTransitSnapshot({ city: "quebec", query: "Youville", weather: { current: { precipitation: 0, uv_index: 1, european_aqi: 10, wind_speed_10m: 2 } }, now });
    assert.doesNotMatch(calm, /pluie|chaussée|vent |UV |AQI /);
    const logs: string[] = [];
    const prev = process.env.RIVE_WEATHER_JSON;
    process.env.RIVE_WEATHER_JSON = JSON.stringify(WET);
    let code = 1;
    try {
      code = await runTui(["quebec", "Youville"], { log: (s) => logs.push(s), error: () => {} });
    } finally {
      if (prev == null) delete process.env.RIVE_WEATHER_JSON;
      else process.env.RIVE_WEATHER_JSON = prev;
    }
    assert.equal(code, 0);
    assert.match(logs.join("\n"), /Youville/i);
    assert.match(logs.join("\n"), /pluie|chaussée|vent|UV|AQI/);
    const index = JSON.parse(readFileSync(join(process.cwd(), "public", "data", "index.json"), "utf8")) as {
      cities?: Array<{ city?: string }>;
    };
    const cities = (index.cities || []).map((row) => row.city).filter(Boolean);
    assert.ok(cities.includes("quebec"));
    const src = readFileSync(join(process.cwd(), "src", "lib", "tui.ts"), "utf8");
    assert.match(src, /index\.json/);
  });

  it("does not crash on a missing city or stop", async () => {
    const missingCity = renderTransitSnapshot({ city: "ottawa", query: "Youville" });
    assert.match(missingCity, /inconnue|introuvable/i);
    const missingStop = renderTransitSnapshot({ city: "quebec", query: "zzzz-not-a-stop" });
    assert.match(missingStop, /introuvable/i);
    const empty = renderTransitSnapshot({ city: "", query: "" });
    assert.match(empty, /Ville inconnue/i);
    let err = "";
    const code = await runTui([], { log: () => {}, error: (s) => { err = s; } });
    assert.equal(code, 1);
    assert.match(err, /usage/);
  });

  it("launches the CLI twice without a browser", () => {
    const cmd = [
      "--experimental-strip-types",
      "--import",
      "./scripts/node-ts-hooks.mjs",
      "src/lib/tui.ts",
      "quebec",
      "Youville",
    ];
    const a = spawnSync(process.execPath, cmd, { encoding: "utf8", cwd: process.cwd(), env: { ...process.env } });
    const b = spawnSync(process.execPath, cmd, { encoding: "utf8", cwd: process.cwd(), env: { ...process.env } });
    assert.equal(a.status, 0, a.stderr);
    assert.equal(b.status, 0, b.stderr);
    assert.match(a.stdout, /Rive/);
    assert.match(a.stdout, /Youville/i);
    assert.match(b.stdout, /Youville/i);
    assert.match(a.stdout, /\d+ min/);
    assert.match(b.stdout, /\d+ min/);
    assert.doesNotMatch(a.stdout + a.stderr, /thebonhomme.com/);
  });
});
