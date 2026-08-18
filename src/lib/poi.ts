export type Poi = {
  id: string;
  name: string;
  lon: number;
  lat: number;
  popularity: number;
};

/** Higher popularity ranks first. Hard budget N. No giant local store. */
export function pickPois(candidates: Poi[], budget: number): Poi[] {
  const n = Math.max(0, Math.floor(budget));
  if (n === 0 || !candidates.length) return [];
  return [...candidates]
    .filter((poi) => Number.isFinite(poi.popularity) && Number.isFinite(poi.lon) && Number.isFinite(poi.lat))
    .sort((a, b) => b.popularity - a.popularity || a.name.localeCompare(b.name, "fr"))
    .slice(0, n);
}

export function poiWeight(poi: Poi): number {
  return Math.max(0, poi.popularity);
}
