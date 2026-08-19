/** 2.5D building footprints. Official OSM tags; garbage in → no building. */

export type BuildingFootprint = {
  ring: [number, number][];
  heightM: number;
};

export const BUILDING_ZOOM = 12.6;
export const BUILDING_CAP = 280;
export const MOTION_BUILDING_CAP = 800;
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

/** Inner ring: all footprints. Outer ring: taller/landmark LOD so the vis area is covered, not a 700 m dump. */
export function overpassMotionQuery(
  inner: { south: number; west: number; north: number; east: number },
  outer: { south: number; west: number; north: number; east: number },
  cap = MOTION_BUILDING_CAP,
): string {
  if (!validBbox(inner) || !validBbox(outer)) return "";
  const limit = Number.isFinite(cap) ? Math.min(MOTION_BUILDING_CAP, Math.max(1, Math.floor(cap))) : MOTION_BUILDING_CAP;
  const ring = (b: { south: number; west: number; north: number; east: number }) =>
    [b.south, b.west, b.north, b.east].map((n) => n.toFixed(5)).join(",");
  const a = ring(inner);
  const b = ring(outer);
  return `[out:json][timeout:20];(way["building"](${a});way["building"]["building:levels"](${b});way["building"]["height"](${b});way["building"~"apartments|commercial|office|retail|industrial|hotel|cathedral|university|hospital"](${b}););out tags geom ${limit};`;
}

export function overpassPostBody(query: string): string {
  return `data=${encodeURIComponent(query || "")}`;
}
