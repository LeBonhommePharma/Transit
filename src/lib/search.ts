import type { Atlas, AtlasRoute, AtlasStop, Place } from "./atlas/types";
import { haversineMeters } from "./geo";
import type { Poi } from "./poi";

const MAX_SEARCH_QUERY_LENGTH = 512;
const MAX_SEARCH_TOKENS = 8;
const INTENT_WORDS = new Set([
  "a",
  "at",
  "de",
  "des",
  "du",
  "from",
  "horaire",
  "itineraire",
  "near",
  "nearby",
  "ou",
  "pour",
  "prochain",
  "prochains",
  "schedule",
  "to",
  "trajet",
  "vers",
  "where",
]);

export type SearchOptions = {
  pois?: Poi[];
  origin?: { lon: number; lat: number };
};

export type SearchHit =
  | { kind: "stop"; stop: AtlasStop; score: number; importance: number }
  | { kind: "route"; route: AtlasRoute; score: number; importance: number }
  | { kind: "poi"; poi: Poi; score: number; importance: number };

export function fold(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .slice(0, MAX_SEARCH_QUERY_LENGTH)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(value: unknown): string[] {
  return fold(value)
    .split(/\s+/)
    .filter((token) => token.length > 1)
    .map((token) => token.slice(0, 64))
    .slice(0, MAX_SEARCH_TOKENS);
}

function atlasQueryTokens(query: string, atlas: Atlas): string[] {
  const all = tokens(query);
  const contextWords = new Set([
    ...tokens(atlas.meta.city),
    ...tokens(atlas.meta.name),
    ...tokens(atlas.meta.agencyId),
  ]);
  const meaningful = all.filter((token) => !INTENT_WORDS.has(token) && !contextWords.has(token));
  if (meaningful.length) return meaningful.slice(0, MAX_SEARCH_TOKENS);
  const withoutIntent = all.filter((token) => !INTENT_WORDS.has(token));
  return (withoutIntent.length ? withoutIntent : all).slice(0, MAX_SEARCH_TOKENS);
}

function boundedImportance(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(100, n));
}

function tokenSimilarity(query: string, candidate: string): number {
  if (!query || !candidate) return 0;
  if (query === candidate) return 1;
  if (query.length >= 4 && candidate.startsWith(query)) return 0.86;
  if (query.startsWith(candidate) && candidate.length >= 3 && query.length - candidate.length <= 2) return 0.86;
  if (query.length >= 4 && candidate.includes(query) && candidate.length <= query.length * 2) return 0.74;
  if (candidate.length >= 3 && query.length >= 4 && query.includes(candidate) && query.length <= candidate.length * 2) return 0.74;
  if (query.length < 4 || candidate.length < 3) return 0;
  const maxDistance = query.length >= 5 ? 2 : 1;
  if (Math.abs(query.length - candidate.length) > Math.max(2, Math.floor(query.length / 3))) return 0;
  let beforePrevious: number[] | null = null;
  let previous = Array.from({ length: candidate.length + 1 }, (_, i) => i);
  for (let i = 1; i <= query.length; i++) {
    const current = [i];
    for (let j = 1; j <= candidate.length; j++) {
      const cost = query[i - 1] === candidate[j - 1] ? 0 : 1;
      const transposition =
        beforePrevious &&
        i > 1 &&
        j > 1 &&
        query[i - 1] === candidate[j - 2] &&
        query[i - 2] === candidate[j - 1]
          ? beforePrevious[j - 2] + 1
          : Infinity;
      const value = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost, transposition);
      current[j] = value;
    }
    beforePrevious = previous;
    previous = current;
  }
  const distance = previous[candidate.length];
  return distance <= maxDistance ? Math.max(0.52, 1 - distance / Math.max(query.length, candidate.length)) : 0;
}

function matchScore(query: string, queryTokens: string[], fields: unknown[]): number {
  const normalizedFields = fields.map(fold).filter(Boolean);
  if (!normalizedFields.length || !queryTokens.length) return 0;
  const primary = normalizedFields[0];
  const exact = normalizedFields.some((field) => field === query);
  const starts = normalizedFields.some((field) => field.startsWith(query));
  const candidateTokens = [...new Set(normalizedFields.flatMap(tokens))];
  let matched = 0;
  let similarity = 0;
  for (const token of queryTokens) {
    const best = Math.max(0, ...candidateTokens.map((candidate) => tokenSimilarity(token, candidate)));
    if (best > 0) {
      matched += 1;
      similarity += best;
    }
  }
  if (matched === 0) return 0;
  const coverage = matched / queryTokens.length;
  if (coverage < (queryTokens.length <= 2 ? 1 : 0.5)) return 0;
  const base = exact ? 100 : starts ? 84 : coverage === 1 ? 72 : 42 + coverage * 24;
  return base + (similarity / matched) * 26 - (queryTokens.length - matched) * 6 + (primary === query ? 4 : 0);
}

