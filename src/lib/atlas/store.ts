import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Poi } from "../poi";
import type { Atlas, CityId, Timetable } from "./types";

const atlasCache = new Map<CityId, Atlas>();
const timeCache = new Map<CityId, Timetable>();
const poiCache = new Map<CityId, Poi[]>();
const cityIndex = (() => {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), "public", "data", "index.json"), "utf8")) as {
      cities?: Array<{ city?: unknown }>;
    };
  } catch {
    return { cities: [] };
  }
})();
const CITY_IDS = new Set(
  Array.isArray(cityIndex.cities)
    ? cityIndex.cities
        .map((item) => item.city)
        .filter((city): city is string => typeof city === "string")
    : [],
);

function dataPath(city: CityId, file: string) {
  return join(process.cwd(), "public", "data", city, file);
}

export async function loadAtlas(city: CityId): Promise<Atlas> {
  const hit = atlasCache.get(city);
  if (hit) return hit;
  const raw = await readFile(dataPath(city, "atlas.json"), "utf8");
  const atlas = JSON.parse(raw) as Atlas;
  atlasCache.set(city, atlas);
  return atlas;
}

export async function loadTimetable(city: CityId): Promise<Timetable> {
  const hit = timeCache.get(city);
  if (hit) return hit;
  const raw = await readFile(dataPath(city, "timetable.json"), "utf8");
  const table = JSON.parse(raw) as Timetable;
  timeCache.set(city, table);
  return table;
}

export async function loadPois(city: CityId): Promise<Poi[]> {
  const hit = poiCache.get(city);
  if (hit) return hit;
  const cityPath = dataPath(city, "pois.json");
  let raw: string;
  try {
    raw = await readFile(cityPath, "utf8");
  } catch {
    raw = await readFile(join(process.cwd(), "public", "data", "pois.json"), "utf8");
  }
  const parsed = JSON.parse(raw) as { places?: unknown };
  const places = Array.isArray(parsed.places) ? parsed.places : [];
  const pois = places.filter((item): item is Poi => {
    if (!item || typeof item !== "object") return false;
    const poi = item as Partial<Poi>;
    return (
      typeof poi.id === "string" &&
      typeof poi.name === "string" &&
      Number.isFinite(poi.lon) &&
      Number.isFinite(poi.lat) &&
      Number.isFinite(poi.popularity)
    );
  });
  poiCache.set(city, pois);
  return pois;
}

export function isCityId(value: string): value is CityId {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 64 && CITY_IDS.has(value);
}
