"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFPageProxy, TextLayer } from "pdfjs-dist";
import { loadPdfjs } from "@/lib/client/pdfjs";
import styles from "./pdf-preview.module.css";

type PageText = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>;
const textCache = new WeakMap<PDFPageProxy, Promise<PageText>>();
export function readPageText(page: PDFPageProxy) {
  let value = textCache.get(page);
  if (!value) { value = page.getTextContent(); textCache.set(page, value); }
  return value;
}
export type PdfSearchHit = { id: number; page: number; start: number; end: number };
export function searchableText(content: PageText) {
  return content.items.map((item) => "str" in item ? item.str : "").join(" ");
}
type PdfLink = { id: string; rect: [number, number, number, number]; url?: string; dest?: unknown; label: string };

export function PdfTextLayer({ page, scale, editing, hits, activeHit, onEdit, onNavigate }: {
  page: PDFPageProxy;
  scale: number;
  editing: boolean;
  hits: PdfSearchHit[];
  activeHit: number | null;
  onEdit: (clientX: number, clientY: number) => void;
  onNavigate: (destination: unknown, url?: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<TextLayer | null>(null);
  const [links, setLinks] = useState<PdfLink[]>([]);
  const [ready, setReady] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let layer: TextLayer | null = null;
    void Promise.all([loadPdfjs(), readPageText(page), page.getAnnotations()]).then(([pdfjs, text, annotations]) => {
      if (cancelled) return;
      host.replaceChildren();
      layer = new pdfjs.TextLayer({ textContentSource: text, container: host, viewport: page.getViewport({ scale }) });
      layerRef.current = layer;
      return layer.render().then(() => {
        if (cancelled) return;
        const textItems = text.items.filter((item) => "str" in item);
        let offset = 0;
        layer!.textDivs.forEach((span, index) => {
          span.dataset.textStart = String(offset);
          span.dataset.textEnd = String(offset + (textItems[index]?.str.length ?? 0));
          offset += (textItems[index]?.str.length ?? 0) + 1;
        });
        setLinks(annotations.filter((a) => a.subtype === "Link" && Array.isArray(a.rect) && a.rect.length === 4 && a.rect.every(Number.isFinite)).map((a) => ({
          id: a.id, rect: a.rect, url: typeof a.url === "string" && /^https?:\/\//iu.test(a.url) ? a.url : undefined,
          dest: a.dest, label: textItems.filter((item) => {
            const x = item.transform[4], y = item.transform[5];
            return x + item.width >= a.rect[0] && x <= a.rect[2] && y + item.height >= a.rect[1] && y <= a.rect[3];
          }).map((item) => item.str).join(" ").trim() || a.url || "文書内のリンク",
        })));
        setFailed(false);
        setReady((value) => value + 1);
      });
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; layer?.cancel(); layerRef.current = null; };
    // TextLayer is rebuilt on scale changes so highlights and keyboard targets
    // share the exact viewport with the canvas, without stale hit areas.
  }, [page, scale]);

  useEffect(() => {
    layerRef.current?.textDivs.forEach((span) => {
      // A PDF text item can be a single glyph. Turning every item into a
      // button made one equation appear as dozens of unrelated controls and
      // made keyboard navigation unusable. The text layer remains the pointer
      // target; selection is resolved into one source-owned block by the
      // parent preview.
      span.removeAttribute("tabindex");
      span.removeAttribute("role");
      span.removeAttribute("aria-label");
      const start = Number(span.dataset.textStart);
      const end = Number(span.dataset.textEnd);
      const matches = hits.filter((hit) => hit.end > start && hit.start < end);
      span.classList.toggle(styles.searchHit!, matches.length > 0);
      span.classList.toggle(styles.activeSearchHit!, matches.some((hit) => hit.id === activeHit));
      if (matches.some((hit) => hit.id === activeHit)) span.dataset.activePdfHit = "true";
      else delete span.dataset.activePdfHit;
    });
  }, [editing, hits, activeHit, ready]);

  return <>
    <div ref={hostRef} className={`textLayer ${styles.textLayer}${editing ? ` ${styles.editingText}` : ""}`}
      style={{ "--total-scale-factor": scale } as React.CSSProperties}
      onClick={(event) => { if (editing && !(window.getSelection()?.toString())) onEdit(event.clientX, event.clientY); }}
      onKeyDown={(event) => {
        if (editing && (event.key === "Enter" || event.key === " ") && event.target instanceof HTMLElement) {
          event.preventDefault(); const rect = event.target.getBoundingClientRect(); onEdit(rect.left + rect.width / 2, rect.top + rect.height / 2);
        }
      }} />
    <div className={styles.linkLayer}>
      {links.filter((link) => link.dest || link.url).map((link) => {
        const viewport = page.getViewport({ scale });
        const rect = [...viewport.convertToViewportPoint(link.rect[0], link.rect[1]), ...viewport.convertToViewportPoint(link.rect[2], link.rect[3])];
        return <a key={link.id} href={link.url ?? "#"} title={link.label} aria-label={link.label}
          style={{ left: Math.min(rect[0], rect[2]), top: Math.min(rect[1], rect[3]), width: Math.abs(rect[2] - rect[0]), height: Math.abs(rect[3] - rect[1]) }}
          onClick={(event) => { event.preventDefault(); event.stopPropagation(); onNavigate(link.dest, link.url); }} />;
      })}
    </div>
    {failed ? <span className={styles.textError} role="status">本文の選択を読み込めませんでした。</span> : null}
  </>;
}