function stopImportance(stop: AtlasStop, timetable?: Record<string, unknown[]> | null): number {
  const routes = Array.isArray(stop.routes) ? stop.routes.length : 0;
  const children = Array.isArray(stop.children) ? stop.children.length : 0;
  const derived =
    (stop.kind === 1 ? 58 : 0) +
    Math.min(24, Math.log2(1 + routes) * 8) +
    Math.min(18, children * 4) +
    (stopHasService(stop, timetable) ? 8 : 0);
  return Math.max(derived, boundedImportance(stop.importance), boundedImportance(stop.popularity));
}

function routeImportance(route: AtlasRoute): number {
  const stopCount = route.dirs.reduce((n, dir) => n + dir.stops.length, 0);
  const derived = (route.type === 1 ? 58 : 0) + Math.min(32, Math.log2(1 + stopCount) * 4);
  return Math.max(derived, boundedImportance((route as AtlasRoute & { importance?: number }).importance));
}

function poiImportance(poi: Poi): number {
  return Math.max(
    boundedImportance(poi.popularity),
    boundedImportance(poi.importance),
    boundedImportance(poi.popularity) * 0.75 + boundedImportance(poi.importance) * 0.25,
  );
}

function proximity(origin: SearchOptions["origin"], point: { lon: number; lat: number }): number {
  if (!origin || !isFinitePoint(origin) || !isFinitePoint(point)) return 0;
  const meters = haversineMeters(origin, point);
  return Number.isFinite(meters) && meters < 3_000 ? (1 - meters / 3_000) * 24 : 0;
}

export function searchAtlas(
  atlas: Atlas,
  query: string,
  limit = 8,
  timetable?: Record<string, unknown[]> | null,
  options: SearchOptions = {},
): SearchHit[] {
  const q = fold(query);
  if (q.length < 1 || q.length > MAX_SEARCH_QUERY_LENGTH) return [];
  const queryTokens = atlasQueryTokens(q, atlas);
  if (!queryTokens.length) return [];
  const hits: SearchHit[] = [];

  for (const route of atlas.routes) {
    const fields = [route.shortName, route.longName, route.agencyId, route.agencyName, ...(route.aliases || [])];
    const relevance = matchScore(q, queryTokens, fields);
    if (relevance <= 0) continue;
    const importance = routeImportance(route);
    const codeBoost = fold(route.shortName) === q ? 48 : 0;
    hits.push({ kind: "route", route, importance, score: relevance + importance * 1.15 + codeBoost });
  }

  for (const stop of atlas.stops) {
    if (stop.kind === 2) continue;
    if (!stopHasService(stop, timetable)) continue;
    const fields = [stop.name, stop.code, stop.agencyId, ...(stop.aliases || [])];
    const relevance = matchScore(q, queryTokens, fields);
    if (relevance <= 0) continue;
    const importance = stopImportance(stop, timetable);
    const codeBoost = fold(stop.code) === q ? 48 : 0;
    hits.push({ kind: "stop", stop, importance, score: relevance + importance * 1.15 + codeBoost + proximity(options.origin, stop) });
  }

  for (const poi of options.pois || []) {
    if (poi.city && poi.city !== atlas.meta.city) continue;
    const fields = [poi.name, poi.category, ...(poi.aliases || [])];
    const relevance = matchScore(q, queryTokens, fields);
    if (relevance <= 0) continue;
    const importance = poiImportance(poi);
    hits.push({ kind: "poi", poi, importance, score: relevance + importance * 1.15 + proximity(options.origin, poi) });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, Math.min(20, Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 8))));
}

/** GPS inside this radius of a city center is “here”. Outside is not invented membership. */
export const CITY_MEMBERSHIP_M = 40_000;

export function supportedCityCenters(): Record<string, { lon: number; lat: number }> {
  return {
    quebec: { lon: -71.2082, lat: 46.8131 },
    montreal: { lon: -73.5673, lat: 45.5017 },
    sherbrooke: { lon: -71.8908, lat: 45.4042 },
    "trois-rivieres": { lon: -72.5415, lat: 46.3432 },
  };
}

/** Places that share a packed atlas. Chip opens the parent city and pans here. */
export type CityVisit = {
  id: string;
  label: string;
  city: string;
  lon: number;
  lat: number;
  zoom: number;
};

export const CITY_VISITS: CityVisit[] = [
  { id: "levis", label: "Lévis", city: "quebec", lon: -71.178, lat: 46.803, zoom: 12.8 },
  { id: "laval", label: "Laval", city: "montreal", lon: -73.742, lat: 45.57, zoom: 12.4 },
  { id: "longueuil", label: "Longueuil", city: "montreal", lon: -73.508, lat: 45.531, zoom: 12.6 },
];

export type CityChip = {
  kind: "city" | "visit";
  id: string;
  city: string;
  label: string;
  visit?: CityVisit;
};

