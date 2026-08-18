import type { Atlas } from "./atlas/types";
import { weekdayMon0, yyyymmdd } from "./time";

export function activeServiceIndexes(atlas: Atlas, date: Date): Set<number> {
  const stamp = yyyymmdd(date);
  const dow = weekdayMon0(date);
  const byName = new Map(atlas.services.map((id, i) => [id, i]));
  const active = new Set<number>();

  for (const row of atlas.calendar) {
    if (stamp < row.start || stamp > row.end) continue;
    if (row.days[dow] !== 1) continue;
    const idx = byName.get(row.id);
    if (idx != null) active.add(idx);
  }

  for (const row of atlas.exceptions) {
    if (row.date !== stamp) continue;
    const idx = byName.get(row.id);
    if (idx == null) continue;
    if (row.type === 1) active.add(idx);
    if (row.type === 2) active.delete(idx);
  }

  const daily = `${stamp}daily`;
  const dailyIdx = byName.get(daily);
  if (dailyIdx != null) active.add(dailyIdx);

  return active;
}
