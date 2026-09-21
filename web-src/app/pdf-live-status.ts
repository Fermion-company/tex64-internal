export type PdfLiveStatusKey =
  | "live"
  | "liveUpdating"
  | "liveExactRendering"
  | "liveCompiling"
  | "liveFullCompile"
  | "liveError"
  | "liveUnavailable";

export type PdfLiveStatusView = {
  key: PdfLiveStatusKey;
  tone: "idle" | "busy" | "error";
  detail: string;
};

type PdfLiveEngineStatus = {
  up?: boolean;
  busy?: boolean;
  mode?: string;
  srcRev?: number;
  canonical?: {
    inFlight?: boolean;
    compiling?: boolean;
    authorityChildren?: number;
    rev?: number;
    scheduledInMs?: number | null;
    displayDemandRev?: number | null;
    error?: string | null;
    errorRev?: number;
  } | null;
  render?: {
    queued?: unknown[];
    active?: unknown[];
    pumping?: number | boolean;
  } | null;
  shipping?: { done?: boolean; retry?: { state?: string } | null } | null;
  // Blocks a budgeted keystroke left for the engine's background replay
  // (tdom docs/10 §10.4a): their pages update when the resume publishes.
  cold?: { pending?: unknown[] } | null;
};

/** Convert the engine snapshot into one unambiguous viewer state. */
export const resolvePdfLiveStatus = (
  status: PdfLiveEngineStatus | null | undefined,
  presentationPending?: boolean
): PdfLiveStatusView | null => {
  if (!status) return null;
  if (status.up === false) {
    return { key: "liveUnavailable", tone: "error", detail: "" };
  }
  if (status.busy || status.render?.queued?.length || status.render?.active?.length ||
      status.render?.pumping || status.shipping?.retry?.state === "booting" ||
      status.cold?.pending?.length) {
    return { key: "liveUpdating", tone: "busy", detail: "" };
  }
  // A future timer can coexist with a compile of an earlier revision.
  // Use the explicit running state; preserve the conservative fallback
  // only for engines which predate that field.
  const compiling = typeof status.canonical?.compiling === "boolean"
    ? status.canonical.compiling
    : Number(status.canonical?.authorityChildren) > 0 ||
      status.canonical?.inFlight && typeof status.canonical.scheduledInMs !== "number";
  if (compiling) {
    return { key: "liveCompiling", tone: "busy", detail: "" };
  }
  if (status.canonical?.error &&
      Number(status.canonical.errorRev) >= Number(status.srcRev)) {
    return { key: "liveError", tone: "error", detail: status.canonical.error };
  }
  const demandedRevision = status.canonical?.displayDemandRev;
  const waitingForDisplay = Number.isInteger(demandedRevision) &&
    Number(demandedRevision) === Number(status.srcRev) &&
    Number(status.canonical?.rev ?? 0) < Number(status.srcRev);
  if (presentationPending === true || waitingForDisplay) {
    return { key: "liveExactRendering", tone: "busy", detail: "" };
  }
  if (status.mode === "opaque") {
    return { key: "liveFullCompile", tone: "idle", detail: "" };
  }
  return { key: "live", tone: "idle", detail: "" };
};
