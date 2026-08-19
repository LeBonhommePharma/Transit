/** Pinned weekday afternoon in America/Montreal, inside both feed windows. */
export const DAYTIME_CLOCK = "2026-08-18T16:00:00-04:00";

/** Same service day, later — a given time that is not "now". */
export const EVENING_CLOCK = "2026-08-18T20:00:00-04:00";

/** Same civil day, after local nightfall. */
export const NIGHT_CLOCK = "2026-08-18T23:30:00-04:00";

/** Same civil day, after sunset and before moonset. */
export const MOONLIGHT_CLOCK = "2026-08-18T21:00:00-04:00";

export function daytimeClock(): Date {
  return new Date(DAYTIME_CLOCK);
}

export function eveningClock(): Date {
  return new Date(EVENING_CLOCK);
}

export function nightClock(): Date {
  return new Date(NIGHT_CLOCK);
}

export function moonlightClock(): Date {
  return new Date(MOONLIGHT_CLOCK);
}
