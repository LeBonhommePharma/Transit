/** Current rider weather. Junk does not invent UV or AQI. */

export type Conditions = {
  precipMm: number | null;
  precipAccumMm: number | null;
  uv: number | null;
  aqi: number | null;
  windKmh: number | null;
  windDeg: number | null;
  tempC: number | null;
  road: "dry" | "wet" | "icy" | null;
};

export type ShownConditions = {
  precip?: string;
  uv?: string;
  aqi?: string;
  wind?: string;
  road?: string;
};

const CARDINALS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function hourlySum(hourly: Record<string, unknown> | null, key: string, n = 3): number | null {
  if (!hourly) return null;
  const list = hourly[key];
  if (!Array.isArray(list)) return null;
  let sum = 0;
  let saw = false;
  for (const item of list.slice(0, n)) {
    const v = num(item);
    if (v == null) continue;
    sum += v;
    saw = true;
  }
  return saw ? sum : null;
}

function flatten(raw: unknown): Record<string, unknown> {
  const root = asRecord(raw);
  if (!root) return {};
  const current = asRecord(root.current) ?? {};
  return { ...current, ...root };
}

function windCardinal(deg: number): string {
  const i = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
  return CARDINALS[i];
}

function roadFrom(precipMm: number | null, tempC: number | null, rain: number | null, snow: number | null): Conditions["road"] {
  const wet = (precipMm != null && precipMm > 0.1) || (rain != null && rain > 0) || (snow != null && snow > 0);
  if (tempC != null && tempC <= 0.5 && wet) return "icy";
  if (wet) return "wet";
  if (tempC != null || precipMm != null || rain != null || snow != null) return "dry";
  return null;
}

/** Decode Open-Meteo (or already-flattened) current weather. Missing fields stay null. */
export function decodeConditions(raw: unknown): Conditions {
  const src = flatten(raw);
  const hourly = asRecord(src.hourly);
  const precipMm = num(src.precipitation ?? src.precipMm ?? src.precip);
  const rain = num(src.rain);
  const snow = num(src.snowfall);
  const precipAccumMm = hourlySum(hourly, "precipitation", 3);
  const uv = num(src.uv_index ?? src.uvIndex ?? src.uv);
  const aqi = num(src.european_aqi ?? src.us_aqi ?? src.aqi);
  const windKmh = num(src.wind_speed_10m ?? src.windKmh ?? src.wind);
  const windDeg = num(src.wind_direction_10m ?? src.windDeg);
  const tempC = num(src.temperature_2m ?? src.tempC ?? src.temperature);
  return {
    precipMm,
    precipAccumMm,
    uv,
    aqi,
    windKmh,
    windDeg,
    tempC,
    road: roadFrom(precipMm, tempC, rain, snow),
  };
}

/** Only fields that matter right now. Clear/calm → empty. */
export function shownConditions(raw: unknown): ShownConditions {
  const c = decodeConditions(raw);
  const out: ShownConditions = {};
  const falling = c.precipMm != null && c.precipMm > 0.05;
  const accumulating = c.precipAccumMm != null && c.precipAccumMm > 0.2;
  if (falling || accumulating) {
    const mm = falling ? c.precipMm : c.precipAccumMm;
    out.precip = `${(mm as number).toFixed(1)} mm`;
  }
  if (c.uv != null && c.uv >= 3) out.uv = String(Math.round(c.uv));
  if (c.aqi != null && c.aqi >= 50) out.aqi = String(Math.round(c.aqi));
  if (c.windKmh != null && c.windKmh >= 15) {
    const dir = c.windDeg != null ? ` ${windCardinal(c.windDeg)}` : "";
    out.wind = `${Math.round(c.windKmh)} km/h${dir}`;
  }
  if (c.road === "wet") out.road = "mouillée";
  if (c.road === "icy") out.road = "glissante";
  return out;
}

export function shouldDrawPrecip(raw: unknown): boolean {
  const shown = shownConditions(raw);
  return Boolean(shown.precip);
}

export function precipIntensity(raw: unknown): number {
  const c = decodeConditions(raw);
  const mm = Math.max(c.precipMm ?? 0, (c.precipAccumMm ?? 0) / 3);
  if (!(mm > 0.05)) return 0;
  return Math.min(1, mm / 4);
}

export function formatShownLine(shown: ShownConditions): string {
  const bits: string[] = [];
  if (shown.precip) bits.push(`pluie ${shown.precip}`);
  if (shown.road) bits.push(`chaussée ${shown.road}`);
  if (shown.wind) bits.push(`vent ${shown.wind}`);
  if (shown.uv) bits.push(`UV ${shown.uv}`);
  if (shown.aqi) bits.push(`AQI ${shown.aqi}`);
  return bits.join("  ·  ");
}
