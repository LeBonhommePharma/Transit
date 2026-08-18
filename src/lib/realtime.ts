import { decodePolyline } from "./geo";
import type { LineDue } from "./lines";
import { formatClock } from "./time";

export type TripUpdate = {
  routeId?: string;
  stopId?: string;
  delaySec?: number;
  canceled?: boolean;
  departure?: number;
};

export type VehiclePosition = {
  routeId?: string;
  lon: number;
  lat: number;
};

export function applyTripUpdate(depart: number, update: TripUpdate): number | null {
  if (update.canceled) return null;
  if (typeof update.departure === "number" && Number.isFinite(update.departure)) {
    return update.departure;
  }
  if (typeof update.delaySec === "number" && Number.isFinite(update.delaySec)) {
    return depart + Math.round(update.delaySec / 60);
  }
  return depart;
}

function matchesDue(row: LineDue, update: TripUpdate): boolean {
  if (update.routeId && update.routeId !== row.routeId) return false;
  if (update.stopId && update.stopId !== row.stopId) return false;
  return Boolean(update.routeId || update.stopId);
}

/** Overlay official trip updates onto next-due rows. Times move; canceled trips drop. */
export function applyTripUpdatesToDue(
  due: LineDue[],
  updates: TripUpdate[],
  now: number,
): LineDue[] {
  if (!updates.length) return due;
  const out: LineDue[] = [];
  for (const row of due) {
    const update = updates.find((item) => matchesDue(row, item));
    if (!update) {
      out.push(row);
      continue;
    }
    const depart = applyTripUpdate(row.depart, update);
    if (depart == null) continue;
    out.push({
      ...row,
      depart,
      wait: depart - now,
      clocks: [formatClock(depart), ...row.clocks.slice(1)],
    });
  }
  return out;
}

/** Vehicle position and/or a changed shape replace the frozen ingest polyline. */
export function trajectoryAfterRealtime(
  staticEncoded: string,
  patch: { vehicle?: VehiclePosition; shape?: string },
): [number, number][] {
  if (patch.shape) return decodePolyline(patch.shape);
  const base = decodePolyline(staticEncoded);
  if (patch.vehicle && Number.isFinite(patch.vehicle.lon) && Number.isFinite(patch.vehicle.lat)) {
    return [[patch.vehicle.lon, patch.vehicle.lat], ...base];
  }
  return base;
}

export function samePolyline(a: [number, number][], b: [number, number][]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false;
  }
  return true;
}
