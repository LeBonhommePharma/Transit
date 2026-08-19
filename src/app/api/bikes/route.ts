import { NextResponse } from "next/server";
import { isCityId } from "@/lib/atlas/store";
import { allowRateLimit, isFiniteCoordinate, requestRateLimitKey } from "@/lib/http";
import { BIKE_FEEDS, feedUrl, mergeStations, nearbyStations } from "@/lib/bikeshare";
import type { CityId } from "@/lib/atlas/types";

export const runtime = "nodejs";

const cache = new Map<string, { at: number; stations: ReturnType<typeof mergeStations> }>();
const MAX_GBFS_BYTES = 4 * 1024 * 1024;

async function readJsonResponse(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`GBFS ${response.status}`);
  const advertised = response.headers.get("content-length");
  if (advertised && Number(advertised) > MAX_GBFS_BYTES) throw new Error("GBFS response too large");
  if (!response.body) throw new Error("GBFS response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_GBFS_BYTES) {
      await reader.cancel();
      throw new Error("GBFS response too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function fetchJson(url: string): Promise<unknown> {
  return readJsonResponse(
    await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(2500),
      cache: "no-store",
    }),
  );
}

async function stationsFor(city: CityId) {
  const hit = cache.get(city);
  if (hit && Date.now() - hit.at < 45_000) return hit.stations;
  const spec = BIKE_FEEDS[city];
  if (!spec) return [];
  const discovery = await fetchJson(spec.gbfs);
  const origin = new URL(spec.gbfs).origin;
  const infoUrl = feedUrl(discovery, "station_information", origin);
  const statusUrl = feedUrl(discovery, "station_status", origin);
  if (!infoUrl || !statusUrl) return [];
  const [info, status] = await Promise.all([
    fetchJson(infoUrl),
    fetchJson(statusUrl),
  ]);
  const stations = mergeStations(info, status, spec.system);
  cache.set(city, { at: Date.now(), stations });
  return stations;
}

export async function GET(request: Request) {
  if (!allowRateLimit(requestRateLimitKey(request, "bikes"), 120, 60_000)) {
    return NextResponse.json({ error: "Trop de requêtes." }, { status: 429 });
  }
  const url = new URL(request.url);
  const city = url.searchParams.get("city") || "";
  if (!isCityId(city)) {
    return NextResponse.json({ error: "Ville inconnue." }, { status: 400 });
  }
  let stations: ReturnType<typeof mergeStations>;
  try {
    stations = await stationsFor(city);
  } catch {
    return NextResponse.json({ error: "Données vélo indisponibles.", stations: [] }, { status: 502 });
  }
  const lon = Number(url.searchParams.get("lon"));
  const lat = Number(url.searchParams.get("lat"));
  const hasLon = url.searchParams.has("lon");
  const hasLat = url.searchParams.has("lat");
  if (hasLon !== hasLat || (hasLon && (!isFiniteCoordinate(lon, -180, 180) || !isFiniteCoordinate(lat, -90, 90)))) {
    return NextResponse.json({ error: "Coordonnées invalides.", stations: [] }, { status: 400 });
  }
  const near =
    hasLon && hasLat
      ? nearbyStations(stations, { lon, lat })
      : stations.slice(0, 40);
  return NextResponse.json({
    system: BIKE_FEEDS[city]?.label || "",
    stations: near,
  });
}

export { stationsFor };
