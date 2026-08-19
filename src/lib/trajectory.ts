import type { Itinerary, Place, Timetable, TripLeg, Atlas } from "./atlas/types";
import type { BikeStation } from "./bikeshare";
import { bikeMinutes } from "./bikeshare";
import { walkMinutes } from "./geo";
import { planTrip } from "./planner";

export type TrajectoryOption = {
  mix: string;
  minutes: number;
  walkMeters: number;
  itinerary: Itinerary;
};

function metersOf(leg: TripLeg): number {
  return "meters" in leg ? leg.meters : 0;
}

function asAccess(leg: TripLeg, mode: "walk" | "bike"): TripLeg {
  const meters = metersOf(leg);
  if (mode === "walk") {
    return {
      kind: "walk",
      minutes: meters > 0 ? walkMinutes(meters) : leg.minutes,
      meters,
      from: leg.from,
      to: leg.to,
    };
  }
  return {
    kind: "bike",
    minutes: meters > 0 ? bikeMinutes(meters) : Math.max(1, Math.round(leg.minutes / 3)),
    meters,
    system: "avelo",
    from: leg.from,
    to: leg.to,
  };
}

function isAccess(leg: TripLeg | undefined): boolean {
  return Boolean(leg && (leg.kind === "walk" || leg.kind === "bike"));
}

export function mixLabel(legs: TripLeg[]): string {
  const parts: string[] = [];
  for (const leg of legs) {
    const name =
      leg.kind === "walk"
        ? "marche"
        : leg.kind === "bike"
          ? "vélo"
          : leg.kind === "transit" && "type" in leg && leg.type === 1
            ? "métro"
            : "bus";
    if (parts[parts.length - 1] !== name) parts.push(name);
  }
  return parts.join(" + ") || "marche";
}

export function applyAccessModes(
  itinerary: Itinerary,
  access: "walk" | "bike" | null,
  egress: "walk" | "bike" | null,
): Itinerary {
  const legs = itinerary.legs.map((leg) => ({ ...leg }));
  if (legs.length === 0) return itinerary;
  let delta = 0;
  if (access && isAccess(legs[0])) {
    const old = legs[0].minutes;
    legs[0] = asAccess(legs[0], access);
    delta += legs[0].minutes - old;
  }
  const last = legs.length - 1;
  if (egress && last > 0 && isAccess(legs[last])) {
    const old = legs[last].minutes;
    legs[last] = asAccess(legs[last], egress);
    delta += legs[last].minutes - old;
  } else if (egress && last === 0 && isAccess(legs[0]) && access && access !== egress) {
    /* single-leg trip already handled by access */
  }
  const walkMeters = legs
    .filter((leg) => leg.kind === "walk")
    .reduce((sum, leg) => sum + metersOf(leg), 0);
  return {
    ...itinerary,
    id: `${itinerary.id}|${access ?? "-"}|${egress ?? "-"}`,
    minutes: itinerary.minutes + delta,
    arrive: itinerary.arrive + delta,
    walkMeters,
    legs,
  };
}

export function trajectoryChoices(itineraries: Itinerary[]): TrajectoryOption[] {
  const out: TrajectoryOption[] = [];
  const seen = new Set<string>();
  for (const itinerary of itineraries) {
    const firstAccess = isAccess(itinerary.legs[0]);
    const lastAccess = itinerary.legs.length > 1 && isAccess(itinerary.legs[itinerary.legs.length - 1]);
    const accessModes: Array<"walk" | "bike" | null> = firstAccess ? ["walk", "bike"] : [null];
    const egressModes: Array<"walk" | "bike" | null> = lastAccess ? ["walk", "bike"] : [null];
    if (itinerary.legs.length === 1 && firstAccess) {
      for (const mode of ["walk", "bike"] as const) {
        const next = applyAccessModes(itinerary, mode, null);
        const mix = mixLabel(next.legs);
        const key = `${mix}|${next.minutes}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ mix, minutes: next.minutes, walkMeters: next.walkMeters, itinerary: next });
      }
      continue;
    }
    for (const access of accessModes) {
      for (const egress of egressModes) {
        const next = applyAccessModes(itinerary, access, egress);
        const mix = mixLabel(next.legs);
        const key = `${mix}|${next.minutes}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ mix, minutes: next.minutes, walkMeters: next.walkMeters, itinerary: next });
      }
    }
  }
  out.sort((a, b) => a.minutes - b.minutes || a.mix.localeCompare(b.mix, "fr"));
  return out;
}

/** Rome2Rio-style: shortest door-to-door minutes first. Does not prefer métro. */
export function rankByDoorToDoor<T extends { minutes: number }>(options: T[]): T[] {
  return [...options].sort((a, b) => a.minutes - b.minutes);
}

/** Minutes slower than the fastest option. Fastest gap is 0. */
export function annotateTimeGaps<T extends { minutes: number }>(options: T[]): Array<T & { gap: number }> {
  if (!options.length) return [];
  const fastest = Math.min(...options.map((row) => row.minutes));
  return options.map((row) => ({ ...row, gap: row.minutes - fastest }));
}

export function planTrajectories(
  atlas: Atlas,
  timetable: Timetable,
  from: Place,
  to: Place,
  now: number,
  active: Set<number>,
  bikes: BikeStation[] = [],
): Array<TrajectoryOption & { gap: number }> {
  return annotateTimeGaps(rankByDoorToDoor(trajectoryChoices(planTrip(atlas, timetable, from, to, now, active, bikes))));
}
