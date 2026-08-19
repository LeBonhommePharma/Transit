import { isCityId, loadAtlas, loadPois } from "@/lib/atlas/store";
import { allowRateLimit, isFiniteCoordinate, MAX_QUERY_TEXT_LENGTH, requestRateLimitKey } from "@/lib/http";
import { nearbyStops, searchAtlas } from "@/lib/search";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!allowRateLimit(requestRateLimitKey(request, "search"), 240, 60_000)) {
    return Response.json({ error: "Trop de requêtes." }, { status: 429 });
  }
  const url = new URL(request.url);
  const city = url.searchParams.get("city") || "";
  const q = url.searchParams.get("q") || "";
  const lon = Number(url.searchParams.get("lon"));
  const lat = Number(url.searchParams.get("lat"));
  if (!isCityId(city) || q.length > MAX_QUERY_TEXT_LENGTH) {
    return Response.json({ error: "Ville inconnue." }, { status: 400 });
  }
  const hasLon = url.searchParams.has("lon");
  const hasLat = url.searchParams.has("lat");
  if (hasLon !== hasLat || (hasLon && (!isFiniteCoordinate(lon, -180, 180) || !isFiniteCoordinate(lat, -90, 90)))) {
    return Response.json({ error: "Coordonnées invalides." }, { status: 400 });
  }
  const [atlas, pois] = await Promise.all([loadAtlas(city), loadPois(city)]);
  if (hasLon && hasLat && !q) {
    return Response.json({ hits: nearbyStops(atlas.stops, { lon, lat }) });
  }
  return Response.json({ hits: searchAtlas(atlas, q, 8, undefined, { pois }) });
}
