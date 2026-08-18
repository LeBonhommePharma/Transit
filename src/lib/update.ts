export type FeedFingerprint = {
  city: string;
  version: string;
  updated: string;
  routeIds?: string[];
  stopIds?: string[];
  counts?: { routes?: number; stops?: number };
};

export type RefreshOpts = {
  /** Rider asked to check now. Always treats the feed as needing a refresh. */
  userDeclared?: boolean;
};

export function fingerprintFromMeta(
  meta: {
    city?: string;
    version?: string;
    updated?: string;
    counts?: { routes?: number; stops?: number };
  },
  extra?: { routeIds?: string[]; stopIds?: string[] },
): FeedFingerprint {
  return {
    city: String(meta.city || ""),
    version: String(meta.version || ""),
    updated: String(meta.updated || ""),
    counts: meta.counts
      ? { routes: meta.counts.routes, stops: meta.counts.stops }
      : undefined,
    routeIds: extra?.routeIds,
    stopIds: extra?.stopIds,
  };
}

export function objectSetChanged(
  local: Iterable<string> | undefined,
  remote: Iterable<string> | undefined,
): boolean {
  if (!local || !remote) return false;
  const a = [...local];
  const b = [...remote];
  if (a.length !== b.length) return true;
  const set = new Set(a);
  for (const id of b) {
    if (!set.has(id)) return true;
  }
  return false;
}

/** Pure: no network. Unchanged fingerprint does not request a zip. */
export function feedIsStale(
  local: FeedFingerprint,
  remote: FeedFingerprint,
  opts: RefreshOpts = {},
): boolean {
  if (opts.userDeclared) return true;
  if (remote.version && remote.version !== local.version) return true;
  if (remote.updated && remote.updated !== local.updated) return true;
  if (
    remote.counts &&
    local.counts &&
    (remote.counts.routes !== local.counts.routes || remote.counts.stops !== local.counts.stops)
  ) {
    return true;
  }
  if (objectSetChanged(local.routeIds, remote.routeIds)) return true;
  if (objectSetChanged(local.stopIds, remote.stopIds)) return true;
  return false;
}

export function shouldFetchZip(
  local: FeedFingerprint,
  remote: FeedFingerprint,
  opts: RefreshOpts = {},
): boolean {
  return feedIsStale(local, remote, opts);
}
