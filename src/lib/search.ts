import type { Atlas, AtlasRoute, AtlasStop, Place } from "./atlas/types";
import { haversineMeters } from "./geo";

export function fold(value: string): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export type SearchHit =
  | { kind: "stop"; stop: AtlasStop; score: number }
  | { kind: "route"; route: AtlasRoute; score: number };

export function searchAtlas(atlas: Atlas, query: string, limit = 8): SearchHit[] {
  const q = fold(query);
  if (q.length < 1) return [];
  const hits: SearchHit[] = [];

  for (const route of atlas.routes) {
    const name = fold(`${route.shortName} ${route.longName} ${route.agencyId} ${route.agencyName}`);
    let score = -1;
    if (fold(route.shortName) === q) score = 200;
    else if (fold(route.shortName).startsWith(q)) score = 160;
    else if (name.startsWith(q)) score = 120;
    else if (name.includes(q)) score = 80;
    if (score > 0) hits.push({ kind: "route", route, score });
  }

  for (const stop of atlas.stops) {
    if (stop.kind === 2) continue;
    const name = fold(stop.name);
    const code = fold(stop.code || "");
    const agency = fold(stop.agencyId || "");
    const nameTokens = name.split(/\s+/).filter(Boolean);
    const tokens = q.split(/\s+/).filter((t) => t.length > 2);
    const hay = ` ${name} ${code} ${agency} `;
    const tokenHits = tokens.filter((t) => hay.includes(` ${t} `)).length;
    let score = -1;
    if (code && code === q) score = 190;
    else if (name === q) score = 180;
    else if (nameTokens.includes(q) && stop.kind === 1) score = 172;
    else if (nameTokens.includes(q)) score = 155;
    else if (name.startsWith(q)) score = 140;
    else if (code.startsWith(q)) score = 130;
    else if (name.includes(q)) score = 70;
    else if (tokenHits > 0) score = 40 + tokenHits * 25;
    if (score > 0 && stop.kind === 1) score += 8;
    if (score > 0) hits.push({ kind: "stop", stop, score });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

export function isFinitePoint(point: { lon?: unknown; lat?: unknown } | null | undefined): point is {
  lon: number;
  lat: number;
} {
  return (
    !!point &&
    Number.isFinite(Number(point.lon)) &&
    Number.isFinite(Number(point.lat))
  );
}

/** Map-sourced here is city-local. GPS is kept only if still near the new city. */
export function pinHereForCity(
  here: { lon: number; lat: number; source?: string } | null | undefined,
  center: { lon: number; lat: number },
  maxMeters = 40_000,
): { lon: number; lat: number; source: string } {
  if (here && here.source === "gps" && isFinitePoint(here) && isFinitePoint(center)) {
    const meters = haversineMeters(here, center);
    if (Number.isFinite(meters) && meters <= maxMeters) {
      return { lon: here.lon, lat: here.lat, source: "gps" };
    }
  }
  return { lon: center.lon, lat: center.lat, source: "map" };
}

export function nearbyStops(
  stops: AtlasStop[],
  point: { lon: number; lat: number },
  radiusM = 700,
  limit = 14,
): Array<AtlasStop & { meters: number }> {
  if (!isFinitePoint(point)) return [];
  const out: Array<AtlasStop & { meters: number }> = [];
  for (const stop of stops) {
    if (stop.kind === 2) continue;
    if (!Number.isFinite(stop.lon) || !Number.isFinite(stop.lat)) continue;
    const meters = haversineMeters(point, { lon: stop.lon, lat: stop.lat });
    if (!Number.isFinite(meters) || meters > radiusM) continue;
    out.push({ ...stop, meters: Math.round(meters) });
  }
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 1 ? -1 : b.kind === 1 ? 1 : 0;
    return a.meters - b.meters;
  });
  return out.slice(0, limit);
}

export function firstStopFromQuery(atlas: Atlas, query: string): AtlasStop | null {
  const hit = searchAtlas(atlas, query, 12).find((item) => item.kind === "stop");
  return hit && hit.kind === "stop" ? hit.stop : null;
}

export function placeFromStop(stop: AtlasStop): Place {
  return {
    label: stop.name,
    lon: stop.lon,
    lat: stop.lat,
    stopId: stop.id,
  };
}
