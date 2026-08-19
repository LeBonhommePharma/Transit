/** 2.5D building footprints. Official OSM tags; garbage in → no building. */

export type BuildingFootprint = {
  ring: [number, number][];
  heightM: number;
};

export const BUILDING_ZOOM = 12.6;
export const BUILDING_CAP = 280;
export const MOTION_BUILDING_CAP = 800;
export const MOTION_CORE_CAP = 320;
export const MOTION_MID_CAP = 240;
export const MOTION_FAR_CAP = 240;
const MAX_BUILDING_RING_POINTS = 2_000;

export function buildingHeightMeters(tags: unknown): number {
  if (!tags || typeof tags !== "object") return 10;
  const row = tags as Record<string, unknown>;
  const height = Number(row.height);
  if (Number.isFinite(height) && height > 2 && height < 400) return height;
  const levels = Number(row["building:levels"]);
  if (Number.isFinite(levels) && levels > 0 && levels < 80) return Math.max(6, levels * 3.2);
  return 10;
}

function closedRing(pts: [number, number][]): [number, number][] {
  if (pts.length < 3) return [];
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return pts;
  return pts.concat([first]);
}

/** Decode Overpass JSON or GeoJSON. Empty / junk → []. */
export function parseOverpassBuildings(raw: unknown, cap = BUILDING_CAP): BuildingFootprint[] {
  if (!raw || typeof raw !== "object") return [];
  const root = raw as Record<string, unknown>;
  const out: BuildingFootprint[] = [];
  const limit = Number.isFinite(cap)
    ? Math.min(MOTION_BUILDING_CAP, Math.max(0, Math.floor(cap)))
    : BUILDING_CAP;
  const elements = Array.isArray(root.elements) ? root.elements.slice(0, limit * 2) : [];
  for (const item of elements) {
    if (!item || typeof item !== "object") continue;
    const el = item as Record<string, unknown>;
    const geom = Array.isArray(el.geometry) ? el.geometry : [];
    const ring: [number, number][] = [];
    for (const pt of geom.slice(0, MAX_BUILDING_RING_POINTS)) {
      if (!pt || typeof pt !== "object") continue;
      const p = pt as { lon?: unknown; lat?: unknown };
      const lon = Number(p.lon);
      const lat = Number(p.lat);
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) continue;
      ring.push([lon, lat]);
    }
    const closed = closedRing(ring);
    if (closed.length < 4) continue;
    out.push({ ring: closed, heightM: buildingHeightMeters(el.tags) });
    if (out.length >= limit) break;
  }
  if (out.length === 0 && root.type === "FeatureCollection" && Array.isArray(root.features)) {
    for (const feat of root.features.slice(0, limit * 2)) {
      if (!feat || typeof feat !== "object") continue;
      const f = feat as { geometry?: { type?: string; coordinates?: unknown }; properties?: unknown };
      const coords = f.geometry && f.geometry.type === "Polygon" ? f.geometry.coordinates : null;
      const outer = Array.isArray(coords) ? coords[0] : null;
      if (!Array.isArray(outer)) continue;
      const ring: [number, number][] = [];
      for (const pt of outer.slice(0, MAX_BUILDING_RING_POINTS)) {
        if (!Array.isArray(pt) || pt.length < 2) continue;
        const lon = Number(pt[0]);
        const lat = Number(pt[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) continue;
        ring.push([lon, lat]);
      }
      const closed = closedRing(ring);
      if (closed.length < 4) continue;
      out.push({ ring: closed, heightM: buildingHeightMeters(f.properties) });
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** Screen slip for a 2.5D roof. Light from the north-west; pitch stands the wall up. */
export function extrudeOffsetPx(heightM: number, zoom: number, pitch = 0): { dx: number; dy: number } {
  if (!Number.isFinite(heightM) || heightM <= 0 || !Number.isFinite(zoom)) return { dx: 0, dy: 0 };
  const p = Number.isFinite(pitch) ? Math.min(1, Math.max(0, pitch)) : 0;
  const pxPerMeter = Math.max(0.15, 2 ** (zoom - 15) * 0.85);
  return {
    dx: heightM * pxPerMeter * (0.32 - p * 0.22),
    dy: -heightM * pxPerMeter * (0.58 + p * 1.7),
  };
}

export function wallQuads(
  ring: [number, number][],
  dx: number,
  dy: number,
): Array<[[number, number], [number, number], [number, number], [number, number]]> {
  const quads: Array<[[number, number], [number, number], [number, number], [number, number]]> = [];
  if (!ring || ring.length < 2) return quads;
  for (let i = 0; i < Math.min(ring.length - 1, MAX_BUILDING_RING_POINTS); i++) {
    const a = ring[i];
    const b = ring[i + 1];
    if (!a || !b) continue;
    const bTop: [number, number] = [b[0] + dx, b[1] + dy];
    const aTop: [number, number] = [a[0] + dx, a[1] + dy];
    quads.push([a, b, bTop, aTop]);
  }
  return quads;
}

function validBbox(bbox: { south: number; west: number; north: number; east: number } | null | undefined): boolean {
  if (!bbox) return false;
  return (
    Number.isFinite(bbox.south) &&
    Number.isFinite(bbox.west) &&
    Number.isFinite(bbox.north) &&
    Number.isFinite(bbox.east) &&
    bbox.south >= -90 &&
    bbox.north <= 90 &&
    bbox.west >= -180 &&
    bbox.east <= 180 &&
    bbox.south < bbox.north &&
    bbox.west < bbox.east &&
    bbox.north - bbox.south <= 1 &&
    bbox.east - bbox.west <= 1
  );
}

export function overpassQuery(
  bbox: { south: number; west: number; north: number; east: number },
  cap = BUILDING_CAP,
): string {
  if (!validBbox(bbox)) return "";
  const limit = Number.isFinite(cap) ? Math.min(MOTION_BUILDING_CAP, Math.max(1, Math.floor(cap))) : BUILDING_CAP;
  const s = [bbox.south, bbox.west, bbox.north, bbox.east]
    .map((n) => (Number.isFinite(n) ? n.toFixed(5) : ""))
    .join(",");
  return `[out:json][timeout:12];way["building"](${s});out tags geom ${limit};`;
}

function coarseCoord(n: number, step = 0.002): number {
  return Math.round(n / step) * step;
}

function finiteRadiusM(n: unknown): number | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  if (n < 50) return 50;
  if (n > 25_000) return 25_000;
  return n;
}

function lodUnion(around: string): string {
  return `(way["building"]["building:levels"](${around});way["building"]["height"](${around});way["building"~"apartments|commercial|office|retail|industrial|hotel|cathedral|university|hospital"](${around});)`;
}

/**
 * Rider-centered concentric Overpass: core (all buildings), vis-scale LOD, continue-past LOD.
 * Each ring has its own `out` budget so Overpass cannot dump-all then take the first N by id.
 */
export function overpassMotionQuery(
  center: { lat: unknown; lon: unknown },
  loadM: unknown,
  continueM: unknown,
  caps?: { core?: number; mid?: number; far?: number },
): string {
  const lat = Number(center && center.lat);
  const lon = Number(center && center.lon);
  const load = finiteRadiusM(loadM);
  const cont = finiteRadiusM(continueM);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return "";
  if (load == null || cont == null || cont < load) return "";
  const coreCap = Math.min(MOTION_BUILDING_CAP, Math.max(1, Math.floor(caps?.core ?? MOTION_CORE_CAP)));
  const midCap = Math.min(MOTION_BUILDING_CAP, Math.max(1, Math.floor(caps?.mid ?? MOTION_MID_CAP)));
  const farCap = Math.min(MOTION_BUILDING_CAP, Math.max(1, Math.floor(caps?.far ?? MOTION_FAR_CAP)));
  const qlat = coarseCoord(lat).toFixed(4);
  const qlon = coarseCoord(lon).toFixed(4);
  const coreM = Math.min(load, 900);
  const around = (r: number) => `around:${Math.round(r)},${qlat},${qlon}`;
  const coreA = around(coreM);
  const loadA = around(load);
  const farA = around(cont);
  return (
    `[out:json][timeout:22];` +
    `way["building"](${coreA})->.core;.core out tags geom ${coreCap};` +
    `${lodUnion(loadA)}->.load;(.load; - .core;)->.mid;.mid out tags geom ${midCap};` +
    `${lodUnion(farA)}->.farset;(.farset; - .load;);out tags geom ${farCap};`
  );
}

/** Working-set paths/roads around the rider. Not a metro-wide highway dump. */
export function overpassAccessQuery(
  center: { lat: unknown; lon: unknown },
  radiusM = 700,
  cap = 64,
): string {
  const lat = Number(center && center.lat);
  const lon = Number(center && center.lon);
  const r = finiteRadiusM(radiusM);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return "";
  if (r == null) return "";
  const limit = Number.isFinite(cap) ? Math.min(120, Math.max(1, Math.floor(cap))) : 64;
  const qlat = coarseCoord(lat).toFixed(4);
  const qlon = coarseCoord(lon).toFixed(4);
  const around = `around:${Math.round(Math.min(r, 900))},${qlat},${qlon}`;
  return `[out:json][timeout:10];(way["highway"~"cycleway|path|footway|pedestrian"](${around});way["highway"~"motorway|trunk|primary|secondary|tertiary|residential"](${around}););out geom ${limit};`;
}

export type AccessWay = { kind: "cycle" | "foot" | "road"; line: [number, number][] };

export function parseOverpassWays(raw: unknown, cap = 64): AccessWay[] {
  if (!raw || typeof raw !== "object") return [];
  const root = raw as { elements?: unknown };
  const elements = Array.isArray(root.elements) ? root.elements : [];
  const limit = Number.isFinite(cap) ? Math.min(120, Math.max(0, Math.floor(cap))) : 64;
  const out: AccessWay[] = [];
  for (const item of elements) {
    if (!item || typeof item !== "object") continue;
    const el = item as { tags?: { highway?: unknown }; geometry?: Array<{ lon?: unknown; lat?: unknown }> };
    const hwy = typeof el.tags?.highway === "string" ? el.tags.highway : "";
    const geom = Array.isArray(el.geometry) ? el.geometry : [];
    const line: [number, number][] = [];
    for (const pt of geom.slice(0, 400)) {
      const lon = Number(pt && pt.lon);
      const lat = Number(pt && pt.lat);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      line.push([lon, lat]);
    }
    if (line.length < 2) continue;
    const kind: AccessWay["kind"] = /cycleway/.test(hwy)
      ? "cycle"
      : /footway|path|pedestrian/.test(hwy)
        ? "foot"
        : "road";
    out.push({ kind, line });
    if (out.length >= limit) break;
  }
  return out;
}

export function overpassPostBody(query: string): string {
  return `data=${encodeURIComponent(query || "")}`;
}
