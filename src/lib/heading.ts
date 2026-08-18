/** Compass heading from a device sample. Missing or garbage → null, never invented north. */

export type Heading = {
  degrees: number;
  cardinal: string;
};

const CARDINALS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Normalize a heading or device-orientation alpha into [0, 360) plus a cardinal. */
export function headingFromSample(
  sample:
    | number
    | {
        heading?: unknown;
        alpha?: unknown;
        webkitCompassHeading?: unknown;
      }
    | null
    | undefined,
): Heading | null {
  let raw: number | null = null;
  if (typeof sample === "number" || typeof sample === "string") {
    raw = asFiniteNumber(sample);
  } else if (sample && typeof sample === "object") {
    raw =
      asFiniteNumber(sample.heading) ??
      asFiniteNumber(sample.webkitCompassHeading) ??
      asFiniteNumber(sample.alpha);
  }
  if (raw == null || raw < 0) return null;
  const degrees = ((raw % 360) + 360) % 360;
  const cardinal = CARDINALS[Math.round(degrees / 45) % 8];
  return { degrees, cardinal };
}
