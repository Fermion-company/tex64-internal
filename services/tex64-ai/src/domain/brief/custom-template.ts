export type SafeCustomTemplatePreset =
  | "standard"
  | "academic"
  | "business"
  | "compact";

const RAW_TEMPLATE_PATTERN =
  /\\[A-Za-z@]+|\.(?:cls|sty|tex)\b|https?:\/\/|(?:^|[\s"'])(?:\.\.\/|\.\/|\/)[^\s]*/iu;

const PRESET_MARKERS: ReadonlyArray<
  readonly [SafeCustomTemplatePreset, RegExp]
> = [
  ["standard", /標準|一般|standard|general|読みやすい/u],
  ["academic", /学術|査読|論文向け|academic/u],
  ["business", /ビジネス|業務文書|経営会議|社内会議|business/u],
  ["compact", /コンパクト|省スペース|要点中心|compact/u],
];

/** Raw classes, files, URLs, and TeX commands are never accepted as styles. */
export function isRawTemplateRequest(value: string): boolean {
  return RAW_TEMPLATE_PATTERN.test(value.normalize("NFKC"));
}

/**
 * Maps a descriptive style request onto an actually rendered preset. Exactly
 * one supported visual intent must be present; ambiguous requests fail closed.
 */
export function resolveSafeCustomTemplatePreset(
  value: string | null,
): SafeCustomTemplatePreset | null {
  if (!value) return null;
  const normalized = value
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
  if (!normalized || normalized.length > 500 || isRawTemplateRequest(normalized)) {
    return null;
  }
  const matches = PRESET_MARKERS.filter(([, pattern]) =>
    pattern.test(normalized),
  ).map(([preset]) => preset);
  return matches.length === 1 ? matches[0]! : null;
}
