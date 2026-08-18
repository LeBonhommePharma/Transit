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

export type TempStop = {
  id: string;
  name: string;
  lon: number;
  lat: number;
  routeId?: string;
};

export type Detour = {
  routeId?: string;
  shape?: string;
  skipStopIds?: string[];
  extraMinutes?: number;
  tempStops?: TempStop[];
  from?: number;
  until?: number;
};

function epochMs(value: unknown): number | undefined {
  const n = num(value);
  if (n == null) return undefined;
  return n < 1e12 ? n * 1000 : n;
}

export function detourWindow(row: Record<string, unknown>): { from?: number; until?: number } {
  const periods = row.activePeriod ?? row.active_period;
  const first = Array.isArray(periods) ? asRecord(periods[0]) : asRecord(periods);
  return {
    from: epochMs(row.from ?? row.start ?? row.validFrom ?? first?.start),
    until: epochMs(row.until ?? row.end ?? row.validUntil ?? first?.end),
  };
}

export function detourIsActive(detour: Detour, now = Date.now()): boolean {
  if (typeof detour.from === "number" && Number.isFinite(detour.from) && now < detour.from) return false;
  if (typeof detour.until === "number" && Number.isFinite(detour.until) && now >= detour.until) return false;
  return true;
}

export function activeDetours(detours: Detour[], now = Date.now()): Detour[] {
  return detours.filter((item) => detourIsActive(item, now));
}

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

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function parseTempStops(raw: unknown): TempStop[] {
  if (!Array.isArray(raw)) return [];
  const out: TempStop[] = [];
  for (const item of raw) {
    const row = asRecord(item);
    if (!row) continue;
    const lon = num(row.lon ?? row.longitude ?? row.stop_lon);
    const lat = num(row.lat ?? row.latitude ?? row.stop_lat);
    if (lon == null || lat == null || (lon === 0 && lat === 0)) continue;
    const id = str(row.id) || str(row.stopId) || str(row.stop_id);
    if (!id) continue;
    out.push({
      id,
      name: str(row.name) || str(row.stop_name) || id,
      lon,
      lat,
      routeId: str(row.routeId) || str(row.route_id),
    });
  }
  return out;
}

function addSkip(detours: Detour[], routeId: string | undefined, stopId: string) {
  const existing = detours.find((d) => d.routeId === routeId);
  if (existing) {
    existing.skipStopIds = [...(existing.skipStopIds || []), stopId];
    return;
  }
  detours.push({ routeId, skipStopIds: [stopId] });
}

function addTemp(detours: Detour[], routeId: string | undefined, stop: TempStop) {
  const existing = detours.find((d) => d.routeId === routeId);
  const row = { ...stop, routeId: stop.routeId || routeId };
  if (existing) {
    existing.tempStops = [...(existing.tempStops || []), row];
    return;
  }
  detours.push({ routeId, tempStops: [row] });
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
      const temps = parseTempStops(row.tempStops ?? row.temporaryStops ?? row.addedStops);
      const window = detourWindow(row);
      detours.push({
        routeId: typeof row.routeId === "string" ? row.routeId : typeof row.route_id === "string" ? row.route_id : undefined,
        shape: typeof row.shape === "string" ? row.shape : undefined,
        skipStopIds: skip,
        extraMinutes: num(row.extraMinutes),
        tempStops: temps,
        from: window.from,
        until: window.until,
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
            if (skipped && stopId) addSkip(detours, routeId, stopId);
          }
        } else {
          updates.push({ routeId, canceled: Boolean(canceled) });
        }
      }
      const alert = asRecord(rec.alert);
      if (alert) {
        const effect = alert.effect;
        const skipEffect =
          effect === 2 ||
          effect === 5 ||
          effect === 9 ||
          effect === "NO_SERVICE" ||
          effect === "DETOUR" ||
          effect === "STOP_MOVED";
        const informed = alert.informed_entity ?? alert.informedEntity;
        if (skipEffect && Array.isArray(informed)) {
          for (const ent of informed) {
            const row = asRecord(ent);
            if (!row) continue;
            const routeId = str(row.route_id) || str(row.routeId);
            const stopId = str(row.stop_id) || str(row.stopId);
            if (stopId) addSkip(detours, routeId, stopId);
          }
        }
        const temps = parseTempStops(
          alert.tempStops ?? alert.temporaryStops ?? alert.addedStops ?? alert.replacement_stops,
        );
        for (const stop of temps) addTemp(detours, stop.routeId, stop);
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
  now?: number;
}): { line: [number, number][]; minutes: number; staticMinutes: number } {
  const staticMinutes = hopMinutes(input.hops, input.fromIndex, input.toIndex);
  if (!detourIsActive(input.detour, input.now)) {
    return { line: decodePolyline(input.staticEncoded), minutes: staticMinutes, staticMinutes };
  }
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

export function detourForRoute(detours: Detour[], routeId: string, now = Date.now()): Detour | undefined {
  return activeDetours(detours, now).find((item) => !item.routeId || item.routeId === routeId);
}

export function skippedStopIds(detours: Detour[], routeId?: string): Set<string> {
  const ids = new Set<string>();
  for (const d of detours) {
    if (routeId && d.routeId && d.routeId !== routeId) continue;
    for (const id of d.skipStopIds || []) ids.add(id);
  }
  return ids;
}

export function temporaryStopsForRoute(detours: Detour[], routeId?: string): TempStop[] {
  const out: TempStop[] = [];
  const seen = new Set<string>();
  for (const d of detours) {
    if (routeId && d.routeId && d.routeId !== routeId) continue;
    for (const stop of d.tempStops || []) {
      if (seen.has(stop.id)) continue;
      if (routeId && stop.routeId && stop.routeId !== routeId) continue;
      seen.add(stop.id);
      out.push(stop);
    }
  }
  return out;
}

export type DetourStop = {
  id: string;
  name: string;
  lon: number;
  lat: number;
  routes: string[];
  kind?: number;
  temporary?: boolean;
};

export function mergeStopsWithDetours(
  stops: Array<{ id: string; name: string; lon: number; lat: number; routes: string[]; kind?: number }>,
  detours: Detour[],
  now = Date.now(),
): DetourStop[] {
  detours = activeDetours(detours, now);
  const banned = new Map<string, Set<string>>();
  for (const d of detours) {
    for (const id of d.skipStopIds || []) {
      const set = banned.get(id) || new Set<string>();
      set.add(d.routeId || "*");
      banned.set(id, set);
    }
  }
  const out: DetourStop[] = [];
  for (const stop of stops) {
    const drop = banned.get(stop.id);
    if (!drop) {
      out.push({ ...stop, routes: [...(stop.routes || [])] });
      continue;
    }
    if (drop.has("*")) continue;
    const routes = (stop.routes || []).filter((id) => !drop.has(id));
    if (!routes.length && (stop.routes || []).length) continue;
    out.push({ ...stop, routes });
  }
  for (const temp of temporaryStopsForRoute(detours)) {
    const hit = out.find((s) => s.id === temp.id);
    const rid = temp.routeId;
    if (hit) {
      if (rid && !hit.routes.includes(rid)) hit.routes.push(rid);
      hit.temporary = true;
      continue;
    }
    out.push({
      id: temp.id,
      name: temp.name,
      lon: temp.lon,
      lat: temp.lat,
      routes: rid ? [rid] : [],
      kind: 0,
      temporary: true,
    });
  }
  return out;
}

export function samePolyline(a: [number, number][], b: [number, number][]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false;
  }
  return true;
}
