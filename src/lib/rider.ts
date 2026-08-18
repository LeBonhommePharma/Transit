/** Successive connected-rider fixes. Time order only; stale and non-finite samples drop. */

export type RiderFix = {
  lon: number;
  lat: number;
  at: number;
  source?: string;
  accuracy?: number;
};

export type RiderStore = {
  here: RiderFix | null;
};

export const RIDER_STALE_MS = 5 * 60 * 1000;

function finiteCoord(value: unknown, maxAbs: number): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > maxAbs) return null;
  return n;
}

export function emptyRiderStore(): RiderStore {
  return { here: null };
}

/** Drop an in-app GPS grant so the next locate must ask again. Map fallbacks stay map. */
export function forgetInAppLocationGrant(store: RiderStore): RiderStore {
  if (!store || !store.here) return { here: null };
  if (store.here.source === "gps") return { here: null };
  return { here: { ...store.here } };
}

/** Only a real GPS/watch fix may enter the crowd-probe store. Map-center fallbacks never invent a bus. */
export function isCrowdProbeSource(source: unknown): boolean {
  return source === "gps";
}

/**
 * Accept a newer finite lon/lat as here. Older-than-current, too-old vs `now`,
 * or non-finite samples leave the store unchanged.
 */
export function acceptRiderFix(
  store: RiderStore,
  sample: { lon?: unknown; lat?: unknown; at?: unknown; source?: unknown; accuracy?: unknown },
  now?: number,
): RiderStore {
  const lon = finiteCoord(sample.lon, 180);
  const lat = finiteCoord(sample.lat, 90);
  const at = typeof sample.at === "number" && Number.isFinite(sample.at) ? sample.at : Number(sample.at);
  if (lon == null || lat == null || !Number.isFinite(at)) return store;
  const clock = typeof now === "number" && Number.isFinite(now) ? now : at;
  const source = typeof sample.source === "string" && sample.source ? sample.source : "gps";
  if (clock - at > RIDER_STALE_MS) return store;
  if (store.here && at < store.here.at && !(source === "gps" && store.here.source === "map")) return store;
  const accuracy =
    typeof sample.accuracy === "number" && Number.isFinite(sample.accuracy) ? sample.accuracy : undefined;
  return { here: { lon, lat, at, source, accuracy } };
}
