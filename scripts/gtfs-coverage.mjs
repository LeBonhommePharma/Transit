/**
 * Fail-closed GTFS calendar coverage. Import-safe: no network, no writes.
 */

function yyyymmddStamp(value) {
  if (value == null) return "";
  const stamp = String(value).trim();
  return /^\d{8}$/.test(stamp) ? stamp : "";
}

export function montrealYyyymmdd(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Montreal",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}${m}${d}`;
}

/** Latest YYYYMMDD from calendar.end, exception dates, and meta.end. */
export function coverageEndYyyymmdd({ calendar = [], exceptions = [], meta } = {}) {
  let end = "";
  for (const row of calendar) {
    const stamp = yyyymmddStamp(row?.end);
    if (stamp > end) end = stamp;
  }
  for (const row of exceptions) {
    const stamp = yyyymmddStamp(row?.date);
    if (stamp > end) end = stamp;
  }
  const metaEnd = yyyymmddStamp(meta?.end);
  if (metaEnd > end) end = metaEnd;
  return end;
}

function packFromUnknown(value) {
  if (!value || typeof value !== "object") return { calendar: [], exceptions: [], meta: undefined };
  if (Array.isArray(value.calendar) || Array.isArray(value.exceptions) || value.meta) {
    return {
      calendar: Array.isArray(value.calendar) ? value.calendar : [],
      exceptions: Array.isArray(value.exceptions) ? value.exceptions : [],
      meta: value.meta,
    };
  }
  return { calendar: [], exceptions: [], meta: undefined };
}

/**
 * Refuse a feed whose coverage ends before today (America/Montreal).
 * First arg is a YYYYMMDD string or a packed { calendar, exceptions, meta }.
 */
export function assertCoverageIncludesToday(coverageEnd, todayYyyymmdd) {
  const today = yyyymmddStamp(todayYyyymmdd) || montrealYyyymmdd();
  if (!today) throw new Error(`invalid today stamp: ${todayYyyymmdd}`);
  const end =
    typeof coverageEnd === "string" || typeof coverageEnd === "number"
      ? yyyymmddStamp(coverageEnd)
      : coverageEndYyyymmdd(packFromUnknown(coverageEnd));
  if (!end || end < today) {
    const city =
      coverageEnd && typeof coverageEnd === "object" ? coverageEnd.meta?.city || coverageEnd.city || "unknown" : "unknown";
    throw new Error(
      `GTFS coverage for ${city} ends on ${end || "none"}, which is before today ${today} (America/Montreal)`,
    );
  }
}
