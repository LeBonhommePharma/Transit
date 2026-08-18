const TZ = "America/Montreal";

export function montrealNow(at?: Date): Date {
  return at ?? new Date();
}

export function yyyymmdd(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}${m}${d}`;
}

export function minutesOfDay(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

export function weekdayMon0(date: Date): number {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "short",
  }).format(date);
  const map: Record<string, number> = {
    Mon: 0,
    Tue: 1,
    Wed: 2,
    Thu: 3,
    Fri: 4,
    Sat: 5,
    Sun: 6,
  };
  return map[name] ?? 0;
}

export function prefersHour12(locale?: string): boolean {
  try {
    // This atlas is America/Montreal. A US-English browser locale reports h12
    // even when macOS is 24h. Honour an explicit locale, then Canadian 24h.
    const candidates = locale ? [locale] : ["fr-CA", "en-CA", undefined];
    let saw12 = false;
    for (const loc of candidates) {
      const opts = new Intl.DateTimeFormat(loc, { hour: "numeric" }).resolvedOptions();
      if (opts.hourCycle === "h23" || opts.hourCycle === "h24") return false;
      if (opts.hourCycle === "h11" || opts.hourCycle === "h12") saw12 = true;
      else if (opts.hour12) saw12 = true;
    }
    return saw12;
  } catch {
    return false;
  }
}

export function formatClock(minutes: number, hour12 = false): string {
  const wrap = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(wrap / 60);
  const m = wrap % 60;
  const mm = String(m).padStart(2, "0");
  if (!hour12) return `${String(h).padStart(2, "0")}:${mm}`;
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${mm} ${suffix}`;
}

export function formatRelative(minutesFromNow: number): string {
  if (minutesFromNow <= 0) return "maintenant";
  if (minutesFromNow < 60) return `${minutesFromNow} min`;
  const h = Math.floor(minutesFromNow / 60);
  const m = minutesFromNow % 60;
  if (m === 0) return `${h} h`;
  return `${h} h ${m}`;
}

export function nextAfter(times: number[], now: number, wrap = true): number | null {
  if (times.length === 0) return null;
  for (const t of times) {
    if (t >= now) return t;
  }
  return wrap ? times[0] + 1440 : null;
}
