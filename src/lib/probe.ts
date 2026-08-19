import { readFileSync } from "node:fs";
import { join } from "node:path";
import { haversineMeters } from "./geo";
import type { LineDue } from "./lines";
import { formatClock } from "./time";

/** Anonymous rider sample. No name, no device id. */
export type ProbeSample = {
  lon: number;
  lat: number;
  at: number;
  routeId?: string;
  heading?: number;
};

export type ProbeStore = {
  samples: ProbeSample[];
};

export type FusedVehicle = {
  routeId: string;
  lon: number;
  lat: number;
  alongMeters: number;
  etaShiftMinutes: number;
  count: number;
};

export const PROBE_MAX_AGE_MS = 3 * 60 * 1000;
export const PROBE_MIN_AGREE = 3;
export const PROBE_SNAP_M = 90;
export const PROBE_AGREE_M = 130;
export const PROBE_CITY_RADIUS_M = 45_000;
export const PROBE_MAX_SAMPLES = 400;
export const PROBE_MAX_SHAPE_POINTS = 5_000;
export const PROBE_MAX_ROUTE_ID_LENGTH = 128;

type LonLat = { lon: number; lat: number };

function centersFromIndex(raw: unknown): LonLat[] {
  if (!raw || typeof raw !== "object") return [];
  const cities = (raw as { cities?: unknown }).cities;
  if (!Array.isArray(cities)) return [];
  const out: LonLat[] = [];
  for (const item of cities) {
    if (!item || typeof item !== "object") continue;
    const center = (item as { center?: unknown }).center;
    if (!Array.isArray(center) || center.length < 2) continue;
    const lon = Number(center[0]);
    const lat = Number(center[1]);
    if (Number.isFinite(lon) && Number.isFinite(lat)) out.push({ lon, lat });
  }
  return out;
}

const INDEX_CENTERS: LonLat[] = (() => {
  try {
    return centersFromIndex(JSON.parse(readFileSync(join(process.cwd(), "public", "data", "index.json"), "utf8")));
  } catch {
    return [];
  }
})();

const BUS_M_PER_MIN = 360;

function finiteCoord(value: unknown, maxAbs: number): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > maxAbs) return null;
  return n;
}

export function emptyProbeStore(): ProbeStore {
  return { samples: [] };
}

export function servedCenters(): LonLat[] {
  return INDEX_CENTERS.map((center) => ({ lon: center.lon, lat: center.lat }));
}

export function inServedRegion(lon: number, lat: number): boolean {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
  const here = { lon, lat };
  return INDEX_CENTERS.some((center) => haversineMeters(here, center) <= PROBE_CITY_RADIUS_M);
}

/** Drop identity-bearing fields and non-finite / out-of-city junk. */
export function validateProbe(raw: unknown, now?: number): ProbeSample | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (row.name != null || row.email != null || row.userId != null || row.deviceId != null) return null;
  const lon = finiteCoord(row.lon, 180);
  const lat = finiteCoord(row.lat, 90);
  const at = typeof row.at === "number" && Number.isFinite(row.at) ? row.at : Number(row.at);
  if (lon == null || lat == null || !Number.isFinite(at)) return null;
  if (!inServedRegion(lon, lat)) return null;
  const clock = typeof now === "number" && Number.isFinite(now) ? now : at;
  if (clock - at > PROBE_MAX_AGE_MS || at - clock > 30_000) return null;
  const routeId =
    typeof row.routeId === "string" && row.routeId.length <= PROBE_MAX_ROUTE_ID_LENGTH && row.routeId
      ? row.routeId
      : undefined;
  const heading = finiteCoord(row.heading, 10_000);
  return {
    lon,
    lat,
    at,
    routeId,
    heading: heading == null ? undefined : ((heading % 360) + 360) % 360,
  };
}

export function expireProbes(store: ProbeStore, now: number): ProbeStore {
  if (!Number.isFinite(now)) return { samples: [] };
  return { samples: store.samples.filter((s) => now - s.at <= PROBE_MAX_AGE_MS && now - s.at >= 0) };
}

export function ingestProbe(store: ProbeStore, raw: unknown, now?: number): ProbeStore {
  const sample = validateProbe(raw, now);
  if (!sample) return store;
  const clock = typeof now === "number" && Number.isFinite(now) ? now : sample.at;
  const previous = Array.isArray(store.samples) ? store.samples.slice(-PROBE_MAX_SAMPLES) : [];
  const next = expireProbes({ samples: [...previous, sample] }, clock);
  if (next.samples.length > PROBE_MAX_SAMPLES) next.samples = next.samples.slice(-PROBE_MAX_SAMPLES);
  return next;
}

