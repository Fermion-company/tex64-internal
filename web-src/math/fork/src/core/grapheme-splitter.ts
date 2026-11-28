export function stringToCodepoints(string: string): number[] {
  const result: number[] = [];
  for (let i = 0; i < string.length; i++) {
    let code = string.charCodeAt(i);
    if (code === 0x0d && string.charCodeAt(i + 1) === 0x0a) {
      code = 0x0a;
      i++;
    }

    if (code === 0x0d || code === 0x0c) code = 0x0a;
    if (code === 0x00) code = 0xfffd;

    // Decode a surrogate pair into an astral codepoint.
    if (code >= 0xd800 && code <= 0xdbff) {
      const nextCode = string.charCodeAt(i + 1);
      if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
        const lead = code - 0xd800;
        const trail = nextCode - 0xdc00;
        code = 2 ** 16 + lead * 2 ** 10 + trail;
        // N = ((H - 0xD800) * 0x400) + (L - 0xDC00) + 0x10000;
        i++;
      }
    }

    result.push(code);
  }

  return result;
}

const ZWJ = 0x200d; // Zero-width joiner

// const ZWSP = 0x200b; // Zero-width space

/* The following codepoints should combine with the previous ones */
const EMOJI_COMBINATOR = [
  [ZWJ, 1],
  [0xfe0e, 2], // VS-15: text presentation, VS-16: Emoji presentation
  [0x1f3fb, 5], // EMOJI_MODIFIER_FITZPATRICK_TYPE 1-6
  [0x1f9b0, 4], // Red hair..white hair
  [0xe0020, 96], // EMOJI_TAG
];
let emojiCombinator: Record<number, boolean>;

// Regional indicator: a pair of codepoints indicating some flags
const REGIONAL_INDICATOR = [0x1f1e6, 0x1f1ff];

function isEmojiCombinator(code: number): boolean {
  if (emojiCombinator === undefined) {
    emojiCombinator = {};
    for (const x of EMOJI_COMBINATOR)
      for (let i = x[0]; i <= x[0] + x[1] - 1; i++) emojiCombinator[i] = true;
  }

  return emojiCombinator[code] ?? false;
}

function isRegionalIndicator(code: number): boolean {
  return code >= REGIONAL_INDICATOR[0] && code <= REGIONAL_INDICATOR[1];
}

/**
 * Return a string or an array of graphemes.
 * This includes:
 * - emoji with skin and hair modifiers
 * - emoji combination (for example "female pilot")
 * - text emoji with an emoji presentation style modifier
 *      - U+1F512 U+FE0E 🔒︎
 *      - U+1F512 U+FE0F 🔒️
 * - flags represented as two regional indicator codepoints
 * - flags represented as a flag emoji + zwj + an emoji tag
 * - other combinations (for example, rainbow flag)
 */

export function splitGraphemes(string: string): string | string[] {
  // If it's all ASCII, short-circuit the grapheme splitting...
  if (/^[\u0020-\u00FF]*$/.test(string)) return string;

  const result: string[] = [];

  const codePoints = stringToCodepoints(string);
  let index = 0;
  while (index < codePoints.length) {
    const start = index;
    const code = codePoints[index++];
    if (isRegionalIndicator(code) && isRegionalIndicator(codePoints[index]))
      index++;
    while (index < codePoints.length && isEmojiCombinator(codePoints[index])) {
      const modifier = codePoints[index++];
      if (modifier === ZWJ && index < codePoints.length) index++;
    }
    result.push(String.fromCodePoint(...codePoints.slice(start, index)));
  }

  return result;
}
