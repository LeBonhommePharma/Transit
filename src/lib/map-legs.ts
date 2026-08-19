import type { Itinerary, Place } from "./atlas/types";
import { decodePolyline, lineSlice } from "./geo";
import { tripStrokeStyle } from "./trajectory";

const roadStroke = tripStrokeStyle({ kind: "road" });

export const TRIP_WALK_FILTER: [string, unknown, unknown] = ["in", ["get", "kind"], ["literal", ["walk", "bike"]]];
export const TRIP_ROAD_FILTER: [string, unknown, unknown] = ["==", ["get", "kind"], "road"];
export const TRIP_TRANSIT_FILTER: [string, unknown, unknown] = ["==", ["get", "kind"], "transit"];

export const TRIP_ROAD_PAINT: { "line-color": string; "line-width": number; "line-opacity": number } = {
  "line-color": roadStroke.color,
  "line-width": roadStroke.width,
  "line-opacity": 0.95,
};

export function mapPoint(point: Place): [number, number] {
  if (point.stopId) return [point.lon, point.lat];
  return [Math.round(point.lon * 100) / 100, Math.round(point.lat * 100) / 100];
}

/** GeoJSON for an itinerary. Road/walk/bike use from→to; transit uses the encoded line. */
export function itineraryCollection(itinerary: Itinerary | null): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  if (!itinerary) return { type: "FeatureCollection", features };
  itinerary.legs.forEach((leg, index) => {
    const from = mapPoint(leg.from);
    const to = mapPoint(leg.to);
    if (leg.kind === "walk" || leg.kind === "bike" || leg.kind === "road") {
      features.push({
        type: "Feature",
        properties: { kind: leg.kind, index },
        geometry: {
          type: "LineString",
          coordinates: [from, to],
        },
      });
      return;
    }
    const full = decodePolyline(leg.line);
    const coords =
      full.length > 1
        ? lineSlice(full, { lon: from[0], lat: from[1] }, { lon: to[0], lat: to[1] })
        : [from, to];
    features.push({
      type: "Feature",
      properties: { kind: "transit", color: leg.color, index },
      geometry: { type: "LineString", coordinates: coords },
    });
  });
  return { type: "FeatureCollection", features };
}
