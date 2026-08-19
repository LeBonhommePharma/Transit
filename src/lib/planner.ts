import type {
  Atlas,
  AtlasRoute,
  AtlasStop,
  Itinerary,
  Place,
  Timetable,
  TimetableEntry,
  TripLeg,
} from "./atlas/types";
import type { BikeStation } from "./bikeshare";
import { bikeMinutes, nearbyStations } from "./bikeshare";
import { haversineMeters, roadMinutes, walkMinutes } from "./geo";
import { isFinitePoint, nearbyStops, placeFromStop } from "./search";
import { nextAfter } from "./time";

function stopById(atlas: Atlas): Map<string, AtlasStop> {
  return new Map(atlas.stops.map((s) => [s.id, s]));
}

function routeById(atlas: Atlas): Map<string, AtlasRoute> {
  return new Map(atlas.routes.map((r) => [r.id, r]));
}

function lookupIds(stop: AtlasStop): string[] {
  const ids = [stop.id];
  if (stop.children) ids.push(...stop.children);
  if (stop.parent) ids.push(stop.parent);
  return ids;
}

function indexOnDir(dirStops: string[], stop: AtlasStop): number {
  const ids = new Set(lookupIds(stop));
  for (let i = 0; i < dirStops.length; i++) {
    if (ids.has(dirStops[i])) return i;
  }
  return -1;
}

function entriesForStop(timetable: Timetable, stop: AtlasStop): TimetableEntry[] {
  const out: TimetableEntry[] = [];
  for (const id of lookupIds(stop)) {
    const rows = timetable[id];
    if (rows) out.push(...rows);
  }
  return out;
}

function nextDeparture(
  timetable: Timetable,
  stop: AtlasStop,
  routeId: string,
  dir: number,
  now: number,
  active: Set<number>,
  headsign?: string,
): { depart: number; headsign: string } | null {
  let best: { depart: number; headsign: string } | null = null;
  for (const row of entriesForStop(timetable, stop)) {
    if (row.r !== routeId) continue;
    if (row.d !== dir && dir != null) continue;
    if (headsign && row.h && row.h !== headsign) continue;
    if (!row.s.some((s) => active.has(s))) continue;
    const depart = nextAfter(row.t, now);
    if (depart == null) continue;
    if (!best || depart < best.depart) best = { depart, headsign: row.h };
  }
  return best;
}

export function connectorWalk(
  alight: AtlasStop,
  board: AtlasStop | undefined,
  waitMinutes: number,
): Extract<TripLeg, { kind: "walk" }> {
  const dest = board ?? alight;
  const same = !board || board.id === alight.id;
  const meters = same ? 80 : Math.round(haversineMeters(alight, dest));
  const minutes = same ? Math.max(2, waitMinutes) : Math.max(2, walkMinutes(meters));
  return {
    kind: "walk",
    minutes,
    meters,
    from: placeFromStop(alight),
    to: placeFromStop(dest),
  };
}

function hopSum(hops: number[], from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to && i < hops.length; i++) n += hops[i];
  return Math.max(1, n);
}

function itineraryId(parts: string[]): string {
  return parts.join("|");
}

