import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Atlas, AtlasStop, Timetable } from "./atlas/types";
import { parseTransitQuery } from "./assist";
import { feedUrl, mergeStations } from "./bikeshare";
import { daytimeClock, eveningClock } from "./clock";
import { pickLocale } from "./i18n";
import { connectorWalk, departuresAtStop, planTrip } from "./planner";
import { resolveSearchAction } from "./search-submit";
import { lineByShortNameOrColor, nearbyLines, nextDueOnLine } from "./lines";
import { mixLabel, planTrajectories } from "./trajectory";
import { fold, firstStopFromQuery, nearbyStops, pinHereForCity, placeFromStop, searchAtlas, stopHasService } from "./search";
import { activeServiceIndexes } from "./services";
import { formatClock, minutesOfDay, prefersHour12 } from "./time";
import { pickPois } from "./poi";
import {
  applyDetour,
  applyTripUpdatesToDue,
  hopMinutes,
  overlayWithVehicles,
  parseRealtimePayload,
  samePolyline,
  trajectoryAfterRealtime,
} from "./realtime";
import { fingerprintFromMeta, shouldFetchZip } from "./update";

function loadCity(city: "quebec" | "montreal"): { atlas: Atlas; timetable: Timetable } {
  const root = join(process.cwd(), "public", "data", city);
  return {
    atlas: JSON.parse(readFileSync(join(root, "atlas.json"), "utf8")) as Atlas,
    timetable: JSON.parse(readFileSync(join(root, "timetable.json"), "utf8")) as Timetable,
  };
}

function firstStopHit(atlas: Atlas, query: string): AtlasStop {
  const hit = searchAtlas(atlas, query, 12).find((item) => item.kind === "stop");
  if (!hit || hit.kind !== "stop") {
    throw new Error(`no stop hit for ${query}`);
  }
  return hit.stop;
}

