/** Meteorological visibility → motion-view load / continue extents. No invented METAR. */

export const DEFAULT_VISIBILITY_M = 8000;
export const MIN_VISIBILITY_M = 120;
export const MAX_VISIBILITY_M = 20_000;
export const LOAD_BUFFER = 1.12;
export const CONTINUE_PAST = 1.35;
export const BBOX_QUANTIZE_DEG = 0.008;

export type WeatherInput = {
  visibilityM?: unknown;
  visibilityKm?: unknown;
  visibility?: unknown;
  condition?: unknown;
  weather?: unknown;
  weatherCode?: unknown;
  forecast?: unknown;
  precipitation?: unknown;
  rain?: unknown;
  snowfall?: unknown;
  uv_index?: unknown;
  european_aqi?: unknown;
  us_aqi?: unknown;
  wind_speed_10m?: unknown;
  wind_direction_10m?: unknown;
  temperature_2m?: unknown;
  hourly?: unknown;
};

export type BBox = { south: number; west: number; north: number; east: number };

export type MotionExtents = {
  visibilityM: number;
  loadM: number;
  continueM: number;
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function asFinitePositive(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function readVisibilityM(row: unknown): number | null {
  if (!row || typeof row !== "object") return null;
  const o = row as Record<string, unknown>;
  const meters = asFinitePositive(o.visibilityM) ?? asFinitePositive(o.visibility_m);
  if (meters != null && meters <= 50_000) return clamp(meters, MIN_VISIBILITY_M, MAX_VISIBILITY_M);
  const vis = asFinitePositive(o.visibility);
  if (vis != null && vis <= 50_000) {
    return clamp(vis > 80 ? vis : vis * 1000, MIN_VISIBILITY_M, MAX_VISIBILITY_M);
  }
  const km = asFinitePositive(o.visibilityKm) ?? asFinitePositive(o.visibility_km);
  if (km != null && km <= 50) return clamp(km * 1000, MIN_VISIBILITY_M, MAX_VISIBILITY_M);
  return null;
}

function conditionVisibilityM(row: unknown): number | null {
  if (!row || typeof row !== "object") return null;
  const o = row as Record<string, unknown>;
  const code = asFinitePositive(o.weatherCode ?? o.weather_code);
  if (code != null) {
    const c = Math.round(code);
    if (c === 45 || c === 48) return 400;
    if (c >= 71 && c <= 77) return 1500;
    if (c >= 85 && c <= 86) return 1500;
    if (c >= 51 && c <= 67) return 5000;
    if (c >= 80 && c <= 82) return 5000;
    if (c >= 95) return 3000;
    if (c <= 1) return 16_000;
    if (c <= 3) return 10_000;
  }
  const raw = o.condition ?? o.weather ?? o.text;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const c = raw.toLowerCase();
  if (/fog|brouillard|brume épaisse/.test(c)) return 400;
  if (/mist|brume|haze|fumée|smoke/.test(c)) return 2500;
  if (/blizzard|snow|neige/.test(c)) return 1500;
  if (/thunder|orage/.test(c)) return 3000;
  if (/rain|drizzle|averse|pluie/.test(c)) return 5000;
  if (/clear|sunny|fair|ciel dégagé|clear sky/.test(c)) return 16_000;
  if (/cloud|overcast|couvert|nuage/.test(c)) return 10_000;
  return null;
}

/** Visibility in meters from weather + forecast. Junk → conservative default, never NaN/empty. */
export function visibilityMetersFromWeather(weather: unknown): number {
  const vis = readVisibilityM(weather);
  if (vis != null) return vis;
  const forecast =
    weather && typeof weather === "object" ? (weather as WeatherInput).forecast : null;
  const fvis = readVisibilityM(forecast);
  if (fvis != null) return fvis;
  const fromCond = conditionVisibilityM(weather) ?? conditionVisibilityM(forecast);
  if (fromCond != null) return fromCond;
  return DEFAULT_VISIBILITY_M;
}

/** Prefetch working-set radius: ~visibility plus a modest buffer. */
export function loadExtentMeters(visibilityM: unknown): number {
  const vis =
    typeof visibilityM === "number" && Number.isFinite(visibilityM) && visibilityM > 0
      ? clamp(visibilityM, MIN_VISIBILITY_M, MAX_VISIBILITY_M)
      : DEFAULT_VISIBILITY_M;
  return vis * LOAD_BUFFER;
}

/** Draw/load continues past visibility — never a hard clip at vis. */
export function continueExtentMeters(visibilityM: unknown): number {
  return loadExtentMeters(visibilityM) * CONTINUE_PAST;
}

export function motionViewExtents(weather: unknown): MotionExtents {
  const visibilityM = visibilityMetersFromWeather(weather);
  const loadM = loadExtentMeters(visibilityM);
  const continueM = continueExtentMeters(visibilityM);
  return { visibilityM, loadM, continueM };
}

export function bboxFromRadiusM(center: { lat: unknown; lon: unknown }, radiusM: number): BBox | null {
  const lat = Number(center && center.lat);
  const lon = Number(center && center.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return null;
  }
  if (!Number.isFinite(radiusM) || radiusM <= 0) return null;
  const dLat = radiusM / 111_320;
  const cos = Math.cos((lat * Math.PI) / 180);
  const dLon = radiusM / (111_320 * Math.max(0.12, Math.abs(cos)));
  return {
    south: clamp(lat - dLat, -90, 90),
    north: clamp(lat + dLat, -90, 90),
    west: clamp(lon - dLon, -180, 180),
    east: clamp(lon + dLon, -180, 180),
  };
}

/** Expand-only quantize so a third-party query is not a precise GPS viewport. */
export function quantizeBbox(bbox: BBox | null | undefined, stepDeg = BBOX_QUANTIZE_DEG): BBox | null {
  if (!bbox) return null;
  const step = Number.isFinite(stepDeg) && stepDeg > 0 ? stepDeg : BBOX_QUANTIZE_DEG;
  const qDown = (n: number) => Math.floor(n / step) * step;
  const qUp = (n: number) => Math.ceil(n / step) * step;
  const south = qDown(bbox.south);
  const west = qDown(bbox.west);
  const north = qUp(bbox.north);
  const east = qUp(bbox.east);
  if (!(south < north) || !(west < east)) return null;
  return {
    south: clamp(south, -90, 90),
    north: clamp(north, -90, 90),
    west: clamp(west, -180, 180),
    east: clamp(east, -180, 180),
  };
}

export function motionViewBbox(
  center: { lat: unknown; lon: unknown },
  weather: unknown,
): { inner: BBox; outer: BBox; extents: MotionExtents } | null {
  const extents = motionViewExtents(weather);
  const innerRaw = bboxFromRadiusM(center, extents.loadM);
  const outerRaw = bboxFromRadiusM(center, extents.continueM);
  const inner = quantizeBbox(innerRaw);
  const outer = quantizeBbox(outerRaw);
  if (!inner || !outer) return null;
  return { inner, outer, extents };
}

/** GPS-follow must keep neighborhood details. Privacy is coarse queries, not emptying the map. */
export function motionBuildingQueryAllowed(
  here?: { lon?: unknown; lat?: unknown; source?: unknown } | null,
  camera?: { lon?: unknown; lat?: unknown } | null,
): boolean {
  void here;
  void camera;
  return true;
}

export function bboxSpanMeters(bbox: BBox, lat: number): { northSouth: number; westEast: number } {
  const northSouth = Math.abs(bbox.north - bbox.south) * 111_320;
  const cos = Math.cos((lat * Math.PI) / 180);
  const westEast = Math.abs(bbox.east - bbox.west) * 111_320 * Math.max(0.12, Math.abs(cos));
  return { northSouth, westEast };
}

/** Decode Open-Meteo current + short-range forecast. Junk → null (caller uses default vis). */
export function weatherFromOpenMeteo(raw: unknown): WeatherInput | null {
  if (!raw || typeof raw !== "object") return null;
  const root = raw as Record<string, unknown>;
  const current = root.current && typeof root.current === "object" ? (root.current as Record<string, unknown>) : null;
  const hourly = root.hourly && typeof root.hourly === "object" ? (root.hourly as Record<string, unknown>) : null;
  const visList = hourly && Array.isArray(hourly.visibility) ? hourly.visibility : [];
  const codeList = hourly && Array.isArray(hourly.weather_code) ? hourly.weather_code : [];
  const forecastVis = visList.length ? visList[Math.min(1, visList.length - 1)] : undefined;
  const forecastCode = codeList.length ? codeList[Math.min(1, codeList.length - 1)] : undefined;
  const visibilityM = current ? current.visibility : undefined;
  const weatherCode = current ? current.weather_code : undefined;
  if (visibilityM == null && weatherCode == null && forecastVis == null && forecastCode == null && !current) return null;
  return {
    visibilityM,
    weatherCode,
    precipitation: current ? current.precipitation : undefined,
    rain: current ? current.rain : undefined,
    snowfall: current ? current.snowfall : undefined,
    uv_index: current ? current.uv_index : undefined,
    european_aqi: current ? current.european_aqi : undefined,
    us_aqi: current ? current.us_aqi : undefined,
    wind_speed_10m: current ? current.wind_speed_10m : undefined,
    wind_direction_10m: current ? current.wind_direction_10m : undefined,
    temperature_2m: current ? current.temperature_2m : undefined,
    hourly: hourly ?? undefined,
    forecast: { visibilityM: forecastVis, weatherCode: forecastCode },
  };
}
