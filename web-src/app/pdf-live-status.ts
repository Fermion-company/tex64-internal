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
  rev?: number;
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

export const PDF_LIVE_BEHIND_THRESHOLD_MS = 3000;

export type PdfLiveStatusMark = {
  color: "green" | "orange" | "red";
  srcRev: number | null;
  drawnRev: number | null;
  behindSince: number | null;
};

/** One snapshot step; the caller owns the clock and resets on document changes. */
export const stepPdfLiveStatusMark = (
  status: PdfLiveEngineStatus | null | undefined,
  { previous, now, presentationPending, appliedSrcRev }: {
    previous?: PdfLiveStatusMark | null;
    now: number;
    presentationPending?: boolean;
    appliedSrcRev?: number;
  }
): PdfLiveStatusMark => {
  const revision = (value: unknown): number | null =>
    Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
  const source = revision(status?.srcRev);
  const applied = revision(appliedSrcRev);
  // The iframe can apply an edit before the next /status poll arrives.
  const srcRev = source === null ? applied : Math.max(source, applied ?? source);
  if (srcRev !== null && previous?.srcRev != null && srcRev < previous.srcRev) previous = null;
  // Engine rev counts layout updates, not source edits. Only the iframe's
  // presentation acknowledgement certifies which source is actually drawn.
  const drawnRev = presentationPending === false
    ? applied ?? srcRev
    : previous?.drawnRev ?? null;
  const behind = srcRev !== null && (drawnRev === null || drawnRev < srcRev);
  const progressed = drawnRev !== null && (previous?.drawnRev == null || drawnRev > previous.drawnRev);
  // More typing must not postpone overload forever. Restart only on drawing
  // progress (or after catching up), not on each new source revision.
  const behindSince = behind ? progressed ? now : previous?.behindSince ?? now : null;
  const currentError = Boolean(status?.canonical?.error) && srcRev !== null &&
    revision(status?.canonical?.errorRev) === srcRev;
  const overloaded = behindSince !== null && now - behindSince >= PDF_LIVE_BEHIND_THRESHOLD_MS;
  const working = !status || status.busy || status.render?.queued?.length || status.render?.active?.length ||
    status.render?.pumping || status.cold?.pending?.length || status.shipping?.retry?.state === "booting" ||
    status.canonical?.compiling || status.canonical?.inFlight || Number(status.canonical?.authorityChildren) > 0 ||
    typeof status.canonical?.scheduledInMs === "number" ||
    (srcRev !== null && revision(status.canonical?.displayDemandRev) === srcRev) ||
    presentationPending !== false || behind || srcRev === null ||
    revision(status.canonical?.rev) === null || Number(status.canonical?.rev) < srcRev;
  return {
    color: status?.up === false || currentError || overloaded ? "red" : working ? "orange" : "green",
    srcRev,
    drawnRev,
    behindSince,
  };
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
