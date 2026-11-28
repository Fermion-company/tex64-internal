// The paper point a covered Live frame must show before it may replace the
// static PDF (pdf-viewer.js liveViewportHandoff), as pure decisions.

// Frames without the viewport token only report their top page; a centred
// paper point on page N leaves N or a page or two above it at the top,
// while an unmoved frame is still at its first page.
export const LIVE_HANDOFF_PAGE_SLACK = 2;

// A document reset (preamble edit, bibliography, opaque transition) rebuilds
// the frame's paper from its first page, and the reader's place is handed to
// the new paper. The handoff keeps that place until the frame stands there
// and has painted it (it is clamped only to a complete paper that is
// shorter). A paper that makes no progress for this long (no more pages,
// nothing newly painted, the frame not moved closer) is stalled: the viewer
// reloads the frame, once per reset. A stall no reload can help (the reset
// had its reload; a first edit's handoff, which has none) lets go of the
// point: the frame goes to the nearest page it has and is revealed there as
// soon as its paper is presentable. The cover never stays for good
// (audit/scratch r7 points.mjs: a point the shorter sheet could not centre
// kept it, the host resending it every 8 s).
export const LIVE_RESET_STALL_MS = 8000;

export type LiveHandoffSync = {
  page: number;
  x?: number;
  y?: number;
  blockY?: number;
  blockHeight?: number;
  marker?: boolean;
  viewportToken?: string;
  // an outer paper's live page by the frame's own number (goto-sync's
  // `page` of a grown chapter can be a trailing sheet's)
  livePage?: number;
};

export type LiveHandoff = {
  sync: LiveHandoffSync;
  // the reader's place as handed over: a chapter that is shorter for now
  // resolves `sync` from it on each snapshot, never in place of it
  origin?: LiveHandoffSync;
  // a document reset's handoff: the stall clock below (others run it at
  // LIVE_RESET_STALL_MS, with no reload)
  stallMs?: number;
  progressAt?: number;
  progress?: string;
  // the point was let go after a stall: the nearest page will do
  released?: boolean;
};

export type LiveFrameSnapshot = {
  page?: unknown;
  pageCount?: unknown;
  // the top page and the count in goto-sync's numbering (an outer paper's
  // sheets keep the Build's numbers); frames before them report page only
  syncPage?: unknown;
  syncPageCount?: unknown;
  viewportToken?: unknown;
  // the sheet the token was acknowledged for holds the viewport's centre
  tokenSheetShown?: unknown;
  // ...and the point it was acknowledged for stands at that centre (or as
  // near it as a scroll held at the paper's top or bottom allows)
  tokenPointShown?: unknown;
  // the live chapter's own pages (an outer paper's sheets not counted)
  livePageCount?: unknown;
  // the Build's sheets of the live chapter, in goto-sync's numbering (a
  // static Build viewer names the chapter's pages by these)
  chapter?: { from?: unknown; to?: unknown } | null;
  // the frame's own page count will not change by itself (no layout owed),
  // though it does not claim canonical's authority (a failing canonical)
  pageCountSettled?: unknown;
  ready?: unknown;
  painted?: unknown;
  presentationPending?: unknown;
  srcRev?: unknown;
  status?: { rev?: unknown; canonical?: { rev?: unknown } | null } | null;
};

export type LiveViewportCenter =
  { page?: unknown; livePage?: unknown; y?: unknown; paperPx?: unknown } | null | undefined;

export type LiveHandoffStep = {
  // the handoff no longer holds the reveal: the frame shows the point
  done: boolean;
  // the page to (re)send the point to
  goto: number | null;
  // the frame stands at the point (its paper there may still be painting)
  positioned: boolean;
  // a reset's paper stopped getting closer to the point
  stalled: boolean;
  // reload the frame (a stall short of the point, the reset's one reload)
  reload: boolean;
};

/** The page the frame must show for `sync`, or null while it cannot. */
export const resolveLiveViewportTarget = (
  sync: LiveHandoffSync | null | undefined,
  data: LiveFrameSnapshot | null | undefined,
  authoritative: boolean,
): number | null => {
  const desired = Math.max(1, Number(sync?.page) || 1);
  const pageCount = Math.max(0, Number(data?.syncPageCount ?? data?.pageCount) || 0);
  if (pageCount >= desired) return desired;
  // A cold or rebuilding frame can temporarily expose only its first few
  // pages. Keep the static viewport request intact until those pages exist.
  // Only a complete paper may establish that the requested page was really
  // removed and should therefore resolve to its new final page.
  if (pageCount > 0 && authoritative) return pageCount;
  return null;
};

