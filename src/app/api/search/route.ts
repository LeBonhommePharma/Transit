import { isCityId, loadAtlas } from "@/lib/atlas/store";
import { nearbyStops, searchAtlas } from "@/lib/search";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const city = url.searchParams.get("city") || "";
  const q = url.searchParams.get("q") || "";
  const lon = Number(url.searchParams.get("lon"));
  const lat = Number(url.searchParams.get("lat"));
  if (!isCityId(city)) {
    return Response.json({ error: "Ville inconnue." }, { status: 400 });
  }
  const atlas = await loadAtlas(city);
  if (Number.isFinite(lon) && Number.isFinite(lat) && !q) {
    return Response.json({ hits: nearbyStops(atlas.stops, { lon, lat }) });
  }
  return Response.json({ hits: searchAtlas(atlas, q) });
}
