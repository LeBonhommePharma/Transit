/** 2.5D building footprints. Official OSM tags; garbage in → no building. */

export type BuildingFootprint = {
  ring: [number, number][];
  heightM: number;
};

export const BUILDING_ZOOM = 14.2;
export const BUILDING_CAP = 180;

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
  const elements = Array.isArray(root.elements) ? root.elements : [];
  for (const item of elements) {
    if (!item || typeof item !== "object") continue;
    const el = item as Record<string, unknown>;
    const geom = Array.isArray(el.geometry) ? el.geometry : [];
    const ring: [number, number][] = [];
    for (const pt of geom) {
      if (!pt || typeof pt !== "object") continue;
      const p = pt as { lon?: unknown; lat?: unknown };
      const lon = Number(p.lon);
      const lat = Number(p.lat);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      ring.push([lon, lat]);
    }
    const closed = closedRing(ring);
    if (closed.length < 4) continue;
    out.push({ ring: closed, heightM: buildingHeightMeters(el.tags) });
    if (out.length >= cap) break;
  }
  if (out.length === 0 && root.type === "FeatureCollection" && Array.isArray(root.features)) {
    for (const feat of root.features) {
      if (!feat || typeof feat !== "object") continue;
      const f = feat as { geometry?: { type?: string; coordinates?: unknown }; properties?: unknown };
      const coords = f.geometry && f.geometry.type === "Polygon" ? f.geometry.coordinates : null;
      const outer = Array.isArray(coords) ? coords[0] : null;
      if (!Array.isArray(outer)) continue;
      const ring: [number, number][] = [];
      for (const pt of outer) {
        if (!Array.isArray(pt) || pt.length < 2) continue;
        const lon = Number(pt[0]);
        const lat = Number(pt[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        ring.push([lon, lat]);
      }
      const closed = closedRing(ring);
      if (closed.length < 4) continue;
      out.push({ ring: closed, heightM: buildingHeightMeters(f.properties) });
      if (out.length >= cap) break;
    }
  }
  return out;
}

/** Screen slip for a 2.5D roof. Light from the north-west. */
export function extrudeOffsetPx(heightM: number, zoom: number): { dx: number; dy: number } {
  if (!Number.isFinite(heightM) || heightM <= 0 || !Number.isFinite(zoom)) return { dx: 0, dy: 0 };
  const pxPerMeter = Math.max(0.15, 2 ** (zoom - 15) * 0.85);
  return { dx: heightM * pxPerMeter * 0.32, dy: -heightM * pxPerMeter * 0.58 };
}

export function wallQuads(
  ring: [number, number][],
  dx: number,
  dy: number,
): Array<[[number, number], [number, number], [number, number], [number, number]]> {
  const quads = [];
  if (!ring || ring.length < 2) return quads;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i];
    const b = ring[i + 1];
    if (!a || !b) continue;
    quads.push([a, b, [b[0] + dx, b[1] + dy], [a[0] + dx, a[1] + dy]]);
  }
  return quads;
}

export function overpassQuery(bbox: { south: number; west: number; north: number; east: number }): string {
  const s = [bbox.south, bbox.west, bbox.north, bbox.east]
    .map((n) => (Number.isFinite(n) ? n.toFixed(5) : ""))
    .join(",");
  return `[out:json][timeout:12];way["building"](${s});out tags geom ${BUILDING_CAP};`;
}
