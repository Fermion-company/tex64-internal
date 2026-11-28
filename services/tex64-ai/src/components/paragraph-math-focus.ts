import type { PdfTextHit } from "./pdf-text-blocks";

type MathfieldElement = HTMLElement & { getValue(format: "math-ml"): string };

const normalize = (text: string) => text.normalize("NFKC").replace(/[\s\u200B-\u200D\u2061-\u2064]/gu, "").replace(/−/gu, "-");

type HitTarget = { start: number; end: number; element: HTMLElement; text?: Text };

/** Focus the glyph clicked on the paper, using the surrounding row to
 * distinguish identical values in different cells and inline formulas. */
export function focusClickedContent(host: HTMLElement, hit: PdfTextHit): boolean {
  const before = normalize(hit.before).slice(-64);
  const after = normalize(hit.after).slice(0, 64);
  if (!after) return false;
  let rendered = "";
  const targets: HitTarget[] = [];
  for (const editor of host.querySelectorAll<HTMLElement>(".paragraph-edit-area")) {
    for (const child of editor.childNodes) {
      const start = rendered.length;
      if (child instanceof Text) {
        rendered += normalize(child.data);
        if (editor.isContentEditable) targets.push({ start, end: rendered.length, element: editor, text: child });
      } else if (child instanceof HTMLElement) {
        const field = child.querySelector<MathfieldElement>("math-field");
        if (!field) continue;
        const math = new DOMParser().parseFromString(field.getValue("math-ml"), "application/xml");
        rendered += normalize(math.documentElement.textContent ?? "");
        targets.push({ start, end: rendered.length, element: field });
      }
    }
  }
  let bestScore = 0;
  let match: HitTarget | undefined;
  let position = -1;
  for (let pos = rendered.indexOf(after[0]!); pos !== -1; pos = rendered.indexOf(after[0]!, pos + 1)) {
    let left = 0, right = 0;
    while (left < before.length && rendered[pos - left - 1] === before[before.length - left - 1]) left++;
    while (right < after.length && rendered[pos + right] === after[right]) right++;
    const score = left + right;
    if (score < bestScore) continue;
    const target = targets.find(({ start, end }) => pos >= start && pos < end);
    if (score > bestScore) {
      match = target;
      position = pos;
    } else {
      if (match !== target) match = undefined;
      position = -1;
    }
    bestScore = score;
  }
  if (!match) return false;
  match.element.focus();
  if (match.text && position >= 0) {
    // PDF matching ignores whitespace and folds ligatures. The DOM caret
    // uses an offset in the original UTF-16 text, including both.
    let normalizedOffset = match.start;
    for (const { segment, index } of new Intl.Segmenter().segment(match.text.data)) {
      normalizedOffset += normalize(segment).length;
      if (normalizedOffset > position) {
        host.ownerDocument.getSelection()?.collapse(match.text, index);
        break;
      }
    }
  }
  return true;
}
