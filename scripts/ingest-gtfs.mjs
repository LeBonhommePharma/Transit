#!/usr/bin/env node
/**
 * Build a compact linked atlas from official GTFS.
 * Québec = RTC + STLévis. Montréal = STM + STL Laval.
 *
 * Secondary feeds prefix every GTFS id so route 11 (RTC) and route 11
 * (STLévis) never collide. Primary feed ids stay unprefixed.
 */
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, ".cache", "gtfs");
const OUT = join(ROOT, "public", "data");
const MAX_ZIP_BYTES = 128 * 1024 * 1024;
const MAX_UNZIPPED_BYTES = 1_024 * 1024 * 1024;
const MAX_EXTRACTED_FILES = 2_000;
const MAX_SYNC_CSV_BYTES = 128 * 1024 * 1024;
const MAX_CSV_BYTES = 512 * 1024 * 1024;
const MAX_CSV_LINE_BYTES = 2 * 1024 * 1024;
const MAX_STREAM_ROWS = 10_000_000;
const MAX_SYNC_ROWS = 1_000_000;
const MAX_SHAPE_POINTS_PER_LINE = 10_000;

const REGIONS = [
  {
    city: "quebec",
    name: "Québec",
    center: [-71.2082, 46.8131],
    zoom: 12.4,
    feeds: [
      {
        slug: "rtc",
        zip: "rtc.zip",
        url: "https://cdn.rtcquebec.ca/Site_Internet/DonneesOuvertes/googletransit.zip",
        attribution:
          "Intègre les Informations publiques du Réseau de transport de la Capitale.",
        licenseUrl: "https://www.rtcquebec.ca/donnees-ouvertes",
        agencyHint: "RTC",
        prefix: "",
      },
      {
        slug: "stlevis",
        zip: "stlevis.zip",
        url: "https://www.stlevis.ca/sites/default/files/public/assets/gtfs/transit/gtfs_stlevis.zip",
        attribution: "Horaires et parcours STLévis, données ouvertes.",
        licenseUrl: "https://www.stlevis.ca/stlevis/donnees-ouvertes",
        agencyHint: "STLévis",
        prefix: "stlevis:",
      },
    ],
  },
  {
    city: "montreal",
    name: "Montréal",
    center: [-73.5673, 45.5017],
    zoom: 12.1,
    feeds: [
      {
        slug: "stm",
        zip: "stm.zip",
        url: "https://www.stm.info/sites/default/files/gtfs/gtfs_stm.zip",
        attribution: "Horaires et parcours STM, données ouvertes.",
        licenseUrl: "https://www.stm.info/fr/a-propos/developpeurs",
        agencyHint: "STM",
        prefix: "",
      },
      {
        slug: "stl",
        zip: "stl.zip",
        url: "https://stlaval.ca/datas/opendata/GTF_STL.zip",
        attribution: "Horaires et parcours STL Laval, données ouvertes.",
        licenseUrl: "https://stlaval.ca/affaires/donnees-ouvertes",
        agencyHint: "STL",
        prefix: "stl:",
      },
    ],
  },
];

function prefixed(prefix, id) {
  if (!id) return id;
  if (!prefix) return id;
  return `${prefix}${id}`;
}

function parseCsvLine(line) {
  if (line.length > MAX_CSV_LINE_BYTES) throw new Error("GTFS row too large");
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
      if (out.length > 256) throw new Error("GTFS row has too many fields");
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  if (out.length > 256) throw new Error("GTFS row has too many fields");
  return out;
}

