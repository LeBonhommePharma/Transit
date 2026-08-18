import { haversineMeters } from "./geo";

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

export const BIKE_FEEDS: Record<
  "quebec" | "montreal",
  { system: BikeSystem; label: string; gbfs: string }
> = {
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
    feeds?: Array<{ name: string; url: string }>;
    [lang: string]: unknown;
  };
};

export function feedUrl(discovery: GbfsDiscovery, name: string): string | null {
  const data = discovery.data;
  if (!data) return null;
  if (Array.isArray(data.feeds)) {
    return data.feeds.find((f) => f.name === name)?.url ?? null;
  }
  for (const key of ["fr", "en"]) {
    const block = data[key] as { feeds?: Array<{ name: string; url: string }> } | undefined;
    const url = block?.feeds?.find((f) => f.name === name)?.url;
    if (url) return url;
  }
  return null;
}

export function mergeStations(
  info: { data?: { stations?: Array<Record<string, unknown>> } },
  status: { data?: { stations?: Array<Record<string, unknown>> } },
  system: BikeSystem,
): BikeStation[] {
  const live = new Map<string, Record<string, unknown>>();
  for (const row of status.data?.stations ?? []) {
    live.set(String(row.station_id), row);
  }
  const out: BikeStation[] = [];
  for (const row of info.data?.stations ?? []) {
    const id = String(row.station_id ?? "");
    const pos = live.get(id);
    if (!id) continue;
    const name = typeof row.name === "string" ? row.name : String(row.name ?? id);
    const lat = Number(row.lat);
    const lon = Number(row.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    out.push({
      id,
      name,
      lat,
      lon,
      bikes: Number(pos?.num_bikes_available ?? 0),
      docks: Number(pos?.num_docks_available ?? 0),
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
  const hits: Array<BikeStation & { meters: number }> = [];
  for (const station of stations) {
    if (need === "bikes" && station.bikes < 1) continue;
    if (need === "docks" && station.docks < 1) continue;
    const meters = haversineMeters(point, station);
    if (meters <= radiusM) hits.push({ ...station, meters });
  }
  hits.sort((a, b) => a.meters - b.meters);
  return hits.slice(0, limit);
}

export function bikeMinutes(meters: number): number {
  return Math.max(1, Math.round(meters / 250));
}
