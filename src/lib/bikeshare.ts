import { haversineMeters } from "./geo";
import type { CityId } from "./atlas/types";

export type BikeSystem = "avelo" | "bixi";

export type BikeStation = {
  id: string;
  name: string;
  lon: number;
  lat: number;
  bikes: number;
  docks: number;
  system: BikeSystem;
};

export const BIKE_FEEDS: Partial<Record<
  CityId,
  { system: BikeSystem; label: string; gbfs: string }
>> = {
  quebec: {
    system: "avelo",
    label: "àVélo",
    gbfs: "https://quebec.publicbikesystem.net/customer/gbfs/v3.0/gbfs.json",
  },
  montreal: {
    system: "bixi",
    label: "BIXI",
    gbfs: "https://gbfs.velobixi.com/gbfs/gbfs.json",
  },
};

type GbfsDiscovery = {
  data?: {
    feeds?: Array<{ name?: unknown; url?: unknown }>;
    [lang: string]: unknown;
  };
};

const MAX_FEED_URL_LENGTH = 512;
const MAX_STATIONS = 20_000;
const MAX_STATION_TEXT_LENGTH = 160;

function safeFeedUrl(value: unknown, allowedOrigin: string | undefined): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_FEED_URL_LENGTH || !allowedOrigin) {
    return null;
  }
  try {
    const base = new URL(allowedOrigin);
    const url = new URL(value, base);
    if (url.protocol !== "https:" || url.origin !== base.origin || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function feedUrl(discovery: unknown, name: string, allowedOrigin?: string): string | null {
  if (!discovery || typeof discovery !== "object") return null;
  const data = (discovery as GbfsDiscovery).data;
  if (!data) return null;
  if (Array.isArray(data.feeds)) {
    const match = data.feeds.find((f) => f && f.name === name);
    return safeFeedUrl(match?.url, allowedOrigin);
  }
  for (const key of ["fr", "en"]) {
    const block = data[key] as { feeds?: Array<{ name?: unknown; url?: unknown }> } | undefined;
    const match = block?.feeds?.find((f) => f && f.name === name);
    const url = safeFeedUrl(match?.url, allowedOrigin);
    if (url) return url;
  }
  return null;
}

function stationsFromPayload(payload: unknown): Array<Record<string, unknown>> {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== "object") return [];
  const stations = (data as { stations?: unknown }).stations;
  return Array.isArray(stations) ? stations.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object")) : [];
}

export function mergeStations(info: unknown, status: unknown, system: BikeSystem): BikeStation[] {
  const live = new Map<string, Record<string, unknown>>();
  for (const row of stationsFromPayload(status).slice(0, MAX_STATIONS)) {
    const id = String(row.station_id ?? "").slice(0, MAX_STATION_TEXT_LENGTH);
    if (id) live.set(id, row);
  }
  const out: BikeStation[] = [];
  for (const row of stationsFromPayload(info).slice(0, MAX_STATIONS)) {
    const id = String(row.station_id ?? "").slice(0, MAX_STATION_TEXT_LENGTH);
    const pos = live.get(id);
    if (!id) continue;
    const name = (typeof row.name === "string" ? row.name : String(row.name ?? id)).slice(0, MAX_STATION_TEXT_LENGTH);
    const lat = Number(row.lat);
    const lon = Number(row.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180 || (lat === 0 && lon === 0)) continue;
    const bikes = Number(pos?.num_bikes_available ?? 0);
    const docks = Number(pos?.num_docks_available ?? 0);
    if (!Number.isFinite(bikes) || !Number.isFinite(docks) || bikes < 0 || docks < 0 || bikes > 100_000 || docks > 100_000) continue;
    if (bikes < 1 && docks < 1) continue;
    out.push({
      id,
      name,
      lat,
      lon,
      bikes,
      docks,
      system,
    });
  }
  return out;
}

export function nearbyStations(
  stations: BikeStation[],
  point: { lon: number; lat: number },
  radiusM = 450,
  need: "bikes" | "docks" | "any" = "any",
  limit = 6,
): Array<BikeStation & { meters: number }> {
  if (
    !Number.isFinite(point.lon) ||
    !Number.isFinite(point.lat) ||
    point.lon < -180 ||
    point.lon > 180 ||
    point.lat < -90 ||
    point.lat > 90
  ) {
    return [];
  }
  const radius = Math.min(5_000, Math.max(0, Number.isFinite(radiusM) ? radiusM : 450));
  const max = Math.min(20, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 6));
  const hits: Array<BikeStation & { meters: number }> = [];
  for (const station of stations) {
    if (need === "bikes" && station.bikes < 1) continue;
    if (need === "docks" && station.docks < 1) continue;
    const meters = haversineMeters(point, station);
    if (meters <= radius) hits.push({ ...station, meters });
  }
  hits.sort((a, b) => a.meters - b.meters);
  return hits.slice(0, max);
}

export function bikeMinutes(meters: number): number {
  if (!Number.isFinite(meters) || meters < 0) return 0;
  return Math.max(1, Math.round(meters / 250));
}