/**
 * What the host sends for the frame to stand on `page`: the handoff's point
 * under its own token there, and under a token of that page's own when the
 * page is another (a paper shorter for now, the nearest page after a stall):
 * the frame acknowledges a token on the sheet it scrolled to, and page 5's
 * acknowledgement was taken for page 10 once the paper grew back to ten
 * under the same token (audit/scratch r7 points.mjs).
 */
export const liveHandoffSyncFor = (handoff: LiveHandoff, page: number): LiveHandoffSync => {
  const wanted = Math.max(1, Number(handoff.sync?.page) || 1);
  return page === wanted
    ? { ...handoff.sync, page }
    : { ...handoff.sync, page, viewportToken: `${handoff.sync?.viewportToken ?? "live"}@${page}` };
};

/**
 * One snapshot of the covered frame against its handoff. The point is kept
 * until the frame stands there and has painted it (`presentable`: the
 * viewer's own gate, the frame's paint included): a paper still short of
 * the reader's page is waited for, not clamped. A reset's handoff (stallMs)
 * measures progress (more pages, newly painted or rendered paper, the frame
 * at the point) and reports a stall; the first one short of the point asks
 * for a reload (`reloadAvailable`: the reset has not had its one yet). Any
 * other stall releases the point (LIVE_RESET_STALL_MS).
 */
export const stepLiveViewportHandoff = (
  handoff: LiveHandoff,
  data: LiveFrameSnapshot | null | undefined,
  { now, presentable, authoritative, reloadAvailable = false, expectedSrcRev = null }:
    { now: number; presentable: boolean; authoritative: boolean; reloadAvailable?: boolean; expectedSrcRev?: unknown },
): LiveHandoffStep => {
  // A paper whose page count is final for now: canonical's, or the frame's
  // own settled count while canonical fails (the frame then clears its
  // authority, and the reader was left under the cover). After a Build only
  // a paper of the revision the first edit became can say so: the frame's
  // count of the revision before it is no count of the paper to be shown
  // (audit/scratch boundaries.mjs: a frame still on source 2 with three
  // chapter pages sent the reader from sheet 6 to 5, and source 3 had four).
  const sourceCurrent = !Number.isInteger(expectedSrcRev) || Number(data?.srcRev) >= Number(expectedSrcRev);
  const complete = authoritative || data?.pageCountSettled === true && sourceCurrent;
  const origin = handoff.origin ?? (handoff.origin = handoff.sync);
  // A live page of an outer paper's chapter (the reader's own place) that a
  // complete chapter does not have any more: the handoff goes to the
  // chapter's last page, under a token of its own (the frame acknowledges a
  // token only on the sheet it names, and the Build's sheet count would keep
  // the old one looking reachable for good). A place taken from the static
  // Build viewer names a sheet of the Build's chapter: the live page it is.
  let wantedLive = Number(origin?.livePage);
  const from = Number(data?.chapter?.from);
  const to = Number(data?.chapter?.to);
  const asked = Number(origin?.page);
  if (!Number.isInteger(wantedLive) && Number.isInteger(from) && Number.isInteger(to) && asked >= from && asked <= to) {
    wantedLive = asked - from + 1;
  }
  const livePages = Number(data?.livePageCount);
  if (complete && Number.isInteger(wantedLive) && Number.isInteger(livePages) &&
      livePages >= 1 && wantedLive > livePages) {
    const before = asked - wantedLive;
    handoff.sync = {
      ...origin, page: before + livePages, livePage: livePages,
      viewportToken: `${origin.viewportToken ?? "live"}~${livePages}`,
    };
  } else if (Number.isInteger(livePages) && livePages >= 1) {
    // (the chapter has the reader's page again, or is not complete yet: the
    // place itself, under its own token)
    handoff.sync = origin;
  }
  const pageCount = Math.max(0, Number(data?.syncPageCount ?? data?.pageCount) || 0);
  const target = resolveLiveViewportTarget(handoff.sync, data, complete || handoff.released === true);
  const page = Number(data?.syncPage ?? data?.page);
  // (the token the frame was sent for the target: liveHandoffSyncFor)
  const tokenConfirmed = data && "viewportToken" in data
    ? target !== null && data.viewportToken === liveHandoffSyncFor(handoff, target).viewportToken
    : true;
  // A frame that says whether the very sheet it acknowledged the token for
  // is in view is taken at that: it acknowledges only the sheet named, so a
  // page with a nearby number cannot stand in for it, and a centred sheet is
  // not refused because another sheet's number is at the top. Older frames
  // are judged by their top page within the slack.
  // A frame that says whether the point itself stands at its centre is taken
  // at that: the sheet alone let a centre that drifted from y=300 to y=500
  // on it confirm the handoff (audit/scratch boundaries.mjs).
  const shown = typeof data?.tokenPointShown === "boolean" ? data.tokenPointShown : data?.tokenSheetShown;
  const positioned = !!target && tokenConfirmed && (typeof shown === "boolean"
    ? shown
    : page <= target && page >= target - LIVE_HANDOFF_PAGE_SLACK);
  const reset = Number(handoff.stallMs) > 0;
  // (the clock runs from the new paper's first snapshot; rendering that
  // lands at a fixed page count moves the engine's revision)
  const progress = [Math.min(pageCount, Number(handoff.sync?.page) || 1), positioned,
    data?.painted === true, data?.ready === true, data?.presentationPending === false,
    Number(data?.srcRev) || 0, Number(data?.status?.rev) || 0].join(":");
  if (handoff.progress !== progress || !Number.isFinite(handoff.progressAt)) {
    handoff.progress = progress;
    handoff.progressAt = now;
  }
  const stalled = now - Number(handoff.progressAt) >= (reset ? Number(handoff.stallMs) : LIVE_RESET_STALL_MS);
  if (positioned && presentable) return { done: true, goto: null, positioned, stalled: false, reload: false };
  const reload = reset && stalled && !positioned && reloadAvailable;
  if (stalled && !reload) handoff.released = true;
  // Released: the nearest page the frame has, and the reveal as soon as its
  // paper is presentable.
  if (handoff.released) {
    return { done: presentable, goto: target ?? resolveLiveViewportTarget(handoff.sync, data, true), positioned, stalled: true, reload: false };
  }
  // Once the target exists, retry on snapshots until both its location and
  // token are confirmed (and its paper is painted there).
  return { done: false, goto: target, positioned, stalled, reload };
};

