import { readJsonBody } from "@/lib/http";
import {
  applyFusedEtaToDue,
  emptyProbeStore,
  fuseRouteProbes,
  ingestProbe,
  type ProbeStore,
} from "@/lib/probe";
import type { LineDue } from "@/lib/lines";

export const runtime = "nodejs";

/** Process-local store. Pages has no shared backend; official feeds stay the fallback. */
const store: ProbeStore = emptyProbeStore();

export async function POST(request: Request) {
  const parsed = await readJsonBody<{
    lon?: unknown;
    lat?: unknown;
    at?: unknown;
    routeId?: unknown;
    heading?: unknown;
    name?: unknown;
    userId?: unknown;
  }>(request);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
    return Response.json({ error: "Corps JSON invalide.", accepted: false }, { status: 400 });
  }
  const now = Date.now();
  const before = store.samples.length;
  const next = ingestProbe(store, { ...parsed.value, at: parsed.value.at ?? now }, now);
  const accepted = next.samples.length > before;
  store.samples = next.samples;
  return Response.json({
    accepted,
    count: store.samples.length,
  });
}

export async function PUT(request: Request) {
  const parsed = await readJsonBody<{
    routeId?: string;
    shape?: [number, number][];
    officialDepart?: number;
    now?: number;
    expectedAlongMeters?: number;
    due?: LineDue[];
  }>(request);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
    return Response.json({ error: "Corps JSON invalide." }, { status: 400 });
  }
  const body = parsed.value;
  if (!body.routeId || !Array.isArray(body.shape) || !Number.isFinite(body.officialDepart)) {
    return Response.json({ error: "Fusion incomplète." }, { status: 400 });
  }
  const now = Number.isFinite(body.now) ? Number(body.now) : Date.now();
  const fused = fuseRouteProbes({
    store,
    routeId: body.routeId,
    shape: body.shape,
    now,
    officialDepart: Number(body.officialDepart),
    expectedAlongMeters: body.expectedAlongMeters,
  });
  const due = Array.isArray(body.due) ? applyFusedEtaToDue(body.due, fused, Number(body.officialDepart)) : undefined;
  return Response.json({ fused, due: due ?? null, officialUnchanged: !fused });
}
