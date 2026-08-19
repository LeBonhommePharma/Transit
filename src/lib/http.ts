import type { Place } from "./atlas/types";

export type JsonRead<T> =
  | { ok: true; value: T }
  | { ok: false };

export const MAX_JSON_BODY_BYTES = 64 * 1024;
export const MAX_QUERY_TEXT_LENGTH = 160;
const rateLimits = new Map<string, { startedAt: number; count: number }>();
const MAX_RATE_LIMIT_BUCKETS = 2_048;

export function allowRateLimit(key: string, maxRequests: number, windowMs: number, now = Date.now()): boolean {
  const current = rateLimits.get(key);
  if (!current || now - current.startedAt >= windowMs) {
    if (!current && rateLimits.size >= MAX_RATE_LIMIT_BUCKETS) {
      const oldest = [...rateLimits.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt)[0]?.[0];
      if (oldest) rateLimits.delete(oldest);
    }
    rateLimits.set(key, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= maxRequests) return false;
  current.count += 1;
  return true;
}

export function requestRateLimitKey(request: Request, scope: string): string {
  const cookie = request.headers.get("cookie")?.match(/(?:^|;\s*)rive_probe=([^;]+)/)?.[1];
  const forwarded = request.headers.get("cf-connecting-ip") || request.headers.get("x-real-ip") || request.headers.get("x-forwarded-for")?.split(",", 1)[0];
  const identity = (cookie || forwarded || "anonymous").slice(0, 128);
  return `${scope}:${identity}`;
}

export async function readJsonBody<T = unknown>(
  request: Request,
  maxBytes = MAX_JSON_BODY_BYTES,
): Promise<JsonRead<T>> {
  const advertised = request.headers.get("content-length");
  if (advertised != null) {
    if (!/^\d+$/.test(advertised)) return { ok: false };
    const length = Number(advertised);
    if (!Number.isSafeInteger(length) || length > maxBytes) return { ok: false };
  }
  if (!request.body) return { ok: false };

  try {
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) as T };
  } catch {
    return { ok: false };
  }
}

export function parseClock(value: unknown): Date | null {
  if (typeof value !== "string" || value === "" || value.length > 64) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  return at;
}

export function isFiniteCoordinate(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

export function isPlace(value: unknown): value is Place {
  if (!value || typeof value !== "object") return false;
  const place = value as Place;
  return (
    typeof place.label === "string" &&
    place.label.length > 0 &&
    place.label.length <= MAX_QUERY_TEXT_LENGTH &&
    isFiniteCoordinate(place.lon, -180, 180) &&
    isFiniteCoordinate(place.lat, -90, 90)
  );
}
