import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import type { Atlas, Place, Timetable } from "./atlas/types";
import { overpassAccessQuery, parseOverpassWays } from "./buildings";
import { daytimeClock } from "./clock";
import { haversineMeters, roadMinutes, walkMinutes } from "./geo";
import { planTrip } from "./planner";
import { firstStopFromQuery, placeFromStop, searchAtlas } from "./search";
import { activeServiceIndexes } from "./services";
import { minutesOfDay } from "./time";
import { TRIP_ROAD_FILTER, TRIP_ROAD_PAINT, TRIP_TRANSIT_FILTER, TRIP_WALK_FILTER, itineraryCollection } from "./map-legs";
import { mixLabel, navStepLabel, planTrajectories, transitMixName, tripStrokeStyle } from "./trajectory";

function loadCity(city: string): { atlas: Atlas; timetable: Timetable } {
  const root = join(process.cwd(), "public", "data", city);
  return {
    atlas: JSON.parse(readFileSync(join(root, "atlas.json"), "utf8")) as Atlas,
    timetable: JSON.parse(readFileSync(join(root, "timetable.json"), "utf8")) as Timetable,
  };
}

function firstStop(atlas: Atlas, query: string) {
  const hit = searchAtlas(atlas, query, 12).find((item) => item.kind === "stop");
  if (!hit || hit.kind !== "stop") throw new Error(`no stop ${query}`);
  return hit.stop;
}

function nearbyPlace(from: Place, dLon: number, label: string): Place {
  return { label, lon: from.lon + dLon, lat: from.lat };
}

