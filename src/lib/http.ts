import type { Place } from "./atlas/types";

export type JsonRead<T> =
  | { ok: true; value: T }
  | { ok: false };

export async function readJsonBody<T = unknown>(request: Request): Promise<JsonRead<T>> {
  try {
    return { ok: true, value: (await request.json()) as T };
  } catch {
    return { ok: false };
  }
}

export function parseClock(value: string | null | undefined): Date | null {
  if (value == null || value === "") return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  return at;
}

export function isPlace(value: unknown): value is Place {
  if (!value || typeof value !== "object") return false;
  const place = value as Place;
  return (
    typeof place.label === "string" &&
    Number.isFinite(place.lon) &&
    Number.isFinite(place.lat)
  );
}
