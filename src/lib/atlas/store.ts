import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Atlas, CityId, Timetable } from "./types";

const atlasCache = new Map<CityId, Atlas>();
const timeCache = new Map<CityId, Timetable>();

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

export function isCityId(value: string): value is CityId {
  return value === "quebec" || value === "montreal";
}
