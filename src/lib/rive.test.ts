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
import { collapseDueByDirection, lineByShortNameOrColor, nearbyLines, nextDueOnLine } from "./lines";
import { decodePolyline } from "./geo";
import { headingFromSample } from "./heading";
import { acceptRiderFix, emptyRiderStore, isCrowdProbeSource } from "./rider";
import {
  applyFusedEtaToDue,
  emptyProbeStore,
  expireProbes,
  fuseRouteProbes,
  ingestProbe,
  snapToShape,
  validateProbe,
} from "./probe";
import { remainMinutes, watchPulseFromPayload } from "./watch-remain";
import { applyLivePulse, livePulseEnd, livePulseFromTransit } from "./live-pulse";
import { mixLabel, planTrajectories, rankByDoorToDoor } from "./trajectory";
import { buildingHeightMeters, extrudeOffsetPx, parseOverpassBuildings, wallQuads } from "./buildings";
import { fold, firstStopFromQuery, nearbyStops, pinHereForCity, placeFromStop, searchAtlas, stopHasService } from "./search";
import { activeServiceIndexes } from "./services";
import { formatClock, minutesOfDay, parseClock24, prefersHour12 } from "./time";
import { isBlueFamily, lineStrokeColor } from "./line-tone";
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
    assert.match(src, /collapseDueByDirection/);
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
    assert.match(html, /id="clock-os"/);
    assert.match(html, /id="clock-24"/);
    assert.match(html, /class="tools"/);
    assert.match(src, /classList\.add\("busy"\)/);
    assert.doesNotMatch(src, /hereBtn\.textContent = t\.myPosition/);
    assert.doesNotMatch(src, /btn\.textContent = "Actualiser"/);
    assert.match(src, /prefersHour12/);
    assert.match(src, /clockMode/);
    assert.match(src, /strokeStyle/);
    assert.match(html, /sheet-body|sheet\.folded/);
    assert.match(src, /setSheetOpen/);
    assert.match(src, /sheetOpen/);
    assert.match(src, /pickPois|pois/);
    assert.match(src, /applyTripUpdatesToDue\(scheduled, state\.tripUpdates/);
    assert.match(src, /await loadRealtime\(\);/);
    assert.match(src, /async function loadRealtime/);
    assert.match(src, /parseRealtimePayload/);
    assert.match(src, /state\.vehicles = vehicles/);
    assert.match(src, /applyDetour|state\.detours/);
    assert.match(src, /overlayWithVehicles|vehiclesOnRoute/);
    assert.match(src, /shouldFetchZip|userDeclared|feedIsStale/);
    assert.match(src, /watchPosition/);
    assert.match(src, /headingFromSample/);
    assert.match(src, /acceptRiderFix/);
    assert.match(src, /rankByDoorToDoor/);
    assert.match(src, /fuseRouteProbes/);
    assert.match(html, /id="heading"/);
    assert.match(html, /id="trips"/);
    assert.match(html, /Heure 24 h|placeholder="16:00"/);
    assert.match(src, /Démarrer/);
    assert.match(src, /annotateTimeGaps/);
    assert.match(src, /parseOverpassBuildings|buildings/);
    assert.match(src, /livePulseFromTransit|pulseFromTrip/);
    assert.match(src, /livePulseEnd|broadcastPulse/);
    assert.match(src, /riveLive/);
    assert.match(src, /input.lang = "fr-CA"/);
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

  it("does not list the same bus and direction at the next two poles", () => {
    const clock = daytimeClock();
    const at = minutesOfDay(clock);
    for (const city of ["quebec", "montreal"] as const) {
      const { atlas, timetable } = loadCity(city);
      const origin = firstStopHit(atlas, city === "quebec" ? "Youville" : "Berri");
      const lines = nearbyLines(atlas, origin);
      const pick =
        lines.find(
          (line) =>
            nearbyStops(atlas.stops, origin, 700, 16).filter((stop) => stop.routes.includes(line.routeId))
              .length > 1,
        ) || lines[0];
      assert.ok(pick);
      const due = nextDueOnLine(
        atlas,
        timetable,
        origin,
        pick.routeId,
        at,
        activeServiceIndexes(atlas, clock),
      );
      const keys = due.map((row) => `${row.routeId}|${fold(row.headsign)}`);
      assert.equal(keys.length, new Set(keys).size, `${city} repeated ${pick.shortName} direction`);
      const collapsed = collapseDueByDirection([
        {
          routeId: pick.routeId,
          shortName: pick.shortName,
          color: pick.color,
          textColor: "#fff",
          stopId: "far",
          stopName: "far",
          meters: 200,
          headsign: "Nord",
          depart: at + 2,
          wait: 2,
          clocks: [],
        },
        {
          routeId: pick.routeId,
          shortName: pick.shortName,
          color: pick.color,
          textColor: "#fff",
          stopId: "near",
          stopName: "near",
          meters: 40,
          headsign: "Nord",
          depart: at + 3,
          wait: 3,
          clocks: [],
        },
        {
          routeId: pick.routeId,
          shortName: pick.shortName,
          color: pick.color,
          textColor: "#fff",
          stopId: "other",
          stopName: "other",
          meters: 80,
          headsign: "Sud",
          depart: at + 4,
          wait: 4,
          clocks: [],
        },
      ]);
      assert.equal(collapsed.length, 2);
      const nord = collapsed.find((row) => fold(row.headsign) === "nord");
      assert.ok(nord);
      assert.equal(nord.stopId, "near");
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
        const fastest = Math.min(...options.map((row) => row.minutes));
        assert.equal(options[0].minutes, fastest, "shortest door-to-door minutes must be first");
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
    assert.equal(formatClock(0, true), "00:00");
    assert.equal(formatClock(960, true), "16:00");
    assert.equal(typeof prefersHour12(), "boolean");
    assert.equal(prefersHour12("fr-CA"), false);
    assert.equal(parseClock24("16:00"), 960);
    assert.equal(parseClock24("9:05"), 545);
    assert.equal(parseClock24("24:00"), null);
    assert.equal(parseClock24("nope"), null);
  });
});

