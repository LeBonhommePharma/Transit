"use client";

import { useEffect, useRef } from "react";
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, Map as MapLibreMap, MapGeoJSONFeature } from "maplibre-gl";
import type { Atlas, AtlasStop, CityId, Itinerary, Place } from "@/lib/atlas/types";
import { decodePolyline, lineSlice } from "@/lib/geo";

const STYLE = "https://tiles.openfreemap.org/styles/positron";

type Props = {
  city: CityId;
  atlas: Atlas | null;
  selectedStop?: AtlasStop | null;
  selectedRouteId?: string | null;
  itinerary?: Itinerary | null;
  onStop: (stop: AtlasStop) => void;
  onRoute: (routeId: string) => void;
};

type LineProps = {
  routeId: string;
  shortName: string;
  color: string;
  type: number;
  dir: number;
  kind: "metro" | "frequent" | "local";
};

function routeKind(type: number, shortName: string): LineProps["kind"] {
  if (type === 1) return "metro";
  if (/^80[0-7]/.test(shortName)) return "frequent";
  return "local";
}

function buildRouteCollection(atlas: Atlas): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const route of atlas.routes) {
    for (const dir of route.dirs) {
      const coords = decodePolyline(dir.line);
      if (coords.length < 2) continue;
      features.push({
        type: "Feature",
        properties: {
          routeId: route.id,
          shortName: route.shortName,
          color: route.color,
          type: route.type,
          dir: dir.id,
          kind: routeKind(route.type, route.shortName),
        } satisfies LineProps,
        geometry: { type: "LineString", coordinates: coords },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

function buildStopCollection(atlas: Atlas): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: atlas.stops
      .filter((stop) => stop.kind !== 2)
      .map((stop) => ({
        type: "Feature" as const,
        properties: {
          id: stop.id,
          name: stop.name,
          kind: stop.kind,
          routes: stop.routes.join(","),
        },
        geometry: {
          type: "Point" as const,
          coordinates: [stop.lon, stop.lat],
        },
      })),
  };
}

function itineraryCollection(itinerary: Itinerary | null): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  if (!itinerary) return { type: "FeatureCollection", features };
  itinerary.legs.forEach((leg, index) => {
    const from = mapPoint(leg.from);
    const to = mapPoint(leg.to);
    if (leg.kind === "walk" || leg.kind === "bike") {
      features.push({
        type: "Feature",
        properties: { kind: leg.kind, index },
        geometry: {
          type: "LineString",
          coordinates: [
            from,
            to,
          ],
        },
      });
      return;
    }
    const full = decodePolyline(leg.line);
    const coords =
      full.length > 1 ? lineSlice(full, { lon: from[0], lat: from[1] }, { lon: to[0], lat: to[1] }) : [
        from,
        to,
      ];
    features.push({
      type: "Feature",
      properties: { kind: "transit", color: leg.color, index },
      geometry: { type: "LineString", coordinates: coords },
    });
  });
  return { type: "FeatureCollection", features };
}

function mapPoint(point: Place): [number, number] {
  if (point.stopId) return [point.lon, point.lat];
  // Keep exact GPS-origin coordinates out of third-party tile/viewport requests.
  return [Math.round(point.lon * 100) / 100, Math.round(point.lat * 100) / 100];
}

export function MapView({
  city,
  atlas,
  selectedStop,
  selectedRouteId,
  itinerary,
  onStop,
  onRoute,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const atlasRef = useRef(atlas);
  const onStopRef = useRef(onStop);
  const onRouteRef = useRef(onRoute);

  useEffect(() => {
    atlasRef.current = atlas;
    onStopRef.current = onStop;
    onRouteRef.current = onRoute;
  }, [atlas, onStop, onRoute]);

  useEffect(() => {
    if (!rootRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: rootRef.current,
      style: STYLE,
      center: [-71.2082, 46.8131],
      zoom: 12.4,
      pitch: 0,
      attributionControl: false,
      fadeDuration: 0,
    });
    mapRef.current = map;

    map.on("load", () => {
      map.addSource("rive-routes", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addSource("rive-stops", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addSource("rive-trip", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      map.addLayer({
        id: "rive-local",
        type: "line",
        source: "rive-routes",
        minzoom: 13,
        filter: ["==", ["get", "kind"], "local"],
        paint: {
          "line-color": ["get", "color"],
          "line-width": 2.1,
          "line-opacity": 0.42,
        },
      });
      map.addLayer({
        id: "rive-frequent",
        type: "line",
        source: "rive-routes",
        minzoom: 11,
        filter: ["==", ["get", "kind"], "frequent"],
        paint: {
          "line-color": ["get", "color"],
          "line-width": 3.4,
          "line-opacity": 0.86,
        },
      });
      map.addLayer({
        id: "rive-metro",
        type: "line",
        source: "rive-routes",
        minzoom: 10,
        filter: ["==", ["get", "kind"], "metro"],
        paint: {
          "line-color": ["get", "color"],
          "line-width": 5.2,
          "line-opacity": 0.94,
        },
      });
      map.addLayer({
        id: "rive-selected-route",
        type: "line",
        source: "rive-routes",
        filter: ["==", ["get", "routeId"], ""],
        paint: {
          "line-color": "#e3a21c",
          "line-width": 6.5,
          "line-opacity": 0.95,
          "line-blur": 0.4,
        },
      });
      map.addLayer({
        id: "rive-trip-walk",
        type: "line",
        source: "rive-trip",
        filter: ["in", ["get", "kind"], ["literal", ["walk", "bike"]]],
        paint: {
          "line-color": [
            "match",
            ["get", "kind"],
            "bike",
            "#34c759",
            "#8e8e93",
          ],
          "line-width": 3,
          "line-dasharray": [1.2, 1.6],
          "line-opacity": 0.85,
        },
      });
      map.addLayer({
        id: "rive-trip-line",
        type: "line",
        source: "rive-trip",
        filter: ["==", ["get", "kind"], "transit"],
        paint: {
          "line-color": ["get", "color"],
          "line-width": 6,
          "line-opacity": 0.96,
        },
      });
      map.addLayer({
        id: "rive-stations",
        type: "circle",
        source: "rive-stops",
        minzoom: 11,
        filter: ["==", ["get", "kind"], 1],
        paint: {
          "circle-radius": 5.5,
          "circle-color": "#f4f7f9",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#10161c",
        },
      });
      map.addLayer({
        id: "rive-stop-dots",
        type: "circle",
        source: "rive-stops",
        minzoom: 14,
        filter: ["==", ["get", "kind"], 0],
        paint: {
          "circle-radius": 3.4,
          "circle-color": "#e8eef2",
          "circle-stroke-width": 1.4,
          "circle-stroke-color": "#10161c",
          "circle-opacity": 0.92,
        },
      });

      const pick = (e: maplibregl.MapMouseEvent) => {
        const hits = map.queryRenderedFeatures(e.point, {
          layers: ["rive-stop-dots", "rive-stations", "rive-metro", "rive-frequent", "rive-local"],
        });
        const stopHit = hits.find((f: MapGeoJSONFeature) => f.properties && "id" in f.properties);
        if (stopHit?.properties?.id) {
          const stop = atlasRef.current?.stops.find((s) => s.id === stopHit.properties!.id);
          if (stop) onStopRef.current(stop);
          return;
        }
        const routeHit = hits.find((f: MapGeoJSONFeature) => f.properties && "routeId" in f.properties);
        if (routeHit?.properties?.routeId) {
          onRouteRef.current(String(routeHit.properties.routeId));
        }
      };
      map.on("click", pick);
      for (const layer of ["rive-stop-dots", "rive-stations", "rive-metro", "rive-frequent"]) {
        map.on("mouseenter", layer, () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", layer, () => {
          map.getCanvas().style.cursor = "";
        });
      }
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !atlas) return;
    const apply = () => {
      const routes = map.getSource("rive-routes") as GeoJSONSource | undefined;
      const stops = map.getSource("rive-stops") as GeoJSONSource | undefined;
      routes?.setData(buildRouteCollection(atlas));
      stops?.setData(buildStopCollection(atlas));
      map.easeTo({
        center: atlas.meta.center,
        zoom: atlas.meta.zoom,
        duration: 900,
      });
    };
    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  }, [atlas, city]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getLayer("rive-selected-route")) return;
    map.setFilter("rive-selected-route", [
      "==",
      ["get", "routeId"],
      selectedRouteId || "",
    ]);
  }, [selectedRouteId]);

  useEffect(() => {
    const map = mapRef.current;
    const source = map?.getSource("rive-trip") as GeoJSONSource | undefined;
    source?.setData(itineraryCollection(itinerary ?? null));
    if (itinerary && map) {
      const coords = itinerary.legs.flatMap((leg) => [mapPoint(leg.from), mapPoint(leg.to)]);
      if (coords.length) {
        const bounds = coords.reduce(
          (b, c) => b.extend(c),
          new maplibregl.LngLatBounds(coords[0], coords[0]),
        );
        map.fitBounds(bounds, { padding: 90, duration: 800, maxZoom: 14.6 });
      }
    }
  }, [itinerary]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedStop) return;
    map.easeTo({
      center: [selectedStop.lon, selectedStop.lat],
      zoom: Math.max(map.getZoom(), 14.4),
      duration: 700,
    });
  }, [selectedStop]);

  return <div ref={rootRef} className="rive-map absolute inset-0" />;
}
