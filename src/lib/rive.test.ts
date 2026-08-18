import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Atlas, AtlasStop, Timetable } from "./atlas/types";
import { parseTransitQuery } from "./assist";
import { feedUrl, mergeStations } from "./bikeshare";
import { daytimeClock } from "./clock";
import { pickLocale } from "./i18n";
import { connectorWalk, departuresAtStop, planTrip } from "./planner";
import { resolveSearchAction } from "./search-submit";
import { fold, firstStopFromQuery, placeFromStop, searchAtlas } from "./search";
import { activeServiceIndexes } from "./services";
import { minutesOfDay } from "./time";

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

describe("planTrip", () => {
  const clock = daytimeClock();

  it("plans Youville area to Université Laval with legs whose routes exist", () => {
    const { atlas, timetable } = loadCity("quebec");
    const from = placeFromStop(firstStopHit(atlas, "Youville"));
    const to = placeFromStop(firstStopHit(atlas, "Universite Laval"));
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
