import type { Place } from "./atlas/types";

export type SearchAction = "plan" | "schedule" | "none";

/** De+Vers always plans. A lone query looks up a remote schedule. */
export function resolveSearchAction(opts: {
  from: Place | null;
  to: Place | null;
  query: string;
}): SearchAction {
  if (opts.from && opts.to) return "plan";
  if (typeof opts.query === "string" && opts.query.trim().length > 0) return "schedule";
  return "none";
}
