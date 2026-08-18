#!/usr/bin/env node
/**
 * Build a compact linked atlas from official GTFS.
 * Quebec City = RTC, Montreal = STM.
 *
 * Sources:
 *   RTC  https://cdn.rtcquebec.ca/Site_Internet/DonneesOuvertes/googletransit.zip
 *   STM  https://www.stm.info/sites/default/files/gtfs/gtfs_stm.zip
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, ".cache", "gtfs");
const OUT = join(ROOT, "public", "data");

const FEEDS = [
  {
    city: "quebec",
    slug: "rtc",
    zip: "rtc.zip",
    url: "https://cdn.rtcquebec.ca/Site_Internet/DonneesOuvertes/googletransit.zip",
    attribution:
      "Intègre les Informations publiques du Réseau de transport de la Capitale.",
    licenseUrl: "https://www.rtcquebec.ca/donnees-ouvertes",
    center: [-71.2082, 46.8131],
    zoom: 12.4,
    name: "Québec",
    agencyHint: "RTC",
  },
  {
    city: "montreal",
    slug: "stm",
    zip: "stm.zip",
    url: "https://www.stm.info/sites/default/files/gtfs/gtfs_stm.zip",
    attribution: "Horaires et parcours STM, données ouvertes.",
    licenseUrl: "https://www.stm.info/fr/a-propos/developpeurs",
    center: [-73.5673, 45.5017],
    zoom: 12.1,
    name: "Montréal",
    agencyHint: "STM",
  },
];

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function readCsvSync(path) {
  if (!existsSync(path)) return { headers: [], rows: [] };
  const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const row = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = (cols[j] ?? "").trim();
    rows.push(row);
  }
  return { headers, rows };
}

async function readCsvStream(path, onRow) {
  if (!existsSync(path)) return;
  const stream = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let headers = null;
  for await (const raw of rl) {
    if (!raw) continue;
    if (!headers) {
      headers = parseCsvLine(raw.replace(/^\uFEFF/, "")).map((h) => h.trim());
      continue;
    }
    const cols = parseCsvLine(raw);
    const row = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = (cols[j] ?? "").trim();
    onRow(row);
  }
}

function toMinutes(t) {
  if (!t) return null;
  const parts = t.split(":");
  if (parts.length < 2) return null;
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  const s = Number(parts[2] || 0);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m + (s >= 30 ? 1 : 0);
}

function hexColor(value, fallback) {
  const clean = (value || "").replace(/[#\s]/g, "").toUpperCase();
  if (/^[0-9A-F]{6}$/.test(clean)) return `#${clean}`;
  return fallback;
}

function encodePolyline(coords, precision = 5) {
  const factor = 10 ** precision;
  let prevLat = 0;
  let prevLng = 0;
  let result = "";
  for (const [lng, lat] of coords) {
    const ilat = Math.round(lat * factor);
    const ilng = Math.round(lng * factor);
    result += encodeSigned(ilat - prevLat) + encodeSigned(ilng - prevLng);
    prevLat = ilat;
    prevLng = ilng;
  }
  return result;
}

function encodeSigned(value) {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let out = "";
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  out += String.fromCharCode(v + 63);
  return out;
}

function haversineMeters(a, b) {
  const R = 6371000;
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLng = ((b[0] - a[0]) * Math.PI) / 180;
  const la1 = (a[1] * Math.PI) / 180;
  const la2 = (b[1] * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function simplifyLine(coords, minMeters = 14) {
  if (coords.length < 3) return coords;
  const out = [coords[0]];
  for (let i = 1; i < coords.length - 1; i++) {
    if (haversineMeters(out[out.length - 1], coords[i]) >= minMeters) {
      out.push(coords[i]);
    }
  }
  out.push(coords[coords.length - 1]);
  return out;
}

function ensureZip(feed) {
  mkdirSync(CACHE, { recursive: true });
  const zipPath = join(CACHE, feed.zip);
  const dir = join(CACHE, feed.slug);
  if (!existsSync(zipPath)) {
    console.log(`Downloading ${feed.slug}…`);
    execFileSync("curl", ["-L", "--fail", "--retry", "3", "-o", zipPath, feed.url], {
      stdio: "inherit",
    });
  }
  if (!existsSync(join(dir, "routes.txt"))) {
    mkdirSync(dir, { recursive: true });
    execFileSync("unzip", ["-o", "-q", zipPath, "-d", dir], { stdio: "inherit" });
  }
  return dir;
}

function pickHeadsign(counts) {
  let best = "";
  let n = -1;
  for (const [name, c] of counts) {
    if (c > n) {
      best = name;
      n = c;
    }
  }
  return best;
}

async function ingestFeed(feed) {
  const dir = ensureZip(feed);
  console.log(`\nIngest ${feed.name} (${feed.slug})`);

  const agencyRows = readCsvSync(join(dir, "agency.txt")).rows;
  const feedInfo = readCsvSync(join(dir, "feed_info.txt")).rows[0] || {};
  const agency = agencyRows[0] || {};
  const routeRows = readCsvSync(join(dir, "routes.txt")).rows;
  const tripRows = readCsvSync(join(dir, "trips.txt")).rows;
  const stopRows = readCsvSync(join(dir, "stops.txt")).rows;
  const calendarRows = readCsvSync(join(dir, "calendar.txt")).rows;
  const exceptionRows = readCsvSync(join(dir, "calendar_dates.txt")).rows;
  const transferRows = readCsvSync(join(dir, "transfers.txt")).rows;

  const routes = [];
  const routeById = new Map();
  for (const row of routeRows) {
    const route = {
      id: row.route_id,
      shortName: row.route_short_name || row.route_id,
      longName: row.route_long_name || row.route_desc || "",
      type: Number(row.route_type || 3),
      color: hexColor(row.route_color, row.route_type === "1" ? "#00B300" : "#013888"),
      textColor: hexColor(row.route_text_color, "#FFFFFF"),
      dirs: [],
    };
    routes.push(route);
    routeById.set(route.id, route);
  }

  const trips = new Map();
  const shapeVotes = new Map();
  const headsignVotes = new Map();
  for (const row of tripRows) {
    const routeId = row.route_id;
    if (!routeById.has(routeId)) continue;
    const dir = Number(row.direction_id || 0) ? 1 : 0;
    const shapeId = row.shape_id || "";
    const headsign = row.trip_headsign || "";
    trips.set(row.trip_id, {
      routeId,
      serviceId: row.service_id,
      headsign,
      dir,
      shapeId,
    });
    const skey = `${routeId}|${dir}`;
    if (shapeId) {
      const votes = shapeVotes.get(skey) || new Map();
      votes.set(shapeId, (votes.get(shapeId) || 0) + 1);
      shapeVotes.set(skey, votes);
    }
    if (headsign) {
      const hv = headsignVotes.get(skey) || new Map();
      hv.set(headsign, (hv.get(headsign) || 0) + 1);
      headsignVotes.set(skey, hv);
    }
  }

  const wantedShapes = new Set();
  const chosenShape = new Map();
  for (const [skey, votes] of shapeVotes) {
    let best = "";
    let n = -1;
    for (const [id, c] of votes) {
      if (c > n) {
        best = id;
        n = c;
      }
    }
    if (best) {
      chosenShape.set(skey, best);
      wantedShapes.add(best);
    }
  }

  const shapePoints = new Map();
  await readCsvStream(join(dir, "shapes.txt"), (row) => {
    if (!wantedShapes.has(row.shape_id)) return;
    const lat = Number(row.shape_pt_lat);
    const lon = Number(row.shape_pt_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const seq = Number(row.shape_pt_sequence || 0);
    const list = shapePoints.get(row.shape_id) || [];
    list.push([seq, lon, lat]);
    shapePoints.set(row.shape_id, list);
  });

  const shapeLine = new Map();
  for (const [id, pts] of shapePoints) {
    pts.sort((a, b) => a[0] - b[0]);
    const line = simplifyLine(pts.map((p) => [p[1], p[2]]));
    shapeLine.set(id, encodePolyline(line));
  }

  const representativeTrip = new Map();
  for (const [tripId, trip] of trips) {
    const skey = `${trip.routeId}|${trip.dir}`;
    if (representativeTrip.has(skey)) continue;
    if (chosenShape.get(skey) && trip.shapeId !== chosenShape.get(skey)) continue;
    representativeTrip.set(skey, tripId);
  }

  const wantedTripStops = new Set(representativeTrip.values());
  const tripStopSeq = new Map();
  const timetableRaw = new Map();
  const stopRouteSet = new Map();

  let timeRows = 0;
  await readCsvStream(join(dir, "stop_times.txt"), (row) => {
    timeRows += 1;
    const trip = trips.get(row.trip_id);
    if (!trip) return;
    const stopId = row.stop_id;
    const dep = toMinutes(row.departure_time || row.arrival_time);
    const seq = Number(row.stop_sequence || 0);
    if (stopId && dep != null) {
      const key = `${trip.routeId}\t${trip.headsign}\t${trip.dir}`;
      let byStop = timetableRaw.get(stopId);
      if (!byStop) {
        byStop = new Map();
        timetableRaw.set(stopId, byStop);
      }
      let byKey = byStop.get(key);
      if (!byKey) {
        byKey = new Map();
        byStop.set(key, byKey);
      }
      let times = byKey.get(trip.serviceId);
      if (!times) {
        times = new Set();
        byKey.set(trip.serviceId, times);
      }
      times.add(dep);
      let routesForStop = stopRouteSet.get(stopId);
      if (!routesForStop) {
        routesForStop = new Set();
        stopRouteSet.set(stopId, routesForStop);
      }
      routesForStop.add(trip.routeId);
    }
    if (wantedTripStops.has(row.trip_id)) {
      const arr = toMinutes(row.arrival_time || row.departure_time);
      const list = tripStopSeq.get(row.trip_id) || [];
      list.push({ stopId, seq, min: arr ?? dep ?? 0 });
      tripStopSeq.set(row.trip_id, list);
    }
  });
  console.log(`  stop_times rows: ${timeRows.toLocaleString()}`);

  for (const route of routes) {
    for (const dir of [0, 1]) {
      const skey = `${route.id}|${dir}`;
      const tripId = representativeTrip.get(skey);
      const seq = (tripStopSeq.get(tripId) || []).slice().sort((a, b) => a.seq - b.seq);
      const hops = [];
      for (let i = 1; i < seq.length; i++) {
        hops.push(Math.max(0, seq[i].min - seq[i - 1].min));
      }
      if (!tripId && !chosenShape.has(skey)) continue;
      route.dirs.push({
        id: dir,
        headsign: pickHeadsign(headsignVotes.get(skey) || new Map()),
        line: shapeLine.get(chosenShape.get(skey)) || "",
        stops: seq.map((s) => s.stopId),
        hops,
      });
    }
  }

  const childrenOf = new Map();
  const stops = [];
  for (const row of stopRows) {
    const lat = Number(row.stop_lat);
    const lon = Number(row.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const kind = Number(row.location_type || 0);
    if (kind === 2) continue;
    const parent = row.parent_station || undefined;
    if (parent) {
      const kids = childrenOf.get(parent) || [];
      kids.push(row.stop_id);
      childrenOf.set(parent, kids);
    }
    const ownRoutes = [...(stopRouteSet.get(row.stop_id) || [])];
    stops.push({
      id: row.stop_id,
      code: row.stop_code || undefined,
      name: row.stop_name,
      lat: Math.round(lat * 1e6) / 1e6,
      lon: Math.round(lon * 1e6) / 1e6,
      parent,
      kind,
      wheel: Number(row.wheelchair_boarding || 0),
      routes: ownRoutes.sort(),
    });
  }

  for (const stop of stops) {
    if (stop.kind !== 1) continue;
    const kids = childrenOf.get(stop.id) || [];
    const union = new Set(stop.routes);
    for (const kid of kids) {
      for (const r of stopRouteSet.get(kid) || []) union.add(r);
    }
    stop.routes = [...union].sort();
    stop.children = kids;
  }

  const serviceIds = [];
  const serviceIndex = new Map();
  function idxService(id) {
    if (serviceIndex.has(id)) return serviceIndex.get(id);
    const i = serviceIds.length;
    serviceIds.push(id);
    serviceIndex.set(id, i);
    return i;
  }

  const timetable = {};
  for (const [stopId, byKey] of timetableRaw) {
    const entries = [];
    for (const [key, byService] of byKey) {
      const [routeId, headsign, dirStr] = key.split("\t");
      const signature = new Map();
      for (const [serviceId, timeSet] of byService) {
        const times = [...timeSet].sort((a, b) => a - b);
        const sig = times.join(",");
        const bucket = signature.get(sig) || { times, services: [] };
        bucket.services.push(idxService(serviceId));
        signature.set(sig, bucket);
      }
      for (const bucket of signature.values()) {
        entries.push({
          r: routeId,
          h: headsign,
          d: Number(dirStr),
          s: bucket.services.sort((a, b) => a - b),
          t: bucket.times,
        });
      }
    }
    entries.sort((a, b) => a.r.localeCompare(b.r) || a.h.localeCompare(b.h) || a.d - b.d);
    timetable[stopId] = entries;
  }

  const calendar = calendarRows
    .filter((row) => row.service_id)
    .map((row) => ({
      id: row.service_id,
      days: [
        Number(row.monday || 0),
        Number(row.tuesday || 0),
        Number(row.wednesday || 0),
        Number(row.thursday || 0),
        Number(row.friday || 0),
        Number(row.saturday || 0),
        Number(row.sunday || 0),
      ],
      start: row.start_date,
      end: row.end_date,
    }));

  const exceptions = exceptionRows
    .filter((row) => row.service_id && row.date)
    .map((row) => ({
      id: row.service_id,
      date: row.date,
      type: Number(row.exception_type || 1),
    }));

  const transfers = transferRows
    .filter((row) => row.from_stop_id && row.to_stop_id)
    .map((row) => ({
      from: row.from_stop_id,
      to: row.to_stop_id,
      type: Number(row.transfer_type || 0),
      sec: Number(row.min_transfer_time || 0),
    }));

  const meta = {
    city: feed.city,
    name: feed.name,
    agencyId: agency.agency_id || feed.agencyHint,
    agencyName: agency.agency_name || feed.agencyHint,
    agencyUrl: agency.agency_url || feed.licenseUrl,
    timezone: agency.agency_timezone || "America/Montreal",
    lang: agency.agency_lang || "fr",
    phone: agency.agency_phone || "",
    updated: feedInfo.feed_start_date || "",
    start: feedInfo.feed_start_date || "",
    end: feedInfo.feed_end_date || "",
    version: feedInfo.feed_version || "",
    attribution: feed.attribution,
    licenseUrl: feed.licenseUrl,
    sourceUrl: feed.url,
    center: feed.center,
    zoom: feed.zoom,
    counts: {
      routes: routes.length,
      stops: stops.length,
      trips: trips.size,
      services: serviceIds.length,
      timetableStops: Object.keys(timetable).length,
    },
  };

  const dest = join(OUT, feed.city);
  mkdirSync(dest, { recursive: true });
  const atlas = { meta, routes, stops, calendar, exceptions, transfers, services: serviceIds };
  writeJson(join(dest, "atlas.json"), atlas);
  writeJson(join(dest, "timetable.json"), timetable);
  writeJson(join(dest, "meta.json"), meta);
  console.log(
    `  wrote ${feed.city}: ${routes.length} routes, ${stops.length} stops, ${serviceIds.length} services`,
  );
  return meta;
}

function writeJson(path, data) {
  const json = JSON.stringify(data);
  writeFileSync(path, json);
  const mb = (Buffer.byteLength(json) / 1024 / 1024).toFixed(2);
  console.log(`  ${path.replace(ROOT + "/", "")}  ${mb} MB`);
}

const metas = [];
for (const feed of FEEDS) {
  metas.push(await ingestFeed(feed));
}
writeFileSync(
  join(OUT, "index.json"),
  JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      cities: metas,
    },
    null,
    2,
  ),
);
console.log("\nAtlas ready.");