export function departuresAtStop(
  atlas: Atlas,
  timetable: Timetable,
  stop: AtlasStop,
  now: number,
  active: Set<number>,
  limit = 12,
) {
  const routes = routeById(atlas);
  const rows: Array<{
    routeId: string;
    shortName: string;
    color: string;
    textColor: string;
    headsign: string;
    type: number;
    agencyId?: string;
    depart: number;
    wait: number;
    times: number[];
  }> = [];

  for (const entry of entriesForStop(timetable, stop)) {
    if (!entry.s.some((s) => active.has(s))) continue;
    const route = routes.get(entry.r);
    if (!route) continue;
    const upcoming = entry.t.filter((t) => t >= now).slice(0, 6);
    const wrapped = upcoming.length > 0 ? upcoming : entry.t.slice(0, 1).map((t) => t + 1440);
    if (wrapped.length === 0) continue;
    const depart = wrapped[0];
    rows.push({
      routeId: route.id,
      shortName: route.shortName,
      color: route.color,
      textColor: route.textColor,
      headsign: entry.h || route.longName,
      type: route.type,
      agencyId: route.agencyId,
      depart,
      wait: depart - now,
      times: wrapped,
    });
  }

  rows.sort((a, b) => a.depart - b.depart || a.shortName.localeCompare(b.shortName));
  const seen = new Set<string>();
  const unique = [];
  for (const row of rows) {
    const key = `${row.routeId}|${row.headsign}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
    if (unique.length >= limit) break;
  }
  return unique;
}

export function planTrip(
  atlas: Atlas,
  timetable: Timetable,
  from: Place,
  to: Place,
  now: number,
  active: Set<number>,
  bikes: BikeStation[] = [],
): Itinerary[] {
  if (!atlas || !timetable || !isFinitePoint(from) || !isFinitePoint(to) || !Number.isFinite(now)) return [];
  const routes = routeById(atlas);
  const stops = stopById(atlas);
  const rapidStops = atlas.stops.filter((stop) => {
    if (stop.kind === 1) return true;
    return stop.routes.some((id) => routes.get(id)?.type === 1 || routes.get(id)?.type === 2);
  });
  const fromStops = (
    from.stopId
      ? nearbyStops(atlas.stops, from, 220, 6).concat(
          stops.get(from.stopId) ? [{ ...stops.get(from.stopId)!, meters: 0 }] : [],
        )
      : nearbyStops(atlas.stops, from, 700, 12)
  ).concat(nearbyStops(rapidStops, from, 1300, 8));
  const toStops = (
    to.stopId
      ? nearbyStops(atlas.stops, to, 220, 6).concat(
          stops.get(to.stopId) ? [{ ...stops.get(to.stopId)!, meters: 0 }] : [],
        )
      : nearbyStops(atlas.stops, to, 700, 12)
  ).concat(nearbyStops(rapidStops, to, 1300, 8));

  const uniq = (list: Array<AtlasStop & { meters?: number }>) => {
    const map = new Map<string, AtlasStop & { meters?: number }>();
    for (const s of list) {
      const prev = map.get(s.id);
      if (!prev || (s.meters ?? 0) < (prev.meters ?? 0)) map.set(s.id, s);
    }
    return [...map.values()];
  };
  const origins = uniq(fromStops);
  const dests = uniq(toStops);

  const found: Itinerary[] = [];

  const walkM = haversineMeters(from, to);
  if (Number.isFinite(walkM) && walkM <= 2800) {
    const minutes = walkMinutes(walkM);
    if (minutes > 0) {
      found.push({
        id: itineraryId(["walk", from.label, to.label]),
        minutes,
        walkMeters: Math.round(walkM),
        transfers: 0,
        depart: now,
        arrive: now + minutes,
        legs: [{ kind: "walk", minutes, meters: Math.round(walkM), from, to }],
      });
    }
  }
  if (Number.isFinite(walkM) && walkM >= 500 && walkM < 200_000) {
    const minutes = roadMinutes(walkM);
    const walkMin = walkMinutes(walkM);
    if (minutes > 0 && minutes !== walkMin) {
      found.push({
        id: itineraryId(["road", from.label, to.label]),
        minutes,
        walkMeters: 0,
        transfers: 0,
        depart: now,
        arrive: now + minutes,
        legs: [{ kind: "road", minutes, meters: Math.round(walkM), from, to }],
      });
    }
  }

  for (const origin of origins) {
    for (const dest of dests) {
      if (origin.id === dest.id) continue;
      const destLine = new Set(
        dest.routes
          .map((id) => routes.get(id))
          .filter((route): route is AtlasRoute => Boolean(route))
          .map((route) => `${route.agencyId}|${route.shortName}`),
      );
      const shared = origin.routes.filter((id) => {
        if (dest.routes.includes(id)) return true;
        const route = routes.get(id);
        return Boolean(route && destLine.has(`${route.agencyId}|${route.shortName}`));
      });
      for (const routeId of shared) {
        const route = routes.get(routeId);
        if (!route) continue;
        for (const dir of route.dirs) {
          const i = indexOnDir(dir.stops, origin);
          const j = indexOnDir(dir.stops, dest);
          if (i < 0 || j <= i) continue;
          const ride = hopSum(dir.hops, i, j);
          const next = nextDeparture(timetable, origin, route.id, dir.id, now, active);
          if (!next) continue;
          const walk1 = haversineMeters(from, origin);
          const walk2 = haversineMeters(dest, to);
          const w1 = walk1 > 40 ? walkMinutes(walk1) : 0;
          const w2 = walk2 > 40 ? walkMinutes(walk2) : 0;
          const board = Math.max(now + w1, next.depart);
          const arriveRide = board + ride;
          const arrive = arriveRide + w2;
          const oPlace = placeFromStop(origin);
          const dPlace = placeFromStop(dest);
          const legs: TripLeg[] = [];
          if (w1 > 0) {
            legs.push({
              kind: "walk",
              minutes: w1,
              meters: Math.round(walk1),
              from,
              to: oPlace,
            });
          }
          legs.push({
            kind: "transit",
            minutes: ride,
            routeId: route.id,
            shortName: route.shortName,
            color: route.color,
            textColor: route.textColor,
            headsign: next.headsign || dir.headsign,
            type: route.type,
            agencyId: route.agencyId,
            from: oPlace,
            to: dPlace,
            depart: board,
            arrive: arriveRide,
            stopIds: dir.stops.slice(i, j + 1),
            line: dir.line,
          });
          if (w2 > 0) {
            legs.push({
              kind: "walk",
              minutes: w2,
              meters: Math.round(walk2),
              from: dPlace,
              to,
            });
          }
          found.push({
            id: itineraryId(["direct", route.id, String(dir.id), origin.id, dest.id, String(board)]),
            minutes: arrive - now,
            walkMeters: Math.round((w1 ? walk1 : 0) + (w2 ? walk2 : 0)),
            transfers: 0,
            depart: w1 > 0 ? now : board,
            arrive,
            legs,
          });
        }
      }
    }
  }

  if (bikes.length > 0) {
    const start = nearbyStations(bikes, from, 480, "bikes", 1)[0];
    const end = nearbyStations(bikes, to, 480, "docks", 1)[0];
    if (start && end && start.id !== end.id) {
      const rideM = haversineMeters(start, end);
      const toStart = haversineMeters(from, start);
      const fromEnd = haversineMeters(end, to);
      const w1 = toStart > 40 ? walkMinutes(toStart) : 0;
      const ride = bikeMinutes(rideM);
      const w2 = fromEnd > 40 ? walkMinutes(fromEnd) : 0;
      const startPlace = { label: start.name, lon: start.lon, lat: start.lat };
      const endPlace = { label: end.name, lon: end.lon, lat: end.lat };
      const legs: TripLeg[] = [];
      if (w1 > 0) {
        legs.push({ kind: "walk", minutes: w1, meters: Math.round(toStart), from, to: startPlace });
      }
      legs.push({
        kind: "bike",
        minutes: ride,
        meters: Math.round(rideM),
        system: start.system,
        from: startPlace,
        to: endPlace,
      });
      if (w2 > 0) {
        legs.push({ kind: "walk", minutes: w2, meters: Math.round(fromEnd), from: endPlace, to });
      }
      found.push({
        id: itineraryId(["bike", start.id, end.id]),
        minutes: w1 + ride + w2,
        walkMeters: Math.round((w1 ? toStart : 0) + (w2 ? fromEnd : 0)),
        transfers: 0,
        depart: now,
        arrive: now + w1 + ride + w2,
        legs,
      });
    }
  }

  transferSearch: for (const origin of origins.slice(0, 6)) {
    for (const dest of dests.slice(0, 6)) {
      for (const routeAId of origin.routes.slice(0, 8)) {
        for (const routeBId of dest.routes.slice(0, 8)) {
          if (routeAId === routeBId) continue;
          const routeA = routes.get(routeAId);
          const routeB = routes.get(routeBId);
          if (!routeA || !routeB) continue;
          for (const dirA of routeA.dirs) {
            const iA = indexOnDir(dirA.stops, origin);
            if (iA < 0) continue;
            for (const dirB of routeB.dirs) {
              const jB = indexOnDir(dirB.stops, dest);
              if (jB < 0) continue;
              let bestT: {
                stop: AtlasStop;
                walkTo?: AtlasStop;
                iT: number;
                jT: number;
              } | null = null;
              for (let iT = iA + 1; iT < dirA.stops.length; iT++) {
                const tid = dirA.stops[iT];
                const transferStop = stops.get(tid);
                if (!transferStop) continue;
                const jT = indexOnDir(dirB.stops, transferStop);
                if (jT < 0 || jT >= jB) continue;
                if (!bestT || iT - iA + (jB - jT) < bestT.iT - iA + (jB - bestT.jT)) {
                  bestT = { stop: transferStop, iT, jT };
                }
              }
              if (
                !bestT &&
                (routeA.type === 1 ||
                  routeB.type === 1 ||
                  routeA.agencyId !== routeB.agencyId)
              ) {
                let walkM = Infinity;
                const aEnd = Math.min(dirA.stops.length, iA + 14);
                for (let iT = iA + 1; iT < aEnd; iT++) {
                  const stopA = stops.get(dirA.stops[iT]);
                  if (!stopA) continue;
                  const bEnd = Math.min(jB, 18);
                  for (let jT = 0; jT < bEnd; jT++) {
                    const stopB = stops.get(dirB.stops[jT]);
                    if (!stopB || stopB.id === stopA.id) continue;
                    const gap = haversineMeters(stopA, stopB);
                    if (gap > 80 && gap < 1300 && gap < walkM) {
                      walkM = gap;
                      bestT = { stop: stopA, walkTo: stopB, iT, jT };
                    }
                  }
                }
              }
              if (!bestT) continue;
              const nextA = nextDeparture(
                timetable,
                origin,
                routeA.id,
                dirA.id,
                now,
                active,
              );
              if (!nextA) continue;
              const rideA = hopSum(dirA.hops, iA, bestT.iT);
              const walk1 = haversineMeters(from, origin);
              const w1 = walk1 > 40 ? walkMinutes(walk1) : 0;
              const boardA = Math.max(now + w1, nextA.depart);
              const arriveA = boardA + rideA;
              const nextB = nextDeparture(
                timetable,
                bestT.walkTo ?? bestT.stop,
                routeB.id,
                dirB.id,
                arriveA + 2,
                active,
              );
              if (!nextB) continue;
              const rideB = hopSum(dirB.hops, bestT.jT, jB);
              const boardB = Math.max(arriveA + 2, nextB.depart);
              const arriveB = boardB + rideB;
              const walk2 = haversineMeters(dest, to);
              const w2 = walk2 > 40 ? walkMinutes(walk2) : 0;
              const arrive = arriveB + w2;
              const oPlace = placeFromStop(origin);
              const tPlace = placeFromStop(bestT.stop);
              const boardPlace = placeFromStop(bestT.walkTo ?? bestT.stop);
              const dPlace = placeFromStop(dest);
              const gap = connectorWalk(bestT.stop, bestT.walkTo, boardB - arriveA);
              const legs: TripLeg[] = [];
              if (w1 > 0) {
                legs.push({
                  kind: "walk",
                  minutes: w1,
                  meters: Math.round(walk1),
                  from,
                  to: oPlace,
                });
              }
              legs.push({
                kind: "transit",
                minutes: rideA,
                routeId: routeA.id,
                shortName: routeA.shortName,
                color: routeA.color,
                textColor: routeA.textColor,
                headsign: nextA.headsign || dirA.headsign,
                type: routeA.type,
                agencyId: routeA.agencyId,
                from: oPlace,
                to: tPlace,
                depart: boardA,
                arrive: arriveA,
                stopIds: dirA.stops.slice(iA, bestT.iT + 1),
                line: dirA.line,
              });
              legs.push(gap);
              legs.push({
                kind: "transit",
                minutes: rideB,
                routeId: routeB.id,
                shortName: routeB.shortName,
                color: routeB.color,
                textColor: routeB.textColor,
                headsign: nextB.headsign || dirB.headsign,
                type: routeB.type,
                agencyId: routeB.agencyId,
                from: boardPlace,
                to: dPlace,
                depart: boardB,
                arrive: arriveB,
                stopIds: dirB.stops.slice(bestT.jT, jB + 1),
                line: dirB.line,
              });
              if (w2 > 0) {
                legs.push({
                  kind: "walk",
                  minutes: w2,
                  meters: Math.round(walk2),
                  from: dPlace,
                  to,
                });
              }
              found.push({
                id: itineraryId([
                  "xfer",
                  routeA.id,
                  routeB.id,
                  origin.id,
                  bestT.stop.id,
                  dest.id,
                  String(boardA),
                ]),
                minutes: arrive - now,
                walkMeters: Math.round((w1 ? walk1 : 0) + (w2 ? walk2 : 0) + gap.meters),
                transfers: 1,
                depart: w1 > 0 ? now : boardA,
                arrive,
                legs,
              });
              if (found.length > 18) break transferSearch;
            }
          }
        }
      }
    }
  }

  const usable = found.filter((item) => item.minutes <= 12 * 60);
  const pool = usable.length > 0 ? usable : found;
  pool.sort((a, b) => a.minutes - b.minutes || a.arrive - b.arrive || a.walkMeters - b.walkMeters);
  const unique: Itinerary[] = [];
  const seen = new Set<string>();
  const familyOf = (item: Itinerary) => {
    if (item.legs.every((leg) => leg.kind === "walk")) return "marche";
    if (item.legs.some((leg) => leg.kind === "bike") && !item.legs.some((leg) => leg.kind === "transit")) {
      return "velo";
    }
    if (item.legs.some((leg) => leg.kind === "road")) return "auto";
    if (item.legs.some((leg) => leg.kind === "transit" && "type" in leg && leg.type === 1)) return "metro";
    if (item.legs.some((leg) => leg.kind === "transit" && "type" in leg && leg.type === 2)) return "train";
    if (item.legs.some((leg) => leg.kind === "transit")) return "bus";
    return "other";
  };
  const signatureOf = (item: Itinerary) =>
    item.legs
      .map((leg) =>
        leg.kind === "walk"
          ? `w:${leg.to.label}`
          : leg.kind === "bike"
            ? `b:${leg.system}:${leg.from.label}`
            : leg.kind === "road"
              ? `r:${leg.to.label}`
              : `t:${leg.shortName}:${leg.headsign}:${leg.from.stopId}`,
      )
      .join(">");
  const take = (item: Itinerary) => {
    const signature = signatureOf(item);
    if (seen.has(signature)) return false;
    seen.add(signature);
    unique.push(item);
    return true;
  };
  for (const item of pool) {
    take(item);
    if (unique.length >= 6) break;
  }
  for (const family of ["marche", "velo", "auto", "metro", "train", "bus"]) {
    if (unique.some((item) => familyOf(item) === family)) continue;
    const extra = pool.find((item) => familyOf(item) === family);
    if (extra) take(extra);
  }
  unique.sort((a, b) => a.minutes - b.minutes || a.arrive - b.arrive || a.walkMeters - b.walkMeters);
  return unique.slice(0, 8);
}
