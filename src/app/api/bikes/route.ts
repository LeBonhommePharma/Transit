import { NextResponse } from "next/server";
import { isCityId } from "@/lib/atlas/store";
import { BIKE_FEEDS, feedUrl, mergeStations, nearbyStations } from "@/lib/bikeshare";

export const runtime = "nodejs";

const cache = new Map<string, { at: number; stations: ReturnType<typeof mergeStations> }>();

async function stationsFor(city: "quebec" | "montreal") {
  const hit = cache.get(city);
  if (hit && Date.now() - hit.at < 45_000) return hit.stations;
  const spec = BIKE_FEEDS[city];
  const discovery = await fetch(spec.gbfs, {
    next: { revalidate: 30 },
    signal: AbortSignal.timeout(2500),
  }).then((r) => r.json());
  const infoUrl = feedUrl(discovery, "station_information");
  const statusUrl = feedUrl(discovery, "station_status");
  if (!infoUrl || !statusUrl) return [];
  const [info, status] = await Promise.all([
    fetch(infoUrl, { next: { revalidate: 30 }, signal: AbortSignal.timeout(2500) }).then((r) =>
      r.json(),
    ),
    fetch(statusUrl, { next: { revalidate: 20 }, signal: AbortSignal.timeout(2500) }).then((r) =>
      r.json(),
    ),
  ]);
  const stations = mergeStations(info, status, spec.system);
  cache.set(city, { at: Date.now(), stations });
  return stations;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const city = url.searchParams.get("city") || "";
  if (!isCityId(city)) {
    return NextResponse.json({ error: "Ville inconnue." }, { status: 400 });
  }
  const stations = await stationsFor(city);
  const lon = Number(url.searchParams.get("lon"));
  const lat = Number(url.searchParams.get("lat"));
  const near =
    Number.isFinite(lon) && Number.isFinite(lat)
      ? nearbyStations(stations, { lon, lat })
      : stations.slice(0, 40);
  return NextResponse.json({
    system: BIKE_FEEDS[city].label,
    stations: near,
  });
}

export { stationsFor };