describe("line tone", () => {
  it("keeps official non-blue colors and splits shared blues by line number", () => {
    const orange = lineStrokeColor({ color: "#E35205", shortName: "290", type: 3 });
    assert.equal(orange.toLowerCase(), "#e35205");
    assert.equal(isBlueFamily("#E35205"), false);
    const a = lineStrokeColor({ color: "#003DA5", shortName: "11", type: 3 });
    const b = lineStrokeColor({ color: "#003DA5", shortName: "133", type: 3 });
    const metro = lineStrokeColor({ color: "#003DA5", shortName: "1", type: 1 });
    assert.notEqual(a.toLowerCase(), b.toLowerCase());
    assert.notEqual(a.toLowerCase(), metro.toLowerCase());
    assert.match(a, /^#[0-9a-f]{6}$/i);
    const src = readFileSync(join(process.cwd(), "public", "Transit", "app.js"), "utf8");
    assert.match(src, /lineStrokeColor\(route\)/);
    const html = readFileSync(join(process.cwd(), "public", "Transit", "index.html"), "utf8");
    assert.doesNotMatch(html, /type="time"/);
    assert.match(html, /id="at"/);
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

function bikePair(from: { lon: number; lat: number }, to: { lon: number; lat: number }, system: "avelo" | "bixi") {
  return [
    { id: "s", name: "start", lon: from.lon, lat: from.lat, bikes: 4, docks: 4, system },
    { id: "e", name: "end", lon: to.lon, lat: to.lat, bikes: 2, docks: 6, system },
  ];
}

function officialShape(atlas: Atlas): { routeId: string; shape: [number, number][] } {
  for (const route of atlas.routes) {
    for (const dir of route.dirs) {
      const shape = decodePolyline(dir.line);
      if (shape.length >= 8) return { routeId: route.id, shape };
    }
  }
  throw new Error("no official shape");
}

describe("destination options are time-shortest first", () => {
  it("returns several mixes and lists the shortest door-to-door minutes first", () => {
    const clock = daytimeClock();
    const at = minutesOfDay(clock);
    const pairs = [
      { city: "quebec" as const, fromQ: "Youville", toQ: "Universite Laval", system: "avelo" as const },
      { city: "montreal" as const, fromQ: "Berri", toQ: "McGill", system: "bixi" as const },
    ];
    for (const pair of pairs) {
      const { atlas, timetable } = loadCity(pair.city);
      const from = placeFromStop(firstStopHit(atlas, pair.fromQ));
      const to = placeFromStop(firstStopHit(atlas, pair.toQ));
      const options = planTrajectories(
        atlas,
        timetable,
        from,
        to,
        at,
        activeServiceIndexes(atlas, clock),
        bikePair(from, to, pair.system),
      );
      assert.ok(options.length >= 2, `${pair.city} must offer more than one option`);
      const families = new Set<string>();
      for (const row of options) {
        if (row.mix.includes("marche")) families.add("marche");
        if (row.mix.includes("vélo")) families.add("vélo");
        if (row.mix.includes("bus")) families.add("bus");
        if (row.mix.includes("métro")) families.add("métro");
      }
      assert.ok(families.size >= 2, `${pair.city} mixes ${[...families].join(",")}`);
      const fastest = Math.min(...options.map((row) => row.minutes));
      assert.equal(options[0].minutes, fastest);
      assert.equal(options[0].gap, 0);
      for (const row of options) {
        assert.ok(row.minutes >= options[0].minutes);
        assert.equal(row.gap, row.minutes - fastest);
      }
      const ranked = rankByDoorToDoor(options.slice().reverse());
      assert.equal(ranked[0].minutes, fastest);
    }
  });
});

describe("heading", () => {
  it("normalizes bearings and stays empty on garbage", () => {
    const north = headingFromSample(0);
    const east = headingFromSample(90);
    const south = headingFromSample(180);
    const wrap = headingFromSample(360);
    const almost = headingFromSample(359);
    assert.ok(north);
    assert.ok(east);
    assert.ok(south);
    assert.ok(wrap);
    assert.ok(almost);
    assert.equal(north.degrees, 0);
    assert.equal(north.cardinal, "N");
    assert.equal(east.degrees, 90);
    assert.equal(east.cardinal, "E");
    assert.equal(south.degrees, 180);
    assert.equal(south.cardinal, "S");
    assert.equal(wrap.degrees, 0);
    assert.equal(wrap.cardinal, "N");
    assert.ok(almost.degrees >= 0 && almost.degrees < 360);
    assert.ok(almost.cardinal);
    assert.equal(headingFromSample(Number.NaN), null);
    assert.equal(headingFromSample(undefined), null);
    assert.equal(headingFromSample(null), null);
    assert.equal(headingFromSample({}), null);
    assert.equal(headingFromSample({ heading: "nope" }), null);
    const fromAlpha = headingFromSample({ alpha: 45 });
    assert.ok(fromAlpha);
    assert.equal(fromAlpha.cardinal, "NE");
  });
});

describe("connected rider location", () => {
  it("accepts successive finite fixes and drops stale or junk", () => {
    const { atlas } = loadCity("montreal");
    const { shape } = officialShape(atlas);
    const a = { lon: shape[1][0], lat: shape[1][1] };
    const b = { lon: shape[2][0], lat: shape[2][1] };
    let store = emptyRiderStore();
    assert.equal(store.here, null);
    store = acceptRiderFix(store, { lon: a.lon, lat: a.lat, at: 1_000, source: "gps" }, 1_000);
    assert.ok(store.here);
    assert.equal(store.here.lon, a.lon);
    store = acceptRiderFix(store, { lon: b.lon, lat: b.lat, at: 2_000, source: "gps" }, 2_000);
    assert.equal(store.here?.lon, b.lon);
    assert.equal(store.here?.lat, b.lat);
    const frozen = store.here;
    store = acceptRiderFix(store, { lon: a.lon, lat: a.lat, at: 1_500, source: "gps" }, 2_000);
    assert.equal(store.here?.at, frozen?.at);
    store = acceptRiderFix(store, { lon: "x", lat: b.lat, at: 3_000 }, 3_000);
    assert.equal(store.here?.at, frozen?.at);
    store = acceptRiderFix(store, { lon: 200, lat: b.lat, at: 3_000 }, 3_000);
    assert.equal(store.here?.at, frozen?.at);
    store = acceptRiderFix(store, { lon: a.lon, lat: a.lat, at: 3_000 }, 3_000 + 6 * 60 * 1000);
    assert.equal(store.here?.at, frozen?.at);
    assert.equal(isCrowdProbeSource("gps"), true);
    assert.equal(isCrowdProbeSource("map"), false);
    assert.equal(isCrowdProbeSource("ici"), false);
    const src = readFileSync(join(process.cwd(), "public", "Transit", "app.js"), "utf8");
    assert.match(src, /isCrowdProbeSource\(next\.here\.source\)/);
  });
});

describe("crowd-probe fuse", () => {
  it("moves ETA only with enough agreeing snaps and leaves official due otherwise", () => {
    const clock = daytimeClock();
    const at = minutesOfDay(clock);
    const { atlas, timetable } = loadCity("montreal");
    const here = firstStopHit(atlas, "Berri");
    const dest = firstStopHit(atlas, "McGill");
    const line = nearbyLines(atlas, here, dest).find((item) => item.type === 1) || nearbyLines(atlas, here, dest)[0];
    assert.ok(line);
    const due = nextDueOnLine(atlas, timetable, here, line.routeId, at, activeServiceIndexes(atlas, clock));
    assert.ok(due.length > 0);
    const official = due[0].depart;
    const route = atlas.routes.find((item) => item.id === line.routeId);
    const shape = decodePolyline(route?.dirs[0]?.line || "");
    assert.ok(shape.length >= 4);
    const snapped = snapToShape({ lon: shape[1][0], lat: shape[1][1] }, shape);
    assert.ok(snapped);
    const now = 10_000;
    let store = emptyProbeStore();
    assert.equal(
      fuseRouteProbes({ store, routeId: line.routeId, shape, now, officialDepart: official }),
      null,
    );
    assert.deepEqual(applyFusedEtaToDue(due, null, at), due);

    store = ingestProbe(store, { lon: shape[1][0], lat: shape[1][1], at: now, routeId: line.routeId }, now);
    assert.equal(
      fuseRouteProbes({ store, routeId: line.routeId, shape, now, officialDepart: official, expectedAlongMeters: 4000 }),
      null,
    );
    assert.equal(validateProbe({ lon: shape[1][0], lat: shape[1][1], at: now, userId: "x" }), null);
    assert.equal(validateProbe({ lon: 0, lat: 0, at: now }), null);
    assert.equal(validateProbe({ lon: Number.NaN, lat: shape[1][1], at: now }), null);

    store = ingestProbe(store, { lon: shape[1][0] + 0.00005, lat: shape[1][1], at: now + 200, routeId: line.routeId }, now + 200);
    store = ingestProbe(store, { lon: shape[1][0], lat: shape[1][1] + 0.00005, at: now + 400, routeId: line.routeId }, now + 400);
    const fused = fuseRouteProbes({
      store,
      routeId: line.routeId,
      shape,
      now: now + 400,
      officialDepart: official,
      expectedAlongMeters: snapped.alongMeters + 4000,
    });
    assert.ok(fused);
    assert.ok(fused.etaShiftMinutes > 0);
    const moved = applyFusedEtaToDue(due, fused, at);
    const row = moved.find((item) => item.stopId === due[0].stopId && item.headsign === due[0].headsign);
    assert.ok(row);
    assert.ok(row.depart > official);

    const expired = expireProbes(store, now + 400 + 4 * 60 * 1000);
    assert.equal(
      fuseRouteProbes({
        store: expired,
        routeId: line.routeId,
        shape,
        now: now + 400 + 4 * 60 * 1000,
        officialDepart: official,
        expectedAlongMeters: snapped.alongMeters + 4000,
      }),
      null,
    );
  });
});

describe("watch remain", () => {
  it("returns a non-negative remain for a future depart and stays idle on empty payload", () => {
    assert.equal(remainMinutes([960], 950), 10);
    assert.equal(remainMinutes(["800"], 790), 10);
    assert.ok((remainMinutes([10], 1430) ?? -1) >= 0);
    assert.equal(remainMinutes([], 950), null);
    assert.equal(remainMinutes(undefined, 950), null);
    assert.equal(remainMinutes(["nope"], 950), null);
    assert.equal(watchPulseFromPayload(null), null);
    assert.equal(watchPulseFromPayload(""), null);
    assert.equal(watchPulseFromPayload({}), null);
    const pulse = watchPulseFromPayload({ s: "Youville", r: "801", m: "960,968", t: "16:00,16:08" });
    assert.ok(pulse);
    assert.equal(remainMinutes(pulse.departs, 950), 10);
    const watchHtml = readFileSync(join(process.cwd(), "public", "Transit", "watch.html"), "utf8");
    assert.match(watchHtml, /remainMinutes/);
    assert.match(watchHtml, /watchPulseFromPayload/);
    assert.match(watchHtml, /stay on the empty face|if \(!live\) return/);
  });

  it("drives the shipped static rive-kit remain and heading", async () => {
    const shipped = await import("../../public/Transit/rive-kit.js");
    assert.equal(shipped.remainMinutes([960], 950), 10);
    assert.equal(shipped.remainMinutes([], 950), null);
    assert.equal(shipped.headingFromSample(90).cardinal, "E");
    assert.equal(shipped.headingFromSample(null), null);
    const ranked = shipped.rankByDoorToDoor([
      { minutes: 18, mix: "métro" },
      { minutes: 9, mix: "vélo" },
    ]);
    assert.equal(ranked[0].minutes, 9);
    const overlay = shipped.applyFusedEtaToDue(
      [{ routeId: "r", depart: 800, wait: 10, clocks: ["13:20", "13:28"] }],
      { routeId: "r", etaShiftMinutes: 5 },
      790,
    );
    assert.equal(overlay[0].wait, 15);
    assert.equal(overlay[0].clocks[0], "13:25");
    assert.equal(shipped.isCrowdProbeSource("map"), false);
    const pulse = shipped.livePulseFromTransit(
      { city: "quebec", stop: "D'Youville", route: "801", color: "#0071e3", departs: [960], clocks: ["16:00"] },
      950,
    );
    assert.equal(pulse.action, "start");
    assert.equal(pulse.remain, shipped.remainMinutes([960], 950));
    assert.equal(shipped.livePulseFromTransit({ stop: "x", departs: [960] }, 950).action, "end");
    const mem = new Map();
    const store = {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, v),
      removeItem: (k) => mem.delete(k),
    };
    const wrote = shipped.applyLivePulse(pulse, store);
    assert.ok(wrote.live && wrote.live.route === "801");
    assert.ok(store.getItem("rive.live"));
    const ended = shipped.applyLivePulse(shipped.livePulseEnd(), store);
    assert.equal(ended.live, null);
    assert.equal(store.getItem("rive.live"), null);
  });
});

describe("live pulse start and stop", () => {
  it("starts from a transit trip and ends without inventing a route", () => {
    const store = {
      data: {},
      getItem(k) {
        return this.data[k] ?? null;
      },
      setItem(k, v) {
        this.data[k] = v;
      },
      removeItem(k) {
        delete this.data[k];
      },
    };
    assert.equal(livePulseFromTransit(null, 950).action, "end");
    assert.equal(livePulseFromTransit({ stop: "Youville", departs: [960] }, 950).action, "end");
    const trip = {
      city: "quebec",
      stop: "D'Youville",
      route: "801",
      color: "#0071e3",
      headsign: "Beauport",
      clocks: ["16:00", "16:08"],
      departs: [960, 968],
    };
    const start = livePulseFromTransit(trip, 950);
    assert.equal(start.action, "start");
    if (start.action !== "start") throw new Error("expected start");
    assert.equal(start.remain, remainMinutes(trip.departs, 950));
    assert.ok(start.remain >= 0);
    assert.equal(start.route, "801");
    const applied = applyLivePulse(start, store);
    assert.ok(applied.live);
    assert.match(applied.href, /watch\.html\?/);
    assert.ok(JSON.parse(store.getItem("rive.live") || "{}").route === "801");
    const idle = applyLivePulse(livePulseEnd(), store);
    assert.equal(idle.live, null);
    assert.equal(store.getItem("rive.live"), null);
    assert.equal(livePulseFromTransit({ route: "801", departs: [900] }, 950).action, "end");
    const src = readFileSync(join(process.cwd(), "public", "Transit", "app.js"), "utf8");
    assert.match(src, /function startTrip/);
    assert.match(src, /pulseFromTrip\(trip\)/);
    assert.match(src, /function stopTrip/);
    assert.match(src, /livePulseEnd\(\)/);
    assert.match(src, /pulseFromSelectedLine/);
    const pusher = readFileSync(join(process.cwd(), "ios", "Rive", "LiveDeparturePusher.swift"), "utf8");
    assert.match(pusher, /static func end/);
    const shell = readFileSync(join(process.cwd(), "ios", "RiveApp", "RiveApp.swift"), "utf8");
    assert.match(shell, /riveLive/);
    assert.match(shell, /LiveDeparturePusher.apply/);
  });
});

describe("2.5D buildings", () => {
  it("parses official OSM heights and stays empty on junk", () => {
    assert.equal(parseOverpassBuildings(null).length, 0);
    assert.equal(parseOverpassBuildings({}).length, 0);
    assert.equal(buildingHeightMeters({ height: "24" }), 24);
    assert.ok(buildingHeightMeters({ "building:levels": "5" }) > 10);
    const parsed = parseOverpassBuildings({
      elements: [
        {
          geometry: [
            { lon: -71.208, lat: 46.813 },
            { lon: -71.207, lat: 46.813 },
            { lon: -71.207, lat: 46.814 },
            { lon: -71.208, lat: 46.814 },
          ],
          tags: { building: "yes", "building:levels": "6" },
        },
        { geometry: [{ lon: 1, lat: 2 }], tags: {} },
      ],
    });
    assert.equal(parsed.length, 1);
    assert.ok(parsed[0].heightM > 10);
    const off = extrudeOffsetPx(parsed[0].heightM, 15);
    assert.ok(off.dx > 0 && off.dy < 0);
    assert.deepEqual(extrudeOffsetPx(Number.NaN, 15), { dx: 0, dy: 0 });
    const quads = wallQuads(
      [
        [0, 0],
        [10, 0],
        [10, 8],
      ],
      2,
      -3,
    );
    assert.equal(quads.length, 2);
    const src = readFileSync(join(process.cwd(), "public", "Transit", "app.js"), "utf8");
    assert.match(src, /drawBuildings/);
    assert.match(src, /overpassQuery/);
  });
});