export function snapToShape(
  point: { lon: number; lat: number },
  shape: [number, number][],
): { lon: number; lat: number; index: number; meters: number; alongMeters: number } | null {
  if (!shape || shape.length < 2 || shape.length > PROBE_MAX_SHAPE_POINTS) return null;
  if (!Number.isFinite(point.lon) || !Number.isFinite(point.lat)) return null;
  if (!shape.every(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat))) return null;
  let bestI = 0;
  let bestD = Infinity;
  let best: [number, number] = shape[0];
  const prefix: number[] = [0];
  for (let i = 1; i < shape.length; i++) {
    prefix[i] =
      prefix[i - 1] +
      haversineMeters({ lon: shape[i - 1][0], lat: shape[i - 1][1] }, { lon: shape[i][0], lat: shape[i][1] });
  }
  for (let i = 0; i < shape.length; i++) {
    const d = haversineMeters(point, { lon: shape[i][0], lat: shape[i][1] });
    if (d < bestD) {
      bestD = d;
      bestI = i;
      best = shape[i];
    }
  }
  if (!Number.isFinite(bestD) || bestD > PROBE_SNAP_M) return null;
  return { lon: best[0], lat: best[1], index: bestI, meters: bestD, alongMeters: prefix[bestI] || 0 };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function agreeingCluster(
  snaps: Array<{ lon: number; lat: number; alongMeters: number }>,
): Array<{ lon: number; lat: number; alongMeters: number }> {
  if (snaps.length < PROBE_MIN_AGREE) return [];
  let best: Array<{ lon: number; lat: number; alongMeters: number }> = [];
  for (const seed of snaps) {
    const group = snaps.filter((item) => haversineMeters(seed, item) <= PROBE_AGREE_M);
    if (group.length > best.length) best = group;
  }
  return best.length >= PROBE_MIN_AGREE ? best : [];
}

export function fuseRouteProbes(input: {
  store: ProbeStore;
  routeId: string;
  shape: [number, number][];
  now: number;
  officialDepart: number;
  expectedAlongMeters?: number;
}): FusedVehicle | null {
  const { store, routeId, shape, now, officialDepart } = input;
  if (
    !routeId ||
    routeId.length > PROBE_MAX_ROUTE_ID_LENGTH ||
    !shape ||
    shape.length < 2 ||
    shape.length > PROBE_MAX_SHAPE_POINTS ||
    !Number.isFinite(now) ||
    !Number.isFinite(officialDepart)
  ) {
    return null;
  }
  const live = expireProbes(store, now).samples.filter((s) => !s.routeId || s.routeId === routeId);
  const snaps = [];
  for (const sample of live) {
    const snap = snapToShape(sample, shape);
    if (snap) snaps.push(snap);
  }
  const cluster = agreeingCluster(snaps);
  if (cluster.length < PROBE_MIN_AGREE) return null;
  const lon = median(cluster.map((c) => c.lon));
  const lat = median(cluster.map((c) => c.lat));
  const alongMeters = median(cluster.map((c) => c.alongMeters));
  const expected =
    typeof input.expectedAlongMeters === "number" && Number.isFinite(input.expectedAlongMeters)
      ? input.expectedAlongMeters
      : alongMeters;
  const etaShiftMinutes = Math.round((expected - alongMeters) / BUS_M_PER_MIN);
  return {
    routeId,
    lon,
    lat,
    alongMeters,
    etaShiftMinutes,
    count: cluster.length,
  };
}

/** Overlay a fused shift onto official due. Null / empty fusion leaves the timetable alone. */
export function applyFusedEtaToDue(due: LineDue[], fused: FusedVehicle | null, now: number): LineDue[] {
  if (!fused || !due.length) return due;
  if (!Number.isFinite(fused.etaShiftMinutes) || fused.etaShiftMinutes === 0) return due;
  return due.map((row) => {
    if (row.routeId !== fused.routeId) return row;
    const depart = row.depart + fused.etaShiftMinutes;
    return {
      ...row,
      depart,
      wait: depart - now,
      clocks: [formatClock(depart), ...row.clocks.slice(1)],
    };
  });
}