function readCsvSync(path) {
  if (!existsSync(path)) return { headers: [], rows: [] };
  if (statSync(path).size > MAX_SYNC_CSV_BYTES) throw new Error(`GTFS file too large for bounded sync read: ${path}`);
  const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length > MAX_SYNC_ROWS) throw new Error(`GTFS row count too large for sync read: ${path}`);
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
  if (statSync(path).size > MAX_CSV_BYTES) throw new Error(`GTFS file too large: ${path}`);
  const stream = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let headers = null;
  let rows = 0;
  for await (const raw of rl) {
    if (!raw) continue;
    if (raw.length > MAX_CSV_LINE_BYTES) throw new Error(`GTFS row too large: ${path}`);
    if (!headers) {
      headers = parseCsvLine(raw.replace(/^\uFEFF/, "")).map((h) => h.trim());
      continue;
    }
    const cols = parseCsvLine(raw);
    const row = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = (cols[j] ?? "").trim();
    rows += 1;
    if (rows > MAX_STREAM_ROWS) throw new Error(`GTFS row count too large: ${path}`);
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

const FORCE = process.argv.includes("--force") || process.env.RIVE_FORCE_INGEST === "1";

function ensureZip(feed) {
  mkdirSync(CACHE, { recursive: true });
  const zipPath = join(CACHE, feed.zip);
  const dir = join(CACHE, feed.slug);
  if (FORCE) {
    console.log(`Refreshing ${feed.slug} from official zip…`);
    rmSync(zipPath, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
  if (!existsSync(zipPath)) {
    console.log(`Downloading ${feed.slug}…`);
    execFileSync(
      "curl",
      ["-L", "--fail", "--retry", "3", "--max-filesize", String(MAX_ZIP_BYTES), "--proto", "=https", "--proto-redir", "=https", "-o", zipPath, feed.url],
      {
      stdio: "inherit",
      },
    );
  }
  if (statSync(zipPath).size > MAX_ZIP_BYTES) throw new Error(`GTFS archive too large: ${zipPath}`);
  if (existsSync(join(dir, "routes.txt"))) {
    assertSafeExtractedDir(dir);
    return dir;
  }
  validateZipArchive(zipPath);
  const tempDir = join(CACHE, `${feed.slug}.tmp-${process.pid}-${Date.now()}`);
  rmSync(tempDir, { recursive: true, force: true });
  mkdirSync(tempDir, { recursive: true });
  try {
    execFileSync("unzip", ["-q", zipPath, "-d", tempDir], { stdio: "inherit" });
    assertSafeExtractedDir(tempDir);
    if (!existsSync(join(tempDir, "routes.txt"))) throw new Error(`GTFS archive missing routes.txt: ${feed.slug}`);
    rmSync(dir, { recursive: true, force: true });
    renameSync(tempDir, dir);
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
  return dir;
}

function validateZipArchive(zipPath) {
  const names = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" })
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length > MAX_EXTRACTED_FILES) throw new Error(`GTFS archive has too many entries: ${zipPath}`);
  for (const name of names) {
    if (name.endsWith("/")) continue;
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error(`Unsafe GTFS archive entry: ${name}`);
  }
  const listing = execFileSync("unzip", ["-l", zipPath], { encoding: "utf8" });
  let total = 0;
  for (const line of listing.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+(.+)$/);
    if (!match) continue;
    total += Number(match[1]);
    if (total > MAX_UNZIPPED_BYTES) throw new Error(`GTFS archive expands too far: ${zipPath}`);
  }
}

function assertSafeExtractedDir(root) {
  const base = resolve(root);
  let files = 0;
  let bytes = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const rel = relative(base, resolve(path));
      if (!rel || rel.startsWith("..") || resolve(base, rel) !== resolve(path)) {
        throw new Error(`Unsafe extracted path: ${path}`);
      }
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || stat.isBlockDevice() || stat.isCharacterDevice() || stat.isSocket()) {
        throw new Error(`Unsafe extracted entry type: ${path}`);
      }
      if (stat.isDirectory()) {
        walk(path);
        continue;
      }
      if (!stat.isFile()) throw new Error(`Unsupported extracted entry: ${path}`);
      files += 1;
      bytes += stat.size;
      if (files > MAX_EXTRACTED_FILES || bytes > MAX_UNZIPPED_BYTES) {
        throw new Error(`Extracted GTFS data exceeds limits: ${root}`);
      }
    }
  };
  walk(base);
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

