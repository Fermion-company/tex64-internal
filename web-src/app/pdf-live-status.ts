export type PdfLiveStatusKey =
  | "live"
  | "liveUpdating"
  | "liveExactRendering"
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
    error?: string | null;
    errorRev?: number;
  } | null;
};

/** Convert the engine snapshot into one unambiguous viewer state. */
export const resolvePdfLiveStatus = (
  status: PdfLiveEngineStatus | null | undefined
): PdfLiveStatusView | null => {
  if (!status) return null;
  if (status.up === false) {
    return { key: "liveUnavailable", tone: "error", detail: "" };
  }
  // canonical.inFlight is the exact LuaLaTeX path. It may overlap with the
  // foreground engine's generic busy flag, so it must take precedence.
  if (status.canonical?.inFlight) {
    return { key: "liveExactRendering", tone: "busy", detail: "" };
  }
  if (status.busy) {
    return { key: "liveUpdating", tone: "busy", detail: "" };
  }
  if (status.canonical?.error &&
      Number(status.canonical.errorRev) >= Number(status.srcRev)) {
    return { key: "liveError", tone: "error", detail: status.canonical.error };
  }
  if (status.mode === "opaque") {
    return { key: "liveFullCompile", tone: "idle", detail: "" };
  }
  return { key: "live", tone: "idle", detail: "" };
};
