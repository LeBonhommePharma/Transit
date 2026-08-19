import { isCityId, loadAtlas, loadTimetable } from "@/lib/atlas/store";
import { allowRateLimit, MAX_QUERY_TEXT_LENGTH, parseClock, requestRateLimitKey } from "@/lib/http";
import { departuresAtStop } from "@/lib/planner";
import { firstStopFromQuery } from "@/lib/search";
import { activeServiceIndexes } from "@/lib/services";
import { minutesOfDay, montrealNow } from "@/lib/time";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!allowRateLimit(requestRateLimitKey(request, "departures"), 180, 60_000)) {
    return Response.json({ error: "Trop de requêtes." }, { status: 429 });
  }
  const url = new URL(request.url);
  const city = url.searchParams.get("city") || "";
  const stopId = url.searchParams.get("stop") || "";
  const query = url.searchParams.get("q") || "";
  const atParam = url.searchParams.get("at");
  if (
    !isCityId(city) ||
    stopId.length > MAX_QUERY_TEXT_LENGTH ||
    query.length > MAX_QUERY_TEXT_LENGTH ||
    (!stopId && !query)
  ) {
    return Response.json({ error: "Ville ou arrêt manquant." }, { status: 400 });
  }
  const at = atParam ? parseClock(atParam) : montrealNow();
  if (!at) {
    return Response.json({ error: "Horloge invalide." }, { status: 400 });
  }
  const [atlas, timetable] = await Promise.all([loadAtlas(city), loadTimetable(city)]);
  const stop = stopId
    ? atlas.stops.find((s) => s.id === stopId)
    : firstStopFromQuery(atlas, query);
  if (!stop) {
    return Response.json({ error: "Arrêt introuvable." }, { status: 404 });
  }
  const departures = departuresAtStop(
    atlas,
    timetable,
    stop,
    minutesOfDay(at),
    activeServiceIndexes(atlas, at),
  );
  return Response.json({
    stop,
    at: at.toISOString(),
    now: minutesOfDay(at),
    departures,
  });
}
