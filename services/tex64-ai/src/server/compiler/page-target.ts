export type PageTarget = {
  minimum: number;
  maximum?: number;
  approximate: boolean;
};

export type PageTargetEvaluation =
  | { status: "not_applicable" }
  | { status: "unsupported" }
  | {
      status: "passed" | "failed";
      target: PageTarget;
      observed: number;
    };

/** Matches the bounded full-page visual inspection contract. */
export const MAX_PAGE_TARGET = 500;

function boundedPageCount(value: string | undefined): number | null {
  if (!value || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_PAGE_TARGET
    ? parsed
    : null;
}

/**
 * Parses the page expressions accepted by the intake flow. Character and word
 * targets deliberately return null so they remain owned by the pre-render
 * acceptance gate.
 */
export function parsePageTarget(rawValue: string): PageTarget | null {
  const normalized = rawValue
    .normalize("NFKC")
    .replaceAll(",", "")
    .replaceAll(/\s+/gu, "")
    .toLocaleLowerCase();
  if (!/(?:ページ|頁|pages?)/u.test(normalized)) return null;
  if (/(?:文字|字|単語|語|characters?|words?)/u.test(normalized)) return null;

  const approximate = /(?:約|およそ|だいたい|程度|前後|about|around|approx(?:imately)?)/u.test(
    normalized,
  );
  const compact = normalized
    .replaceAll(/(?:ページ|頁|pages?)/gu, "")
    .replaceAll(/(?:約|およそ|だいたい|程度|前後|about|around|approx(?:imately)?)/gu, "");

  const range = compact.match(/^(\d+)(?:-|–|—|~|〜|～|から|to)(\d+)$/u);
  if (range) {
    const minimum = boundedPageCount(range[1]);
    const maximum = boundedPageCount(range[2]);
    if (minimum === null || maximum === null || minimum > maximum) return null;
    return { minimum, maximum, approximate: false };
  }

  const atLeast = compact.match(/^(\d+)(?:以上|以上で|ormore|andover|minimum)$/u);
  if (atLeast) {
    const minimum = boundedPageCount(atLeast[1]);
    return minimum === null
      ? null
      : { minimum, approximate: false };
  }

  const atMost = compact.match(/^(\d+)(?:以下|以内|まで|orless|andunder|maximum)$/u);
  if (atMost) {
    const maximum = boundedPageCount(atMost[1]);
    return maximum === null
      ? null
      : { minimum: 1, maximum, approximate: false };
  }

  const exact = boundedPageCount(compact);
  if (exact === null) return null;
  if (!approximate) {
    return { minimum: exact, maximum: exact, approximate: false };
  }
  const tolerance = Math.max(1, Math.ceil(exact * 0.1));
  return {
    minimum: Math.max(1, exact - tolerance),
    maximum: Math.min(MAX_PAGE_TARGET, exact + tolerance),
    approximate: true,
  };
}

export function evaluateRenderedPageTarget(
  rawTarget: string | null,
  observed: number,
): PageTargetEvaluation {
  if (!rawTarget || !/(?:ページ|頁|pages?)/iu.test(rawTarget)) {
    return { status: "not_applicable" };
  }
  if (!Number.isSafeInteger(observed) || observed < 1) {
    return { status: "unsupported" };
  }
  const target = parsePageTarget(rawTarget);
  if (!target) return { status: "unsupported" };
  const passed =
    observed >= target.minimum &&
    (target.maximum === undefined || observed <= target.maximum);
  return { status: passed ? "passed" : "failed", target, observed };
}