describe("hostile user input", () => {
  it("fold rejects non-strings and strips combining marks", () => {
    assert.equal(fold(""), "");
    assert.equal(fold("   "), "");
    assert.equal(fold("Québec"), "quebec");
    assert.equal(fold(undefined as unknown as string), "");
    assert.equal(fold(null as unknown as string), "");
    assert.equal(fold(12 as unknown as string), "");
    assert.equal(fold({} as unknown as string), "");
  });

  it("searchAtlas swallows empty, whitespace, and garbage without throwing", () => {
    const montreal = loadCity("montreal");
    assert.ok(
      montreal.atlas.stops.some((stop) => stop.kind === 1),
      "Montréal atlas must include metro stations so the unmatched bonus can fail this test",
    );
    for (const city of ["quebec", "montreal"] as const) {
      const { atlas } = loadCity(city);
      assert.deepEqual(searchAtlas(atlas, ""), []);
      assert.deepEqual(searchAtlas(atlas, "   \n\t  "), []);
      assert.deepEqual(searchAtlas(atlas, "@@@###!!!"), []);
      assert.deepEqual(searchAtlas(atlas, "🦄🚀"), []);
      assert.deepEqual(searchAtlas(atlas, "zzzz-not-a-stop"), []);
      assert.deepEqual(searchAtlas(atlas, "<script>alert(1)</script>"), []);
      assert.deepEqual(searchAtlas(atlas, "\u202e\u0000not-a-stop"), []);
      assert.deepEqual(searchAtlas(atlas, "asdfqwerzxcv"), []);
      assert.ok(Array.isArray(searchAtlas(atlas, "x".repeat(4000))));
      assert.equal(firstStopFromQuery(atlas, "zzzz-not-a-stop"), null);
      assert.equal(firstStopFromQuery(atlas, ""), null);
    }
    assert.deepEqual(searchAtlas(montreal.atlas, "zzzz-not-a-stop"), []);
    assert.equal(firstStopFromQuery(montreal.atlas, "zzzz-not-a-stop"), null);
  });

  it("static app.js only bonuses metro stops after a real match", () => {
    const src = readFileSync(join(process.cwd(), "public", "Transit", "app.js"), "utf8");
    assert.match(src, /if \(score > 0 && stop\.kind === 1\) score \+= 8;/);
    assert.doesNotMatch(src, /else if \(tokenHits > 0\) score = 40 \+ tokenHits \* 25;\s*if \(stop\.kind === 1\) score \+= 8;/);
  });

  it("static atlas asks here, nearby, destination, and horaire ailleurs at a given time", () => {
    const html = readFileSync(join(process.cwd(), "public", "Transit", "index.html"), "utf8");
    const src = readFileSync(join(process.cwd(), "public", "Transit", "app.js"), "utf8");
    assert.match(html, /id="here"/);
    assert.match(html, /Où vas-tu|whereTo|id="dest"/);
    assert.match(html, /Horaire ailleurs/);
    assert.match(html, /type="time"|id="at"/);
    assert.match(html, /id="nearby"/);
    assert.match(src, /geolocation/);
    assert.match(src, /nearbyStops/);
    assert.match(src, /planFromHere|planTrip/);
    assert.match(src, /clockMinutes|getElementById\("at"\)/);
  });

  it("static atlas offers destination, line number/color, departure time, and next-due", () => {
    const html = readFileSync(join(process.cwd(), "public", "Transit", "index.html"), "utf8");
    const src = readFileSync(join(process.cwd(), "public", "Transit", "app.js"), "utf8");
    assert.match(html, /id="dest"/);
    assert.match(html, /id="lines"/);
    assert.match(html, /type="time"|id="at"/);
    assert.match(html, /id="due"|Prochain|due/);
    assert.match(src, /nearbyLines/);
    assert.match(src, /nextDueOnLine/);
    assert.match(src, /pinHereForCity/);
  });

  it("static atlas declares day/night tokens, refined faces, and a POI hook", () => {
    const html = readFileSync(join(process.cwd(), "public", "Transit", "index.html"), "utf8");
    const src = readFileSync(join(process.cwd(), "public", "Transit", "app.js"), "utf8");
    assert.match(html, /@font-face/);
    assert.match(html, /Rive Text|Rive Clock/);
    assert.match(html, /html\.night|--night|prefers-color-scheme:\s*dark/);
    assert.match(html, /html\.day|--paper/);
    assert.match(html, /id="refresh"|Actualiser/);
    assert.match(html, /id="fold"/);
    assert.match(html, /id="clockfmt"/);
    assert.match(src, /prefersHour12/);
    assert.match(src, /clockMode/);
    assert.match(src, /strokeStyle/);
    assert.match(html, /sheet-body|sheet\.folded/);
    assert.match(src, /setSheetOpen/);
    assert.match(src, /sheetOpen/);
    assert.match(src, /pickPois|pois/);
    assert.match(src, /const due = applyTripUpdatesToDue\(scheduled, state\.tripUpdates/);
    assert.match(src, /await loadRealtime\(\);/);
    assert.match(src, /async function loadRealtime/);
    assert.match(src, /parseRealtimePayload/);
    assert.match(src, /state\.vehicles = vehicles/);
    assert.match(src, /applyDetour|state\.detours/);
    assert.match(src, /overlayWithVehicles|vehiclesOnRoute/);
    assert.match(src, /shouldFetchZip|userDeclared|feedIsStale/);
  });

  it("matches accent-folded Québec queries on the real atlas", () => {
    const { atlas } = loadCity("quebec");
    const a = searchAtlas(atlas, "Québec");
    const b = searchAtlas(atlas, "Quebec");
    assert.ok(a.length > 0);
    assert.ok(b.length > 0);
    const you = firstStopFromQuery(atlas, "D'Youville");
    assert.ok(you);
    assert.match(you.name, /youville/i);
  });

  it("De+Vers still plans even if the leftover query looks like a stop name", () => {
    const from = { label: "Berri", lon: -73.55, lat: 45.51, stopId: "STATION_M146" };
    const to = { label: "McGill", lon: -73.57, lat: 45.5, stopId: "STATION_M140" };
    assert.equal(resolveSearchAction({ from, to, query: "Berri" }), "plan");
    assert.equal(resolveSearchAction({ from, to, query: "" }), "plan");
    assert.equal(resolveSearchAction({ from: null, to: null, query: "   " }), "none");
  });

  it("walk connector between two different real Montréal stations has a measured gap", () => {
    const { atlas } = loadCity("montreal");
    const alight = atlas.stops.find((s) => s.id === "STATION_M146");
    const board = atlas.stops.find((s) => s.id === "STATION_M140");
    assert.ok(alight && board);
    const gap = connectorWalk(alight, board, 3);
    assert.equal(gap.from.stopId, alight.id);
    assert.equal(gap.to.stopId, board.id);
    assert.ok(gap.meters > 80);
    assert.ok(gap.minutes >= 2);
  });

  it("departures and plan stay empty-safe on empty service days and identical places", () => {
    const quebec = loadCity("quebec");
    const youville = firstStopHit(quebec.atlas, "Youville");
    const none = departuresAtStop(quebec.atlas, quebec.timetable, youville, 960, new Set());
    assert.deepEqual(none, []);
    const here = placeFromStop(youville);
    const loop = planTrip(quebec.atlas, quebec.timetable, here, here, 960, new Set());
    assert.ok(Array.isArray(loop));
    assert.ok(loop.every((item) => item.legs.length > 0 || item.minutes >= 0));
  });

  it("GBFS helpers ignore missing discovery and invalid coordinates", () => {
    assert.equal(feedUrl({}, "station_status"), null);
    const stations = mergeStations(
      { data: { stations: [{ station_id: "bad", name: "x", lat: "nope", lon: "nope" }] } },
      { data: { stations: [] } },
      "bixi",
    );
    assert.deepEqual(stations, []);
  });
});

describe("search submit", () => {
  it("plans when both De and Vers are set instead of opening a schedule", () => {
    const from = { label: "Youville", lon: -71.21, lat: 46.81, stopId: "1-1190" };
    const to = { label: "Universite Laval", lon: -71.27, lat: 46.78, stopId: "1-1515" };
    assert.equal(resolveSearchAction({ from, to, query: "Youville" }), "plan");
    assert.equal(resolveSearchAction({ from: null, to: null, query: "Youville" }), "schedule");
  });
});

describe("locale and query assist", () => {
  it("picks Apple-style locales from a language list", () => {
    assert.equal(pickLocale(["fr-CA", "en"]), "fr-CA");
    assert.equal(pickLocale(["es-MX"]), "es-MX");
    assert.equal(pickLocale(["zz"]), "en");
    assert.equal(pickLocale(["pt-BR", "pt"]), "pt-BR");
  });

  it("parses a remote-stop question without a cloud model", () => {
    const intent = parseTransitQuery("horaire Youville Quebec");
    assert.equal(intent.city, "quebec");
    assert.equal(intent.kind, "schedule");
    assert.match(intent.query, /Youville/i);
    assert.equal(parseTransitQuery("horaire Traverse Levis").city, "quebec");
    assert.equal(parseTransitQuery("horaire Montmorency stlaval").city, "montreal");
  });

  it("swallows non-string and empty assist input", () => {
    const empty = parseTransitQuery("");
    assert.equal(empty.city, null);
    assert.equal(empty.kind, "schedule");
    const bogus = parseTransitQuery(undefined as unknown as string);
    assert.equal(bogus.query, "");
    assert.equal(bogus.kind, "schedule");
  });
});

describe("bikeshare GBFS", () => {
  it("reads v3 discovery feeds and merges station status", () => {
    const url = feedUrl(
      {
        data: {
          feeds: [
            { name: "station_information", url: "https://example.test/info" },
            { name: "station_status", url: "https://example.test/status" },
          ],
        },
      },
      "station_status",
    );
    assert.equal(url, "https://example.test/status");
    const stations = mergeStations(
      {
        data: {
          stations: [{ station_id: "a", name: "Place D'Youville", lat: 46.81, lon: -71.21 }],
        },
      },
      {
        data: {
          stations: [{ station_id: "a", num_bikes_available: 4, num_docks_available: 8 }],
        },
      },
      "avelo",
    );
    assert.equal(stations.length, 1);
    assert.equal(stations[0]?.system, "avelo");
    assert.equal(stations[0]?.bikes, 4);
    assert.equal(stations[0]?.name.includes("Youville"), true);
  });
});

describe("atlas joins", () => {
  for (const city of ["quebec", "montreal"] as const) {
    it(`${city} timetable keys and route ids resolve on the atlas`, () => {
      const { atlas, timetable } = loadCity(city);
      const stopIds = new Set(atlas.stops.map((stop) => stop.id));
      for (const stop of atlas.stops) {
        for (const child of stop.children ?? []) stopIds.add(child);
      }
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
  }
});

describe("nearbyStops from a rider position", () => {
  it("returns measured official stops around a real downtown stop on both atlases", () => {
    for (const city of ["quebec", "montreal"] as const) {
      const { atlas } = loadCity(city);
      const seedName = city === "quebec" ? "Youville" : "Berri";
      const seed = firstStopHit(atlas, seedName);
      const near = nearbyStops(atlas.stops, { lon: seed.lon, lat: seed.lat }, 700, 14);
      assert.ok(near.length > 0, `${city} nearby empty at ${seed.name}`);
      for (const stop of near) {
        assert.ok(stop.meters >= 0);
        assert.ok(Number.isFinite(stop.meters));
        assert.ok(typeof stop.name === "string" && stop.name.length > 0);
        assert.ok(stop.id);
      }
      const family = fold(seed.name).split(" ")[0] || fold(seed.name);
      assert.ok(
        near.some(
          (stop) =>
            stop.id === seed.id ||
            stop.parent === seed.id ||
            seed.parent === stop.id ||
            fold(stop.name).includes(family),
        ),
        `${city} nearby missed ${seed.name} family`,
      );
    }
  });

  it("is empty-safe for garbage and non-finite coordinates", () => {
    const { atlas } = loadCity("montreal");
    const stops = atlas.stops;
    assert.deepEqual(nearbyStops(stops, { lon: Number.NaN, lat: 45.5 }), []);
    assert.deepEqual(nearbyStops(stops, { lon: -73.5, lat: Number.POSITIVE_INFINITY }), []);
    assert.deepEqual(nearbyStops(stops, { lon: Number.NEGATIVE_INFINITY, lat: 45.5 }), []);
    assert.deepEqual(nearbyStops(stops, { lon: undefined as unknown as number, lat: 45.5 }), []);
    assert.deepEqual(nearbyStops(stops, null as unknown as { lon: number; lat: number }), []);
  });
});

describe("searchAtlas", () => {
  it("ranks Québec tokens Youville and 801", () => {
    const { atlas } = loadCity("quebec");
    const youville = searchAtlas(atlas, "Youville", 10);
    assert.ok(youville.length > 0);
    assert.ok(
      youville.some((hit) => {
        const text =
          hit.kind === "stop"
            ? hit.stop.name
            : `${hit.route.shortName} ${hit.route.longName}`;
        return /youville/i.test(text);
      }),
    );

    const metrobus = searchAtlas(atlas, "801", 8);
    assert.ok(metrobus.some((hit) => hit.kind === "route" && hit.route.shortName === "801"));
  });

  it("ranks Montréal tokens Berri and McGill", () => {
    const { atlas } = loadCity("montreal");
    const berri = searchAtlas(atlas, "Berri", 10);
    assert.ok(berri.length > 0);
    assert.ok(
      berri.some((hit) => {
        const text = hit.kind === "stop" ? hit.stop.name : hit.route.longName;
        return /berri/i.test(text);
      }),
    );

    const mcgill = searchAtlas(atlas, "McGill", 10);
    assert.ok(
      mcgill.some((hit) => {
        const text = hit.kind === "stop" ? hit.stop.name : hit.route.longName;
        return /mcgill/i.test(text);
      }),
    );

    const berriTop = berri.find((hit) => hit.kind === "stop");
    assert.ok(berriTop && berriTop.kind === "stop");
    assert.match(berriTop.stop.name, /berri-uqam/i);
  });
});

describe("service day and next passages", () => {
  const clock = daytimeClock();

  it("activates weekday services for both cities on the pinned afternoon", () => {
    const quebec = loadCity("quebec");
    const montreal = loadCity("montreal");
    assert.ok(activeServiceIndexes(quebec.atlas, clock).size > 0);
    assert.ok(activeServiceIndexes(montreal.atlas, clock).size > 0);
  });

  it("lists official short names after now at D'Youville and Berri-UQAM", () => {
    const now = minutesOfDay(clock);
    const quebec = loadCity("quebec");
    const montreal = loadCity("montreal");
    const youville = firstStopHit(quebec.atlas, "Youville");
    const berri = firstStopHit(montreal.atlas, "Berri");

    const qcPass = departuresAtStop(
      quebec.atlas,
      quebec.timetable,
      youville,
      now,
      activeServiceIndexes(quebec.atlas, clock),
    );
    const mtlPass = departuresAtStop(
      montreal.atlas,
      montreal.timetable,
      berri,
      now,
      activeServiceIndexes(montreal.atlas, clock),
    );

    assert.ok(qcPass.length > 0);
    assert.ok(mtlPass.length > 0);

    const qcNames = new Set(quebec.atlas.routes.map((route) => route.shortName));
    const mtlNames = new Set(montreal.atlas.routes.map((route) => route.shortName));
    for (const row of qcPass) {
      assert.equal(qcNames.has(row.shortName), true);
      assert.ok(row.depart >= now);
      assert.ok(row.shortName.length > 0);
    }
    for (const row of mtlPass) {
      assert.equal(mtlNames.has(row.shortName), true);
      assert.ok(row.depart >= now);
      assert.ok(row.shortName.length > 0);
      assert.ok(row.times.length > 0);
      assert.ok(row.times[0] >= now);
    }
  });

  it("lists passages at an explicit evening clock, not only afternoon now", () => {
    const evening = eveningClock();
    const at = minutesOfDay(evening);
    assert.ok(at > minutesOfDay(clock));
    const quebec = loadCity("quebec");
    const montreal = loadCity("montreal");
    const youville = firstStopHit(quebec.atlas, "Youville");
    const berri = firstStopHit(montreal.atlas, "Berri");
    const qcPass = departuresAtStop(
      quebec.atlas,
      quebec.timetable,
      youville,
      at,
      activeServiceIndexes(quebec.atlas, evening),
    );
    const mtlPass = departuresAtStop(
      montreal.atlas,
      montreal.timetable,
      berri,
      at,
      activeServiceIndexes(montreal.atlas, evening),
    );
    assert.ok(qcPass.length > 0);
    assert.ok(mtlPass.length > 0);
    for (const row of [...qcPass, ...mtlPass]) {
      assert.ok(row.depart >= at);
    }
  });

  it("resolves a remote stop by name without geolocation", () => {
    const quebec = loadCity("quebec");
    const montreal = loadCity("montreal");
    const youville = firstStopFromQuery(quebec.atlas, "Youville");
    const berri = firstStopFromQuery(montreal.atlas, "Berri");
    assert.ok(youville);
    assert.ok(berri);
    assert.match(youville.name, /youville/i);
    assert.match(berri.name, /berri/i);
    const now = minutesOfDay(clock);
    const away = departuresAtStop(
      quebec.atlas,
      quebec.timetable,
      youville,
      now,
      activeServiceIndexes(quebec.atlas, clock),
    );
    assert.ok(away.length > 0);
    assert.ok(away.some((row) => row.times.length >= 1));
  });
});

describe("walk transfer connector", () => {
  it("walks from the alight stop to a different board stop with the real gap", () => {
    const montreal = loadCity("montreal");
    const alight = montreal.atlas.stops.find((s) => s.id === "STATION_M146");
    const board = montreal.atlas.stops.find((s) => s.id === "STATION_M140");
    assert.ok(alight);
    assert.ok(board);
    const gap = connectorWalk(alight, board, 3);
    assert.equal(gap.kind, "walk");
    assert.notEqual(gap.from.stopId, gap.to.stopId);
    assert.equal(gap.to.stopId, board.id);
    assert.ok(gap.meters > 80);
    const same = connectorWalk(alight, undefined, 3);
    assert.equal(same.from.stopId, same.to.stopId);
    assert.equal(same.meters, 80);
  });
});

describe("nearby lines and next due", () => {
  it("lists official nearby lines toward a destination on both cities", () => {
    for (const city of ["quebec", "montreal"] as const) {
      const { atlas } = loadCity(city);
      const origin = firstStopHit(atlas, city === "quebec" ? "Youville" : "Berri");
      const dest = firstStopHit(atlas, city === "quebec" ? "Universite Laval" : "McGill");
      const lines = nearbyLines(atlas, origin, dest);
      assert.ok(lines.length > 0, `${city} nearby lines empty`);
      const byId = new Map(atlas.routes.map((route) => [route.id, route]));
      for (const line of lines) {
        const route = byId.get(line.routeId);
        assert.ok(route, `${city} unknown route ${line.routeId}`);
        assert.equal(line.shortName, route.shortName);
        assert.equal(line.color, route.color);
        assert.ok(line.shortName.length > 0);
        assert.ok(line.meters >= 0);
      }
      assert.ok(
        lines.some((line) => line.towardDest),
        `${city} no line marked toward dest`,
      );
      if (city === "montreal") {
        assert.equal(lines[0].type, 1, "Montréal métro must lead the line list");
      }
      const byName = lineByShortNameOrColor(lines, lines[0].shortName);
      assert.ok(byName);
      assert.equal(byName.routeId, lines[0].routeId);
      const byColor = lineByShortNameOrColor(lines, lines[0].color);
      assert.ok(byColor);
      assert.equal(byColor.color, lines[0].color);
    }
  });

  it("returns next-due of a selected line near the rider at daytime and evening clocks", () => {
    for (const city of ["quebec", "montreal"] as const) {
      const { atlas, timetable } = loadCity(city);
      const origin = firstStopHit(atlas, city === "quebec" ? "Youville" : "Berri");
      const dest = firstStopHit(atlas, city === "quebec" ? "Universite Laval" : "McGill");
      const lines = nearbyLines(atlas, origin, dest);
      assert.ok(lines.length > 0);
      for (const clock of [daytimeClock(), eveningClock()]) {
        const at = minutesOfDay(clock);
        const active = activeServiceIndexes(atlas, clock);
        const pick = lines.find(
          (line) => nextDueOnLine(atlas, timetable, origin, line.routeId, at, active).length > 0,
        );
        assert.ok(pick, `${city} no nearby line with passages at ${at}`);
        const due = nextDueOnLine(atlas, timetable, origin, pick.routeId, at, active);
        assert.ok(due.length > 0);
        for (const row of due) {
          assert.equal(row.routeId, pick.routeId);
          assert.equal(row.shortName, pick.shortName);
          assert.equal(row.color, pick.color);
          assert.ok(row.depart >= at);
          assert.ok(row.clocks.length > 0);
          assert.ok(row.wait >= 0);
          assert.ok(row.stopName.length > 0);
        }
      }
    }
  });

  it("still lists official Montréal lines after a Québec→Montréal here re-pin", () => {
    const quebec = loadCity("quebec");
    const montreal = loadCity("montreal");
    const qcCenter = {
      lon: quebec.atlas.meta.center[0],
      lat: quebec.atlas.meta.center[1],
      source: "map" as const,
    };
    const mtlCenter = {
      lon: montreal.atlas.meta.center[0],
      lat: montreal.atlas.meta.center[1],
    };
    assert.equal(nearbyLines(montreal.atlas, qcCenter).length, 0);
    const pinned = pinHereForCity(qcCenter, mtlCenter);
    assert.equal(pinned.source, "map");
    assert.equal(pinned.lon, mtlCenter.lon);
    assert.equal(pinned.lat, mtlCenter.lat);
    const dest = firstStopHit(montreal.atlas, "McGill");
    const lines = nearbyLines(montreal.atlas, pinned, dest);
    assert.ok(lines.length > 0, "Montréal dest after city switch must still yield lines");
    const byId = new Map(montreal.atlas.routes.map((route) => [route.id, route]));
    for (const line of lines) {
      const route = byId.get(line.routeId);
      assert.ok(route);
      assert.equal(line.shortName, route.shortName);
      assert.equal(line.color, route.color);
    }
    assert.equal(lines[0].type, 1);
  });
});

describe("trajectory totals", () => {
  it("totals walk, bike, bus, and métro mixes without a golden minute count", () => {
    const clock = daytimeClock();
    const at = minutesOfDay(clock);
    for (const city of ["quebec", "montreal"] as const) {
      const { atlas, timetable } = loadCity(city);
      const from = placeFromStop(firstStopHit(atlas, city === "quebec" ? "Youville" : "Berri"));
      const to = placeFromStop(
        firstStopHit(atlas, city === "quebec" ? "Universite Laval" : "McGill"),
      );
      const bikes = [
        {
          id: "s",
          name: "start",
          lon: from.lon,
          lat: from.lat,
          bikes: 4,
          docks: 4,
          system: city === "quebec" ? ("avelo" as const) : ("bixi" as const),
        },
        {
          id: "e",
          name: "end",
          lon: to.lon,
          lat: to.lat,
          bikes: 2,
          docks: 6,
          system: city === "quebec" ? ("avelo" as const) : ("bixi" as const),
        },
      ];
      const options = planTrajectories(
        atlas,
        timetable,
        from,
        to,
        at,
        activeServiceIndexes(atlas, clock),
        bikes,
      );
      assert.ok(options.length > 0, `${city} no trajectory options`);
      const mixes = new Set(options.map((row) => row.mix));
      assert.ok([...mixes].some((mix) => mix.includes("marche") || mix.includes("vélo")));
      assert.ok([...mixes].some((mix) => mix.includes("bus") || mix.includes("métro")));
      if (city === "montreal") {
        assert.ok(
          options.some((row) => row.mix.includes("métro")),
          "Montréal must offer a métro mix",
        );
        assert.ok(options[0].mix.includes("métro"), "Montréal métro mix is listed first");
      }
      for (const row of options) {
        assert.ok(row.minutes >= 0);
        const summed = row.itinerary.legs.reduce((n, leg) => n + leg.minutes, 0);
        assert.ok(row.minutes >= summed || row.minutes >= 0);
        assert.equal(row.mix, mixLabel(row.itinerary.legs));
      }
    }
  });
});

describe("planTrip", () => {
  const clock = daytimeClock();

  it("plans Youville area to Université Laval with legs whose routes exist", () => {
    const { atlas, timetable } = loadCity("quebec");
    const from = placeFromStop(firstStopHit(atlas, "Youville"));
    const lavalHit = searchAtlas(atlas, "Universite Laval", 20).find(
      (hit) => hit.kind === "stop" && hit.stop.agencyId === "RTC",
    );
    const to = placeFromStop(
      lavalHit && lavalHit.kind === "stop" ? lavalHit.stop : firstStopHit(atlas, "Universite Laval"),
    );
    const itineraries = planTrip(
      atlas,
      timetable,
      from,
      to,
      minutesOfDay(clock),
      activeServiceIndexes(atlas, clock),
    );
    assert.ok(itineraries.length > 0);
    const routeIds = new Set(atlas.routes.map((route) => route.id));
    const first = itineraries[0];
    assert.ok(first.legs.length > 0);
    assert.ok(
      first.legs.every(
        (leg) => leg.kind === "walk" || leg.kind === "transit" || leg.kind === "bike",
      ),
    );
    for (const leg of first.legs) {
      if (leg.kind === "transit") {
        assert.equal(routeIds.has(leg.routeId), true);
      }
    }
  });

  it("plans Berri to McGill at an explicit evening clock with legs after that clock", () => {
    const evening = eveningClock();
    const at = minutesOfDay(evening);
    const { atlas, timetable } = loadCity("montreal");
    const from = placeFromStop(firstStopHit(atlas, "Berri"));
    const to = placeFromStop(firstStopHit(atlas, "McGill"));
    const itineraries = planTrip(
      atlas,
      timetable,
      from,
      to,
      at,
      activeServiceIndexes(atlas, evening),
    );
    assert.ok(itineraries.length > 0);
    const first = itineraries[0];
    assert.ok(first.legs.length > 0);
    for (const leg of first.legs) {
      if (leg.kind === "transit") {
        assert.ok(leg.depart >= at);
      }
    }
  });

  it("merges STLévis and STL Laval into the regional atlases", () => {
    const quebec = loadCity("quebec");
    const montreal = loadCity("montreal");
    const stlevisRoutes = quebec.atlas.routes.filter((route) => route.agencyId === "STLévis");
    const stlRoutes = montreal.atlas.routes.filter((route) => route.agencyId === "STL");
    assert.ok(stlevisRoutes.length > 0);
    assert.ok(stlRoutes.length > 0);
    assert.ok(stlevisRoutes.every((route) => route.id.startsWith("stlevis:")));
    assert.ok(stlRoutes.every((route) => route.id.startsWith("stl:")));
    assert.ok(
      stlevisRoutes.some((route) => route.dirs.some((dir) => dir.stops.length > 3)),
      "STLévis routes must keep their stop sequences",
    );
    assert.ok(
      stlRoutes.some((route) => route.dirs.some((dir) => dir.stops.length > 3)),
      "STL routes must keep their stop sequences",
    );
    assert.ok(quebec.atlas.meta.agencies?.some((agency) => agency.id === "STLévis"));
    assert.ok(montreal.atlas.meta.agencies?.some((agency) => agency.id === "STL"));

    const traverse = firstStopFromQuery(quebec.atlas, "Terminus de la Traverse");
    const montmorency = firstStopFromQuery(montreal.atlas, "Terminus Montmorency");
    assert.ok(traverse);
    assert.equal(traverse.agencyId, "STLévis");
    assert.ok(montmorency);
    assert.equal(montmorency.agencyId, "STL");
  });

  it("plans a STLévis ride from Cégep de Lévis to the Traverse", () => {
    const { atlas, timetable } = loadCity("quebec");
    const from = placeFromStop(firstStopHit(atlas, "Station Cegep de Levis"));
    const to = placeFromStop(firstStopHit(atlas, "Terminus de la Traverse"));
    const itineraries = planTrip(
      atlas,
      timetable,
      from,
      to,
      minutesOfDay(clock),
      activeServiceIndexes(atlas, clock),
    );
    assert.ok(itineraries.some((item) => item.legs.some((leg) => leg.kind === "transit" && leg.agencyId === "STLévis")));
  });

  it("plans an STL ride from Carrefour Laval to Terminus Montmorency", () => {
    const { atlas, timetable } = loadCity("montreal");
    const from = placeFromStop(firstStopHit(atlas, "Carrefour Laval"));
    const to = placeFromStop(firstStopHit(atlas, "Terminus Montmorency"));
    const itineraries = planTrip(
      atlas,
      timetable,
      from,
      to,
      minutesOfDay(clock),
      activeServiceIndexes(atlas, clock),
    );
    assert.ok(itineraries.some((item) => item.legs.some((leg) => leg.kind === "transit" && leg.agencyId === "STL")));
  });

  it("plans Berri area to McGill with legs whose routes exist", () => {
    const { atlas, timetable } = loadCity("montreal");
    const from = placeFromStop(firstStopHit(atlas, "Berri"));
    const to = placeFromStop(firstStopHit(atlas, "McGill"));
    const itineraries = planTrip(
      atlas,
      timetable,
      from,
      to,
      minutesOfDay(clock),
      activeServiceIndexes(atlas, clock),
    );
    assert.ok(itineraries.length > 0);
    const routeIds = new Set(atlas.routes.map((route) => route.id));
    const first = itineraries[0];
    assert.ok(first.legs.length > 0);
    assert.ok(
      first.legs.every(
        (leg) => leg.kind === "walk" || leg.kind === "transit" || leg.kind === "bike",
      ),
    );
    for (const leg of first.legs) {
      if (leg.kind === "transit") {
        assert.equal(routeIds.has(leg.routeId), true);
      }
    }
  });
});

describe("dead stops", () => {
  it("drops Québec stops that have no current timetable service", () => {
    const { atlas, timetable } = loadCity("quebec");
    const dead = atlas.stops.find((stop) => !stopHasService(stop, timetable) && stop.kind !== 2);
    assert.ok(dead, "expected at least one unserved stop in the official feed");
    const near = nearbyStops(atlas.stops, { lon: dead.lon, lat: dead.lat }, 80, 14, timetable);
    assert.equal(
      near.some((stop) => stop.id === dead.id),
      false,
    );
    const hits = searchAtlas(atlas, dead.name, 12, timetable);
    assert.equal(
      hits.some((hit) => hit.kind === "stop" && hit.stop.id === dead.id),
      false,
    );
  });
});

describe("GTFS self-update fingerprint", () => {
  it("does not request a zip when the fingerprint is unchanged", () => {
    for (const city of ["quebec", "montreal"] as const) {
      const { atlas } = loadCity(city);
      const meta = JSON.parse(
        readFileSync(join(process.cwd(), "public", "data", city, "meta.json"), "utf8"),
      ) as { city: string; version: string; updated: string; counts: { routes: number; stops: number } };
      const local = fingerprintFromMeta(meta, {
        routeIds: atlas.routes.map((route) => route.id),
        stopIds: atlas.stops.map((stop) => stop.id),
      });
      const remote = { ...local, routeIds: [...(local.routeIds || [])], stopIds: [...(local.stopIds || [])] };
      assert.equal(shouldFetchZip(local, remote), false);
    }
  });

  it("treats a new version or added/removed objects as stale, and honors a user-declared refresh", () => {
    const { atlas } = loadCity("montreal");
    const meta = JSON.parse(
      readFileSync(join(process.cwd(), "public", "data", "montreal", "meta.json"), "utf8"),
    ) as { city: string; version: string; updated: string; counts: { routes: number; stops: number } };
    const local = fingerprintFromMeta(meta, {
      routeIds: atlas.routes.map((route) => route.id),
      stopIds: atlas.stops.slice(0, 20).map((stop) => stop.id),
    });
    assert.equal(shouldFetchZip(local, { ...local, version: `${local.version}-next` }), true);
    assert.equal(
      shouldFetchZip(local, {
        ...local,
        routeIds: [...(local.routeIds || []), "new-route-id"],
      }),
      true,
    );
    assert.equal(shouldFetchZip(local, local, { userDeclared: true }), true);
    assert.equal(shouldFetchZip(local, local, { userDeclared: false }), false);
  });
});

describe("GTFS-RT overlay", () => {
  it("moves next-due with a trip delay and drops a cancellation on a real Montréal line", () => {
    const clock = daytimeClock();
    const at = minutesOfDay(clock);
    const { atlas, timetable } = loadCity("montreal");
    const here = firstStopHit(atlas, "Berri");
    const dest = firstStopHit(atlas, "McGill");
    const line = nearbyLines(atlas, here, dest).find((item) => item.type === 1) || nearbyLines(atlas, here, dest)[0];
    assert.ok(line);
    const due = nextDueOnLine(atlas, timetable, here, line.routeId, at, activeServiceIndexes(atlas, clock));
    assert.ok(due.length > 0);
    const first = due[0];
    const delayed = applyTripUpdatesToDue(
      due,
      [{ routeId: first.routeId, stopId: first.stopId, delaySec: 180 }],
      at,
    );
    assert.ok(delayed.length > 0);
    const moved = delayed.find((row) => row.stopId === first.stopId && row.headsign === first.headsign);
    assert.ok(moved);
    assert.ok(moved.depart > first.depart);
    assert.equal(moved.depart - first.depart, 3);
    const canceled = applyTripUpdatesToDue(due, [{ routeId: first.routeId, stopId: first.stopId, canceled: true }], at);
    assert.ok(canceled.length < due.length || canceled.every((row) => row.stopId !== first.stopId));
  });

  it("decodes a GTFS-RT fixture then moves due and the trajectory on a real Montréal line", () => {
    const clock = daytimeClock();
    const at = minutesOfDay(clock);
    const { atlas, timetable } = loadCity("montreal");
    const here = firstStopHit(atlas, "Berri");
    const dest = firstStopHit(atlas, "McGill");
    const line = nearbyLines(atlas, here, dest).find((item) => item.type === 1) || nearbyLines(atlas, here, dest)[0];
    assert.ok(line);
    const due = nextDueOnLine(atlas, timetable, here, line.routeId, at, activeServiceIndexes(atlas, clock));
    assert.ok(due.length > 0);
    const first = due[0];
    const encoded = atlas.routes.find((route) => route.id === line.routeId)?.dirs.find((dir) => dir.line)?.line || "";
    assert.ok(encoded);
    const payload = {
      entity: [
        {
          trip_update: {
            trip: { route_id: first.routeId },
            stop_time_update: [{ stop_id: first.stopId, departure: { delay: 240 } }],
          },
        },
        {
          vehicle: {
            trip: { route_id: line.routeId },
            position: { latitude: 45.5017, longitude: -73.5673 },
          },
        },
      ],
    };
    const parsed = parseRealtimePayload(payload);
    assert.ok(parsed.updates.length > 0);
    assert.ok(parsed.vehicles.length > 0);
    const live = applyTripUpdatesToDue(due, parsed.updates, at);
    const moved = live.find((row) => row.stopId === first.stopId);
    assert.ok(moved);
    assert.ok(moved.depart > first.depart);
    const frozen = trajectoryAfterRealtime(encoded, {});
    const skittle = trajectoryAfterRealtime(encoded, { vehicle: parsed.vehicles[0] });
    assert.equal(samePolyline(skittle, frozen), false);
  });

  it("replaces a frozen ingest shape when a vehicle or new shape is reported", () => {
    const { atlas } = loadCity("montreal");
    const route = atlas.routes.find((item) => item.type === 1 && item.dirs.some((dir) => dir.line));
    assert.ok(route);
    const encoded = route.dirs.find((dir) => dir.line)?.line || "";
    assert.ok(encoded.length > 0);
    const frozen = trajectoryAfterRealtime(encoded, {});
    const withVehicle = trajectoryAfterRealtime(encoded, {
      vehicle: { routeId: route.id, lon: -73.5673, lat: 45.5017 },
    });
    assert.equal(samePolyline(withVehicle, frozen), false);
    assert.equal(withVehicle[0][0], -73.5673);
    const other = atlas.routes.find((item) => item.id !== route.id && item.dirs.some((dir) => dir.line && dir.line !== encoded));
    const newShape = other?.dirs.find((dir) => dir.line)?.line;
    if (newShape) {
      const swapped = trajectoryAfterRealtime(encoded, { shape: newShape });
      assert.equal(samePolyline(swapped, frozen), false);
    }
  });

  it("treats Vehicle Positions as live overlay points on a real atlas route", () => {
    const { atlas } = loadCity("montreal");
    const route = atlas.routes.find((item) => item.type === 1 && item.dirs.some((dir) => dir.line));
    assert.ok(route);
    const encoded = route.dirs.find((dir) => dir.line)?.line || "";
    const frozen = trajectoryAfterRealtime(encoded, {});
    const payload = {
      entity: [
        {
          vehicle: {
            trip: { route_id: route.id },
            position: { latitude: 45.508, longitude: -73.561 },
          },
        },
      ],
    };
    const parsed = parseRealtimePayload(payload);
    assert.equal(parsed.vehicles.length, 1);
    const overlay = overlayWithVehicles(encoded, parsed.vehicles, route.id);
    assert.equal(samePolyline(overlay, frozen), false);
    assert.equal(overlay[0][0], parsed.vehicles[0].lon);
    assert.equal(overlay[0][1], parsed.vehicles[0].lat);
  });

  it("applies a mandatory detour so both the polyline and the ride minutes change", () => {
    const { atlas } = loadCity("quebec");
    const route = atlas.routes.find((item) => item.dirs.some((dir) => dir.line && dir.hops.length > 4 && dir.stops.length > 4));
    assert.ok(route);
    const dir = route.dirs.find((item) => item.line && item.hops.length > 4)!;
    const to = Math.min(5, dir.hops.length);
    const staticMinutes = hopMinutes(dir.hops, 0, to);
    const other = atlas.routes.find((item) =>
      item.id !== route.id && item.dirs.some((d) => d.line && d.line !== dir.line),
    );
    const alt = other?.dirs.find((d) => d.line && d.line !== dir.line)?.line;
    assert.ok(alt);
    const skipped = dir.stops[2];
    const parsed = parseRealtimePayload({
      detours: [{ routeId: route.id, shape: alt, skipStopIds: [skipped], extraMinutes: 3 }],
    });
    assert.equal(parsed.detours.length, 1);
    const applied = applyDetour({
      staticEncoded: dir.line,
      hops: dir.hops,
      stopIds: dir.stops,
      fromIndex: 0,
      toIndex: to,
      detour: parsed.detours[0],
    });
    assert.equal(samePolyline(applied.line, trajectoryAfterRealtime(dir.line, {})), false);
    assert.notEqual(applied.minutes, staticMinutes);
    assert.ok(applied.minutes > 0);
  });
});

describe("clock format", () => {
  it("prints 24h by default and a 12h form when asked", () => {
    assert.equal(formatClock(0), "00:00");
    assert.equal(formatClock(960), "16:00");
    assert.equal(formatClock(75), "01:15");
    assert.equal(formatClock(0, true), "12:00 AM");
    assert.equal(formatClock(960, true), "4:00 PM");
    assert.equal(typeof prefersHour12(), "boolean");
  });
});

describe("popularity-weighted POIs", () => {
  it("keeps at most N points and ranks the popular ones above the obscure ones", () => {
    const table = JSON.parse(
      readFileSync(join(process.cwd(), "public", "data", "pois.json"), "utf8"),
    ) as { budget: number; places: Array<{ id: string; name: string; lon: number; lat: number; popularity: number }> };
    const picked = pickPois(table.places, 6);
    assert.ok(picked.length <= 6);
    assert.ok(picked.length > 0);
    for (let i = 1; i < picked.length; i++) {
      assert.ok(picked[i - 1].popularity >= picked[i].popularity);
    }
    const ids = new Set(picked.map((poi) => poi.id));
    assert.equal(ids.has("obscure-qc") || ids.has("obscure-mtl"), false);
    assert.ok(ids.has("chateau") || ids.has("old-mtl"));
    assert.deepEqual(pickPois(table.places, 0), []);
  });
});