export function resolveCityRequest(raw: unknown, visits: CityVisit[] = CITY_VISITS): { city: string; visit: CityVisit | null } {
  if (typeof raw !== "string") return { city: "", visit: null };
  const id = raw.trim().toLowerCase();
  if (!id) return { city: "", visit: null };
  const visit = visits.find((item) => item.id === id) || null;
  return visit ? { city: visit.city, visit } : { city: id, visit: null };
}

export function chipsForCities(
  cities: Array<{ city?: unknown; name?: unknown }>,
  visits: CityVisit[] = CITY_VISITS,
): CityChip[] {
  const out: CityChip[] = [];
  for (const item of cities) {
    if (typeof item.city !== "string" || !item.city) continue;
    const label = typeof item.name === "string" && item.name ? item.name : item.city;
    out.push({ kind: "city", id: item.city, city: item.city, label });
    for (const visit of visits) {
      if (visit.city === item.city) {
        out.push({ kind: "visit", id: visit.id, city: visit.city, label: visit.label, visit });
      }
    }
  }
  return out;
}

/** Supported city containing the point, or null. Never invents the nearest city as here. */
export function cityForPoint(
  lon: unknown,
  lat: unknown,
  centers?: Record<string, { lon: number; lat: number }> | null,
  maxMeters = CITY_MEMBERSHIP_M,
): string | null {
  const x = Number(lon);
  const y = Number(lat);
  if (!Number.isFinite(x) || !Number.isFinite(y) || y < -90 || y > 90 || x < -180 || x > 180) return null;
  const table = centers && typeof centers === "object" ? centers : supportedCityCenters();
  const radius = Number.isFinite(maxMeters) && maxMeters > 0 ? maxMeters : CITY_MEMBERSHIP_M;
  let best: string | null = null;
  let bestM = Infinity;
  for (const [id, center] of Object.entries(table)) {
    if (!center || !Number.isFinite(center.lon) || !Number.isFinite(center.lat)) continue;
    const meters = haversineMeters({ lon: x, lat: y }, center);
    if (!Number.isFinite(meters) || meters > radius) continue;
    if (meters < bestM) {
      bestM = meters;
      best = id;
    }
  }
  return best;
}

/** Chip/`?city=` lock wins over a here-sample in another served region. */
export function cityAfterHereSample(input: {
  explicitCity?: unknown;
  detectedCity?: unknown;
  locked?: unknown;
}): string | null {
  const explicit = typeof input?.explicitCity === "string" && input.explicitCity ? input.explicitCity : null;
  const detected = typeof input?.detectedCity === "string" && input.detectedCity ? input.detectedCity : null;
  if (input?.locked && explicit) return explicit;
  return detected || explicit;
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

export function stopHasService(
  stop: AtlasStop,
  timetable: Record<string, unknown[]> | null | undefined,
): boolean {
  if (!timetable) return true;
  const ids = [stop.id, ...(stop.children || []), stop.parent].filter(Boolean) as string[];
  return ids.some((id) => Array.isArray(timetable[id]) && timetable[id].length > 0);
}

/** Closest official pole to a dropped pin. Empty / far / junk → null. */
export function nearestStopForPin<T extends { lon: number; lat: number; kind?: number }>(
  stops: T[],
  point: { lon: number; lat: number },
  radiusM = 280,
): (T & { meters: number }) | null {
  if (!isFinitePoint(point) || !Array.isArray(stops)) return null;
  const radius = Math.min(5_000, Math.max(0, Number.isFinite(radiusM) ? radiusM : 280));
  let best: (T & { meters: number }) | null = null;
  for (const stop of stops) {
    if (stop.kind === 2) continue;
    if (!Number.isFinite(stop.lon) || !Number.isFinite(stop.lat)) continue;
    const meters = haversineMeters(point, stop);
    if (!Number.isFinite(meters) || meters > radius) continue;
    if (!best || meters < best.meters) best = { ...stop, meters };
  }
  return best;
}

export function nearbyStops(
  stops: AtlasStop[],
  point: { lon: number; lat: number },
  radiusM = 700,
  limit = 14,
  timetable?: Record<string, unknown[]> | null,
): Array<AtlasStop & { meters: number }> {
  if (!isFinitePoint(point)) return [];
  const radius = Math.min(5_000, Math.max(0, Number.isFinite(radiusM) ? radiusM : 700));
  const max = Math.min(50, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 14));
  const out: Array<AtlasStop & { meters: number }> = [];
  for (const stop of stops) {
    if (stop.kind === 2) continue;
    if (!stopHasService(stop, timetable)) continue;
    if (!Number.isFinite(stop.lon) || !Number.isFinite(stop.lat)) continue;
    const meters = haversineMeters(point, { lon: stop.lon, lat: stop.lat });
    if (!Number.isFinite(meters) || meters > radius) continue;
    out.push({ ...stop, meters: Math.round(meters) });
  }
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 1 ? -1 : b.kind === 1 ? 1 : 0;
    return a.meters - b.meters;
  });
  return out.slice(0, max);
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
