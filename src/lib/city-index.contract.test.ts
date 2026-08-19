import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Atlas, AtlasStop, Timetable } from "./atlas/types";
import { departuresAtStop } from "./planner";
import { activeServiceIndexes } from "./services";
import { minutesOfDay } from "./time";

function shippedCities(): string[] {
  const index = JSON.parse(readFileSync(join(process.cwd(), "public", "data", "index.json"), "utf8")) as {
    cities?: Array<{ city?: unknown }>;
  };
  const cities = Array.isArray(index.cities)
    ? index.cities.map((row) => row.city).filter((city): city is string => typeof city === "string" && city.length > 0)
    : [];
  return cities;
}

const cityCache = new Map<string, { atlas: Atlas; timetable: Timetable }>();

function loadCity(city: string): { atlas: Atlas; timetable: Timetable } {
  const hit = cityCache.get(city);
  if (hit) return hit;
  const root = join(process.cwd(), "public", "data", city);
  const pack = {
    atlas: JSON.parse(readFileSync(join(root, "atlas.json"), "utf8")) as Atlas,
    timetable: JSON.parse(readFileSync(join(root, "timetable.json"), "utf8")) as Timetable,
  };
  cityCache.set(city, pack);
  return pack;
}

function stopIdsOnAtlas(atlas: Atlas): Set<string> {
  const stopIds = new Set(atlas.stops.map((stop) => stop.id));
  for (const stop of atlas.stops) {
    for (const child of stop.children ?? []) stopIds.add(child);
  }
  return stopIds;
}

function officialStopWithTimetable(
  atlas: Atlas,
  timetable: Timetable,
  active: Set<number>,
): AtlasStop | undefined {
  const withActive = atlas.stops.find((stop) => {
    if (stop.routes.length === 0) return false;
    const rows = timetable[stop.id];
    if (!Array.isArray(rows) || rows.length === 0) return false;
    return rows.some((row) => row.t.length > 0 && row.s.some((service) => active.has(service)));
  });
  if (withActive) return withActive;
  return atlas.stops.find((stop) => stop.routes.length > 0 && (timetable[stop.id]?.length ?? 0) > 0);
}

describe("city index contract", () => {
  const cities = shippedCities();

  it("lists at least one city in public/data/index.json", () => {
    assert.ok(cities.length > 0, "public/data/index.json cities[] is empty");
  });

  for (const city of cities) {
    describe(city, () => {
      it("timetable keys and route ids resolve on the atlas", () => {
        const { atlas, timetable } = loadCity(city);
        const stopIds = stopIdsOnAtlas(atlas);
        const routeIds = new Set(atlas.routes.map((route) => route.id));

        for (const stopId of Object.keys(timetable)) {
          assert.equal(stopIds.has(stopId), true, `${city} orphan timetable stop ${stopId}`);
        }
        for (const rows of Object.values(timetable)) {
          for (const row of rows) {
            assert.equal(routeIds.has(row.r), true, `${city} orphan timetable route ${row.r}`);
          }
        }
        for (const route of atlas.routes) {
          for (const dir of route.dirs) {
            if (!dir.line) continue;
            assert.equal(routeIds.has(route.id), true, `${city} drawn line without route ${route.id}`);
          }
        }
      });

      it("has at least one active service for now", () => {
        const { atlas } = loadCity(city);
        assert.ok(
          activeServiceIndexes(atlas, new Date()).size > 0,
          `${city} has no active service on ${new Date().toISOString()}`,
        );
      });

      it("can list departures at a resolvable official stop", () => {
        const { atlas, timetable } = loadCity(city);
        const now = new Date();
        const active = activeServiceIndexes(atlas, now);
        const stop = officialStopWithTimetable(atlas, timetable, active);
        assert.ok(stop, `${city} has no official stop with routes and a timetable row`);
        const rows = timetable[stop.id];
        assert.ok(Array.isArray(rows) && rows.length > 0, `${city} ${stop.id} timetable row is empty`);

        const departures = departuresAtStop(atlas, timetable, stop, minutesOfDay(now), active);
        assert.ok(Array.isArray(departures));
        const serviced = rows.some((row) => row.t.length > 0 && row.s.some((service) => active.has(service)));
        if (active.size > 0 && serviced) {
          assert.ok(departures.length > 0, `${city} ${stop.name} should have a departure while services are active`);
        }
      });
    });
  }
});