describe("walk bike road and train mixes", () => {
  it("offers pedestrian, bike, and a distinct road option on Québec and Montréal atlases", () => {
    const clock = daytimeClock();
    const at = minutesOfDay(clock);
    for (const city of ["quebec", "montreal"] as const) {
      const { atlas, timetable } = loadCity(city);
      const from = placeFromStop(firstStop(atlas, city === "quebec" ? "Youville" : "Berri"));
      const walkTo = nearbyPlace(from, 0.007, "walk-scale");
      const longTo = placeFromStop(firstStop(atlas, city === "quebec" ? "Universite Laval" : "McGill"));
      const bikes = [
        { id: "s", name: "s", lon: from.lon, lat: from.lat, bikes: 4, docks: 4, system: city === "quebec" ? ("avelo" as const) : ("bixi" as const) },
        { id: "e", name: "e", lon: walkTo.lon, lat: walkTo.lat, bikes: 2, docks: 6, system: city === "quebec" ? ("avelo" as const) : ("bixi" as const) },
      ];
      const short = planTrip(atlas, timetable, from, walkTo, at, activeServiceIndexes(atlas, clock), bikes);
      assert.ok(
        short.some((row) => row.legs.every((leg) => leg.kind === "walk")),
        `${city} walk-scale pair must yield a pedestrian option`,
      );
      assert.ok(
        short.some((row) => row.legs.some((leg) => leg.kind === "bike")),
        `${city} bike stations must yield a bike mix`,
      );
      const meters = haversineMeters(from, longTo);
      const planned = planTrip(atlas, timetable, from, longTo, at, activeServiceIndexes(atlas, clock), [
        { id: "s", name: "s", lon: from.lon, lat: from.lat, bikes: 4, docks: 4, system: city === "quebec" ? ("avelo" as const) : ("bixi" as const) },
        { id: "e", name: "e", lon: longTo.lon, lat: longTo.lat, bikes: 2, docks: 6, system: city === "quebec" ? ("avelo" as const) : ("bixi" as const) },
      ]);
      const roadItin = planned.find((row) => row.legs.some((leg) => leg.kind === "road"));
      assert.ok(roadItin, `${city} planner must emit an auto leg`);
      assert.equal(roadItin.minutes, roadMinutes(meters));
      assert.notEqual(roadItin.minutes, walkMinutes(meters));
      const long = planTrajectories(atlas, timetable, from, longTo, at, activeServiceIndexes(atlas, clock), [
        { id: "s", name: "s", lon: from.lon, lat: from.lat, bikes: 4, docks: 4, system: city === "quebec" ? "avelo" : "bixi" },
        { id: "e", name: "e", lon: longTo.lon, lat: longTo.lat, bikes: 2, docks: 6, system: city === "quebec" ? "avelo" : "bixi" },
      ]);
      const road = long.find((row) => row.mix === "auto" || row.itinerary.legs.some((leg) => leg.kind === "road"));
      assert.ok(road, `${city} longer pair must yield a road-vehicle option`);
      assert.equal(road.minutes, roadItin.minutes);
      const walkClone = long.find((row) => row.mix === "marche");
      if (walkClone) assert.notEqual(road.minutes, walkClone.minutes);
      assert.ok(road.minutes > 0 && Number.isFinite(road.minutes));
      assert.ok(roadMinutes(8_000) < walkMinutes(8_000));
    }
  });

  it("names GTFS type 2 as train, not bus", () => {
    assert.equal(transitMixName(2), "train");
    assert.equal(transitMixName(106), "train");
    assert.equal(transitMixName(1), "métro");
    assert.equal(transitMixName(700), "bus");
    assert.equal(transitMixName("nope"), "bus");
    for (const type of [0, 3, 4, 5, 7, 11, 12, 200, 400, 700, 900, null, undefined]) {
      assert.notEqual(transitMixName(type), "train", `non-rail ${String(type)} must not mix as train`);
    }
    const label = mixLabel([
      {
        kind: "transit",
        minutes: 18,
        routeId: "exo:12",
        shortName: "12",
        color: "#111111",
        textColor: "#ffffff",
        headsign: "Gare",
        type: 2,
        from: { label: "A", lon: -73.5, lat: 45.5 },
        to: { label: "B", lon: -73.6, lat: 45.5 },
        depart: 960,
        arrive: 978,
        stopIds: ["a", "b"],
        line: "",
      },
    ]);
    assert.equal(label, "train");
    assert.doesNotMatch(label, /bus/);
  });

  it("stays empty on junk places and clocks", () => {
    const { atlas, timetable } = loadCity("quebec");
    const clock = daytimeClock();
    const at = minutesOfDay(clock);
    const active = activeServiceIndexes(atlas, clock);
    const dest = placeFromStop(firstStop(atlas, "Youville"));
    assert.deepEqual(planTrip(atlas, timetable, { label: "x", lon: Number.NaN, lat: 46 }, dest, at, active), []);
    assert.deepEqual(planTrip(atlas, timetable, dest, { label: "y", lon: 200, lat: 46 }, at, active), []);
    assert.deepEqual(planTrip(atlas, timetable, dest, dest, Number.NaN, active), []);
    assert.equal(roadMinutes(Number.NaN), 0);
    assert.equal(walkMinutes(Number.NaN), 0);
  });

  it("drives shipped mix labels and a working-set access query", async () => {
    const kit = (await import(pathToFileURL(join(process.cwd(), "public", "Transit", "rive-kit.js")).href)) as {
      mixLabel: typeof mixLabel;
      roadMinutes: typeof roadMinutes;
      walkMinutes: typeof walkMinutes;
      transitMixName: typeof transitMixName;
    };
    assert.equal(kit.mixLabel([{ kind: "transit", type: 2 }] as never), "train");
    assert.equal(kit.mixLabel([{ kind: "transit", type: 106 }] as never), "train");
    assert.equal(kit.mixLabel([{ kind: "transit", type: 700 }] as never), "bus");
    assert.equal(kit.mixLabel([{ kind: "road" }] as never), "auto");
    assert.equal(kit.transitMixName(2), transitMixName(2));
    assert.equal(kit.transitMixName(106), "train");
    for (const type of [0, 3, 700, 900, null]) {
      assert.equal(kit.transitMixName(type), transitMixName(type));
      assert.notEqual(kit.transitMixName(type), "train");
    }
    assert.equal(kit.walkMinutes(750), walkMinutes(750));
    assert.ok(kit.roadMinutes(5800) < kit.walkMinutes(5800));
    const shippedBuildings = (await import(pathToFileURL(join(process.cwd(), "public", "Transit", "buildings.js")).href)) as {
      overpassAccessQuery: typeof overpassAccessQuery;
      parseOverpassWays: typeof parseOverpassWays;
    };
    const q = shippedBuildings.overpassAccessQuery({ lat: 46.8131, lon: -71.2082 }, 700, 64);
    assert.match(q, /cycleway\|path\|footway/);
    assert.match(q, /motorway\|trunk\|primary/);
    assert.match(q, /around:/);
    assert.deepEqual(shippedBuildings.parseOverpassWays(null), []);
    assert.deepEqual(parseOverpassWays(null), []);
    const src = readFileSync(join(process.cwd(), "public", "Transit", "app.js"), "utf8");
    assert.match(src, /mixLabel/);
    assert.match(src, /roadMinutes/);
    assert.match(src, /walkMinutes\(walkM\)/);
    assert.match(src, /drawAccessWays/);
    assert.match(src, /kind === "road"/);
    assert.match(src, /navStepLabel/);
    assert.match(src, /tripStrokeStyle/);
  });

  it("labels and strokes road legs as auto, not as transit", async () => {
    const road = {
      kind: "road" as const,
      minutes: 9,
      meters: 5200,
      label: "Auto 5.2 km",
      from: { label: "A", lon: -71.21, lat: 46.81 },
      to: { label: "B", lon: -71.27, lat: 46.78 },
    };
    assert.equal(navStepLabel(road), "Auto 5.2 km");
    assert.doesNotMatch(navStepLabel(road), /undefined/);
    const stroke = tripStrokeStyle(road);
    assert.ok(stroke.width < 6);
    assert.notEqual(stroke.color, "#0b6bcb");
    const features = itineraryCollection({
      id: "road-only",
      minutes: 9,
      walkMeters: 0,
      transfers: 0,
      depart: 960,
      arrive: 969,
      legs: [road],
    }).features;
    assert.equal(features.length, 1);
    assert.equal(features[0].properties?.kind, "road");
    assert.equal(features[0].geometry.type, "LineString");
    assert.equal(TRIP_ROAD_FILTER[2], "road");
    assert.equal(TRIP_ROAD_FILTER[0], "==");
    assert.ok(!JSON.stringify(TRIP_WALK_FILTER).includes("road"));
    assert.ok(!JSON.stringify(TRIP_TRANSIT_FILTER).includes("road"));
    assert.equal(TRIP_ROAD_PAINT["line-color"], stroke.color);
    assert.equal(TRIP_ROAD_PAINT["line-width"], stroke.width);
    assert.notEqual(TRIP_ROAD_PAINT["line-color"], "#0b6bcb");
    const kit = (await import(pathToFileURL(join(process.cwd(), "public", "Transit", "rive-kit.js")).href)) as {
      navStepLabel: typeof navStepLabel;
      tripStrokeStyle: typeof tripStrokeStyle;
    };
    assert.equal(kit.navStepLabel(road), "Auto 5.2 km");
    assert.ok(kit.tripStrokeStyle(road).width < 6);
    const react = readFileSync(join(process.cwd(), "src", "components", "rive-app.tsx"), "utf8");
    assert.match(react, /leg\.kind === "road"/);
    const map = readFileSync(join(process.cwd(), "src", "components", "map-view.tsx"), "utf8");
    assert.match(map, /from "@\/lib\/map-legs"/);
    assert.match(map, /id: "rive-trip-road"/);
    assert.match(map, /TRIP_ROAD_FILTER/);
    assert.match(map, /TRIP_ROAD_PAINT/);
  });
});
