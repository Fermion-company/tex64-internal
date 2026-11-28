import { useEffect, useRef, useState, type RefObject } from "react";
import styles from "./pdf-preview.module.css";

export type PdfTextSelection = { page: number; endPage?: number; text: string };

function textLayerFor(node: Node | null, scroller: HTMLElement) {
  const element = node instanceof Element ? node : node?.parentElement;
  const layer = element?.closest<HTMLElement>("[data-pdf-text-page]");
  return layer && scroller.contains(layer) ? layer : null;
}

// Only include PDF text. A browser range across pages may also contain the
// annotation links, edit controls or proposal labels rendered between them.
function selectedText(range: Range, start: HTMLElement, end: HTMLElement) {
  const root = start.closest("[data-pdf-page-index]")?.parentElement;
  if (!root || !start.isConnected || !end.isConnected || range.collapsed ||
      !start.contains(range.startContainer) || !end.contains(range.endContainer)) return null;
  const page = Number(start.dataset.pdfTextPage);
  const endPage = Number(end.dataset.pdfTextPage);
  const parts: string[] = [];
  for (const layer of root.querySelectorAll<HTMLElement>("[data-pdf-text-page]")) {
    const number = Number(layer.dataset.pdfTextPage);
    if (number < page || number > endPage) continue;
    const part = document.createRange();
    part.selectNodeContents(layer);
    if (layer === start) part.setStart(range.startContainer, range.startOffset);
    if (layer === end) part.setEnd(range.endContainer, range.endOffset);
    const contents = part.cloneContents();
    contents.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
    const text = contents.textContent?.trim();
    if (text) parts.push(text);
  }
  return parts.length ? { page, ...(page === endPage ? {} : { endPage }), text: parts.join("\n\n") } : null;
}

type SelectionAction = { range: Range; start: HTMLElement; end: HTMLElement; x: number; y: number; below: boolean };

export function PdfSelectionAction({ scrollerRef, onAsk }: {
  scrollerRef: RefObject<HTMLDivElement | null>;
  onAsk: (selection: PdfTextSelection) => void;
}) {
  const [action, setAction] = useState<SelectionAction | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      if (buttonRef.current && document.activeElement === buttonRef.current) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) {
        setAction(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const start = textLayerFor(range.startContainer, scroller);
      const end = textLayerFor(range.endContainer, scroller);
      if (!start || !end) {
        setAction(null);
        return;
      }
      const tip = range.cloneRange();
      const backward = selection.focusNode === range.startContainer && selection.focusOffset === range.startOffset;
      tip.collapse(backward);
      const rect = tip.getBoundingClientRect();
      const box = scroller.getBoundingClientRect();
      if (!rect.height || rect.bottom < box.top || rect.top > box.bottom || rect.right < box.left || rect.left > box.right) {
        setAction(null);
        return;
      }
      const below = rect.top - box.top < 42;
      setAction({
        range: range.cloneRange(), start, end,
        x: rect.left - box.left,
        y: below ? rect.bottom - box.top + 6 : rect.top - box.top - 6,
        below,
      });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const button = buttonRef.current;
      const layer = textLayerFor(document.activeElement, scroller);
      if (!button || (!layer && document.activeElement !== button)) return;
      if (event.key === "Tab" && !event.shiftKey && layer) {
        event.preventDefault();
        button.focus({ preventScroll: true });
      } else if (event.key === "Escape") {
        event.preventDefault();
        if (document.activeElement === button) {
          textLayerFor(window.getSelection()?.focusNode ?? null, scroller)?.focus({ preventScroll: true });
        }
        window.getSelection()?.removeAllRanges();
        setAction(null);
      }
    };
    document.addEventListener("selectionchange", schedule);
    document.addEventListener("keydown", onKey);
    scroller.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("keydown", onKey);
      scroller.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [scrollerRef]);
  if (!action) return null;
  return <button type="button" ref={buttonRef} className={styles.askSelection}
    style={{ left: `clamp(6px, ${action.x}px, 100% - 100px)`, top: action.y, transform: action.below ? undefined : "translateY(-100%)" }}
    onMouseDown={(event) => event.preventDefault()}
    onBlur={() => setAction(null)}
    onClick={() => {
      const scope = selectedText(action.range, action.start, action.end);
      window.getSelection()?.removeAllRanges();
      setAction(null);
      if (scope) onAsk(scope);
    }}>Axiomに依頼</button>;
}