/**
 * Whether the frame's paper may replace the static PDF. Whatever the gate,
 * the sheets the frame shows must have paper on them (`painted`; a frame that
 * does not say is taken at its other signals): a recent canonical revision is
 * no paper on an empty shell. After a Build (`expectedSrcRev`) the frame must
 * have applied the accepted revision and hold paper complete for it, or a
 * canonical generation that already contains it; other activations wait for
 * an exact paint (`ready`).
 */
export const livePaperPresentableFor = (
  data: LiveFrameSnapshot & { status?: { canonical?: { rev?: unknown } | null; rev?: unknown } | null } | null | undefined,
  expectedSrcRev: unknown,
): boolean => {
  if (!data || data.painted === false) return false;
  if (!Number.isInteger(expectedSrcRev)) return data.ready === true;
  const applied = !("srcRev" in data) || Number(data.srcRev) >= Number(expectedSrcRev);
  const canonicalRev = Number(data.status?.canonical?.rev);
  // Typing keeps the next compile running back-to-back; a landed
  // generation is still paper that contains the edit.
  const canonicalCovers = Number.isFinite(canonicalRev) && canonicalRev >= Number(expectedSrcRev);
  return applied && (data.ready === true || data.presentationPending === false || canonicalCovers);
};

/** A reset's cover still stands where it put the reader's live place (its
 * own placement scrolls do not move it): the toolbar keeps the live page
 * then, PDF.js would name its most visible page instead of the top one. */
export const coverHoldsReaderPage = (handoff: { coverScrollTop?: number | null } | null | undefined, scrollTop: number): boolean =>
  handoff?.coverScrollTop != null && Math.abs(Number(scrollTop) - Number(handoff.coverScrollTop)) < 2;

/** The reader's place on the live paper in the goto-sync form: the paper
 * point at the centre of the frame's viewport, when the frame reports one. */
export const liveReaderPlace = (center: LiveViewportCenter): LiveHandoffSync | null => {
  const page = Number(center?.page);
  const y = Number(center?.y);
  if (!Number.isInteger(page) || page < 1 || !Number.isFinite(y) || y < 0) return null;
  // where the reader was, not a Jump target: no landing marker
  const place: LiveHandoffSync = { page, x: 0, y, blockY: y, blockHeight: 0, marker: false };
  // (a live page of an outer paper: the frame's own name for it)
  const livePage = Number(center?.livePage);
  if (Number.isInteger(livePage) && livePage >= 1) place.livePage = livePage;
  return place;
};

/**
 * The PDF.js scale at which the static page is drawn as wide as the live
 * paper was (`paperPx` CSS px; Live draws its paper at min(92%, 640px) times
 * its zoom, PDF.js at its own page width). `cssPerScale`: the page's CSS
 * width at scale 1. Null when either is unknown.
 */
export const coverScaleFor = (paperPx: unknown, cssPerScale: unknown): number | null => {
  const width = Number(paperPx);
  const unit = Number(cssPerScale);
  if (!(width > 0) || !(unit > 0)) return null;
  return width / unit;
};