async function ingestFeed(region, feed) {
  const dir = ensureZip(feed);
  const p = (id) => prefixed(feed.prefix, id);
  console.log(`\nIngest ${region.name} / ${feed.agencyHint} (${feed.slug})`);

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
      id: p(row.route_id),
      shortName: row.route_short_name || row.route_id,
      longName: row.route_long_name || row.route_desc || "",
      type: Number(row.route_type || 3),
      color: hexColor(row.route_color, row.route_type === "1" ? "#00B300" : "#013888"),
      textColor: hexColor(row.route_text_color, "#FFFFFF"),
      agencyId: feed.agencyHint,
      agencyName: agency.agency_name || feed.agencyHint,
      dirs: [],
    };
    routes.push(route);
    routeById.set(route.id, route);
  }

  const trips = new Map();
  const shapeVotes = new Map();
  const headsignVotes = new Map();
  for (const row of tripRows) {
    const routeId = p(row.route_id);
    if (!routeById.has(routeId)) continue;
    const dir = Number(row.direction_id || 0) ? 1 : 0;
    const shapeId = p(row.shape_id || "");
    const headsign = row.trip_headsign || "";
    trips.set(p(row.trip_id), {
      routeId,
      serviceId: p(row.service_id),
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
    const shapeId = p(row.shape_id);
    if (!wantedShapes.has(shapeId)) return;
    const lat = Number(row.shape_pt_lat);
    const lon = Number(row.shape_pt_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const seq = Number(row.shape_pt_sequence || 0);
    const list = shapePoints.get(shapeId) || [];
    if (list.length >= MAX_SHAPE_POINTS_PER_LINE) return;
    list.push([seq, lon, lat]);
    shapePoints.set(shapeId, list);
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
    const trip = trips.get(p(row.trip_id));
    if (!trip) return;
    const stopId = p(row.stop_id);
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
    const tripId = p(row.trip_id);
    if (wantedTripStops.has(tripId)) {
      const arr = toMinutes(row.arrival_time || row.departure_time);
      const list = tripStopSeq.get(tripId) || [];
      list.push({ stopId, seq, min: arr ?? dep ?? 0 });
      tripStopSeq.set(tripId, list);
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
    const parent = p(row.parent_station) || undefined;
    if (parent) {
      const kids = childrenOf.get(parent) || [];
      kids.push(p(row.stop_id));
      childrenOf.set(parent, kids);
    }
    const ownRoutes = [...(stopRouteSet.get(p(row.stop_id)) || [])];
    stops.push({
      id: p(row.stop_id),
      code: row.stop_code || undefined,
      name: row.stop_name,
      lat: Math.round(lat * 1e6) / 1e6,
      lon: Math.round(lon * 1e6) / 1e6,
      parent,
      kind,
      wheel: Number(row.wheelchair_boarding || 0),
      agencyId: feed.agencyHint,
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
      id: p(row.service_id),
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
      id: p(row.service_id),
      date: row.date,
      type: Number(row.exception_type || 1),
    }));

  const transfers = transferRows
    .filter((row) => row.from_stop_id && row.to_stop_id)
    .map((row) => ({
      from: p(row.from_stop_id),
      to: p(row.to_stop_id),
      type: Number(row.transfer_type || 0),
      sec: Number(row.min_transfer_time || 0),
    }));

  const meta = {
    city: region.city,
    name: region.name,
    agencyId: feed.agencyHint,
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
    center: region.center,
    zoom: region.zoom,
    counts: {
      routes: routes.length,
      stops: stops.length,
      trips: trips.size,
      services: serviceIds.length,
      timetableStops: Object.keys(timetable).length,
    },
  };

  console.log(
    `  packed ${feed.slug}: ${routes.length} routes, ${stops.length} stops, ${serviceIds.length} services`,
  );
  return { meta, routes, stops, calendar, exceptions, transfers, services: serviceIds, timetable };
}

function mergePieces(region, pieces) {
  const routes = [];
  const stops = [];
  const calendar = [];
  const exceptions = [];
  const transfers = [];
  const services = [];
  const timetable = {};
  let serviceOffset = 0;

  for (const piece of pieces) {
    routes.push(...piece.routes);
    stops.push(...piece.stops);
    calendar.push(...piece.calendar);
    exceptions.push(...piece.exceptions);
    transfers.push(...piece.transfers);
    services.push(...piece.services);
    for (const [stopId, entries] of Object.entries(piece.timetable)) {
      const remapped = entries.map((entry) => ({
        ...entry,
        s: entry.s.map((idx) => idx + serviceOffset),
      }));
      if (timetable[stopId]) timetable[stopId].push(...remapped);
      else timetable[stopId] = remapped;
    }
    serviceOffset += piece.services.length;
  }

  const primary = pieces[0].meta;
  const lastEnd = pieces
    .map((piece) => piece.meta.end)
    .filter(Boolean)
    .sort()
    .at(-1) || primary.end;
  const firstStart = pieces
    .map((piece) => piece.meta.start)
    .filter(Boolean)
    .sort()[0] || primary.start;

  return {
    meta: {
      ...primary,
      city: region.city,
      name: region.name,
      center: region.center,
      zoom: region.zoom,
      start: firstStart,
      end: lastEnd,
      attribution: pieces.map((piece) => piece.meta.attribution).join(" "),
      agencies: pieces.map((piece) => ({
        id: piece.meta.agencyId,
        name: piece.meta.agencyName,
        url: piece.meta.agencyUrl,
        attribution: piece.meta.attribution,
        licenseUrl: piece.meta.licenseUrl,
        sourceUrl: piece.meta.sourceUrl,
      })),
      counts: {
        routes: routes.length,
        stops: stops.length,
        trips: pieces.reduce((n, piece) => n + piece.meta.counts.trips, 0),
        services: services.length,
        timetableStops: Object.keys(timetable).length,
      },
    },
    routes,
    stops,
    calendar,
    exceptions,
    transfers,
    services,
    timetable,
  };
}

function writeJson(path, data) {
  const json = JSON.stringify(data);
  writeFileSync(path, json);
  const mb = (Buffer.byteLength(json) / 1024 / 1024).toFixed(2);
  console.log(`  ${path.replace(ROOT + "/", "")}  ${mb} MB`);
}

const metas = [];
for (const region of REGIONS) {
  const pieces = [];
  for (const feed of region.feeds) {
    pieces.push(await ingestFeed(region, feed));
  }
  const merged = mergePieces(region, pieces);
  const dest = join(OUT, region.city);
  mkdirSync(dest, { recursive: true });
  writeJson(join(dest, "atlas.json"), {
    meta: merged.meta,
    routes: merged.routes,
    stops: merged.stops,
    calendar: merged.calendar,
    exceptions: merged.exceptions,
    transfers: merged.transfers,
    services: merged.services,
  });
  writeJson(join(dest, "timetable.json"), merged.timetable);
  writeJson(join(dest, "meta.json"), merged.meta);
  console.log(
    `  wrote ${region.city}: ${merged.routes.length} routes, ${merged.stops.length} stops, ${merged.services.length} services`,
  );
  metas.push(merged.meta);
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
