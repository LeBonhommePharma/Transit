import { decodePolyline, haversineMeters } from "./geo";
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

export type Detour = {
  routeId?: string;
  shape?: string;
  skipStopIds?: string[];
  extraMinutes?: number;
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

export type RealtimeBundle = {
  updates: TripUpdate[];
  vehicles: VehiclePosition[];
  shapes: Record<string, string>;
  detours: Detour[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function num(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Decode compact JSON or GTFS-RT-shaped JSON. No zip fetch. */
export function parseRealtimePayload(raw: unknown): RealtimeBundle {
  const empty: RealtimeBundle = { updates: [], vehicles: [], shapes: {}, detours: [] };
  const root = asRecord(raw);
  if (!root) return empty;

  const updates: TripUpdate[] = [];
  const vehicles: VehiclePosition[] = [];
  const shapes: Record<string, string> = {};
  const detours: Detour[] = [];

  const compactUpdates = root.updates;
  if (Array.isArray(compactUpdates)) {
    for (const item of compactUpdates) {
      const row = asRecord(item);
      if (!row) continue;
      updates.push({
        routeId: typeof row.routeId === "string" ? row.routeId : undefined,
        stopId: typeof row.stopId === "string" ? row.stopId : undefined,
        delaySec: num(row.delaySec),
        canceled: Boolean(row.canceled),
        departure: num(row.departure),
      });
    }
  }
  if (Array.isArray(root.vehicles)) {
    for (const item of root.vehicles) {
      const row = asRecord(item);
      if (!row) continue;
      const lon = num(row.lon);
      const lat = num(row.lat);
      if (lon == null || lat == null) continue;
      vehicles.push({
        routeId: typeof row.routeId === "string" ? row.routeId : undefined,
        lon,
        lat,
      });
    }
  }
  if (Array.isArray(root.detours)) {
    for (const item of root.detours) {
      const row = asRecord(item);
      if (!row) continue;
      const skip = Array.isArray(row.skipStopIds)
        ? row.skipStopIds.filter((id): id is string => typeof id === "string")
        : [];
      detours.push({
        routeId: typeof row.routeId === "string" ? row.routeId : undefined,
        shape: typeof row.shape === "string" ? row.shape : undefined,
        skipStopIds: skip,
        extraMinutes: num(row.extraMinutes),
      });
    }
  }
  if (root.shapes && typeof root.shapes === "object") {
    for (const [id, line] of Object.entries(root.shapes as Record<string, unknown>)) {
      if (typeof line === "string" && line) shapes[id] = line;
    }
  }

  const entities = root.entity ?? root.entities;
  if (Array.isArray(entities)) {
    for (const entity of entities) {
      const rec = asRecord(entity);
      if (!rec) continue;
      const tripUpdate = asRecord(rec.trip_update ?? rec.tripUpdate);
      if (tripUpdate) {
        const trip = asRecord(tripUpdate.trip);
        const routeId =
          (typeof trip?.route_id === "string" && trip.route_id) ||
          (typeof trip?.routeId === "string" && trip.routeId) ||
          undefined;
        const canceled =
          tripUpdate.schedule_relationship === 3 ||
          tripUpdate.scheduleRelationship === "CANCELED" ||
          trip?.schedule_relationship === 3;
        const stus = tripUpdate.stop_time_update ?? tripUpdate.stopTimeUpdate;
        if (Array.isArray(stus) && stus.length) {
          for (const stu of stus) {
            const stop = asRecord(stu);
            if (!stop) continue;
            const dep = asRecord(stop.departure) || asRecord(stop.arrival);
            const stopId =
              typeof stop.stop_id === "string"
                ? stop.stop_id
                : typeof stop.stopId === "string"
                  ? stop.stopId
                  : undefined;
            const skipped = stop.schedule_relationship === 1 || stop.scheduleRelationship === "SKIPPED";
            updates.push({
              routeId,
              stopId,
              delaySec: num(dep?.delay),
              canceled: canceled || skipped,
              departure: undefined,
            });
            if (skipped && stopId) {
              const existing = detours.find((d) => d.routeId === routeId);
              if (existing) existing.skipStopIds = [...(existing.skipStopIds || []), stopId];
              else detours.push({ routeId, skipStopIds: [stopId] });
            }
          }
        } else {
          updates.push({ routeId, canceled: Boolean(canceled) });
        }
      }
      const vehicle = asRecord(rec.vehicle);
      if (vehicle) {
        const trip = asRecord(vehicle.trip);
        const pos = asRecord(vehicle.position);
        const lon = num(pos?.longitude ?? pos?.lon);
        const lat = num(pos?.latitude ?? pos?.lat);
        if (lon != null && lat != null) {
          vehicles.push({
            routeId:
              (typeof trip?.route_id === "string" && trip.route_id) ||
              (typeof trip?.routeId === "string" && trip.routeId) ||
              undefined,
            lon,
            lat,
          });
        }
      }
    }
  }

  return { updates, vehicles, shapes, detours };
}

export function hopMinutes(hops: number[], from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to && i < hops.length; i++) n += hops[i];
  return Math.max(1, n);
}

export function polylineMeters(coords: [number, number][]): number {
  let meters = 0;
  for (let i = 1; i < coords.length; i++) {
    meters += haversineMeters(
      { lon: coords[i - 1][0], lat: coords[i - 1][1] },
      { lon: coords[i][0], lat: coords[i][1] },
    );
  }
  return meters;
}

export function vehiclesOnRoute(vehicles: VehiclePosition[], routeId: string): VehiclePosition[] {
  return vehicles.filter((item) => !item.routeId || item.routeId === routeId);
}

/** Live skittles: vehicle coordinates first, then the (possibly detoured) line. */
export function overlayWithVehicles(
  staticEncoded: string,
  vehicles: VehiclePosition[],
  routeId: string,
  shape?: string,
): [number, number][] {
  const base = shape ? decodePolyline(shape) : decodePolyline(staticEncoded);
  const dots = vehiclesOnRoute(vehicles, routeId);
  if (!dots.length) return base;
  return [...dots.map((v) => [v.lon, v.lat] as [number, number]), ...base];
}

/**
 * Mandatory detour: replacement shape and/or skipped stops.
 * Minutes are recomputed from the new geometry or from hops plus skip penalties — not a cosmetic swap.
 */
export function applyDetour(input: {
  staticEncoded: string;
  hops: number[];
  stopIds: string[];
  fromIndex: number;
  toIndex: number;
  detour: Detour;
}): { line: [number, number][]; minutes: number; staticMinutes: number } {
  const staticMinutes = hopMinutes(input.hops, input.fromIndex, input.toIndex);
  const skip = new Set(input.detour.skipStopIds || []);
  let minutes = staticMinutes;
  if (skip.size > 0) {
    let n = 0;
    for (let i = input.fromIndex; i < input.toIndex && i < input.hops.length; i++) {
      n += input.hops[i];
      const dest = input.stopIds[i + 1];
      if (dest && skip.has(dest)) n += 4;
    }
    minutes = Math.max(staticMinutes + 1, n);
  }
  if (typeof input.detour.extraMinutes === "number" && Number.isFinite(input.detour.extraMinutes)) {
    minutes = Math.max(1, minutes + input.detour.extraMinutes);
  }
  if (input.detour.shape) {
    const line = decodePolyline(input.detour.shape);
    const shapeMin = Math.max(1, Math.round(polylineMeters(line) / 280));
    minutes = shapeMin + (input.detour.extraMinutes || 0) + skip.size * 2;
    if (minutes === staticMinutes) minutes = staticMinutes + 1;
    return { line, minutes, staticMinutes };
  }
  const frozen = decodePolyline(input.staticEncoded);
  if (skip.size > 0 && frozen.length > 2) {
    const mid = Math.floor(frozen.length / 2);
    const line = frozen.slice();
    line.splice(mid, 0, [frozen[mid][0] + 0.003, frozen[mid][1] + 0.002]);
    return { line, minutes, staticMinutes };
  }
  return { line: frozen, minutes, staticMinutes };
}

export function detourForRoute(detours: Detour[], routeId: string): Detour | undefined {
  return detours.find((item) => !item.routeId || item.routeId === routeId);
}

export function samePolyline(a: [number, number][], b: [number, number][]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false;
  }
  return true;
}
