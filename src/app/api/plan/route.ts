import { stationsFor } from "@/app/api/bikes/route";
import { isCityId, loadAtlas, loadTimetable } from "@/lib/atlas/store";
import { isPlace, parseClock, readJsonBody } from "@/lib/http";
import { planTrip } from "@/lib/planner";
import { activeServiceIndexes } from "@/lib/services";
import { minutesOfDay, montrealNow } from "@/lib/time";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const parsed = await readJsonBody<{
    city?: string;
    from?: unknown;
    to?: unknown;
    at?: string;
  }>(request);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
    return Response.json({ error: "Corps JSON invalide." }, { status: 400 });
  }
  const body = parsed.value;
  if (!body.city || !isCityId(body.city) || !isPlace(body.from) || !isPlace(body.to)) {
    return Response.json({ error: "Requête incomplète." }, { status: 400 });
  }
  const at = body.at ? parseClock(body.at) : montrealNow();
  if (!at) {
    return Response.json({ error: "Horloge invalide." }, { status: 400 });
  }
  const [atlas, timetable, bikes] = await Promise.all([
    loadAtlas(body.city),
    loadTimetable(body.city),
    stationsFor(body.city).catch(() => []),
  ]);
  const itineraries = planTrip(
    atlas,
    timetable,
    body.from,
    body.to,
    minutesOfDay(at),
    activeServiceIndexes(atlas, at),
    bikes,
  );
  return Response.json({
    city: body.city,
    at: at.toISOString(),
    itineraries,
  });
}
