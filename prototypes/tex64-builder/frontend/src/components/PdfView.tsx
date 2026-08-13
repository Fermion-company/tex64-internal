import { useEffect, useRef } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

const PAGE_WIDTH = 620;

/**
 * 組版済みPDFの紙面表示。ページをクリックすると編集ビューへ切り替わる。
 */
export function PdfView({ url, onActivateEdit }: { url: string; onActivateEdit: () => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const scroller = scrollRef.current;
    const stage = stageRef.current;
    if (!stage || !scroller) return;

    const task = pdfjsLib.getDocument(url);
    (async () => {
      try {
        const pdf = await task.promise;
        if (cancelled) return;
        const savedScroll = scroller.scrollTop;
        const canvases: HTMLCanvasElement[] = [];
        const dpr = Math.min(window.devicePixelRatio || 1, 2.5);

        for (let n = 1; n <= pdf.numPages; n++) {
          const page = await pdf.getPage(n);
          if (cancelled) return;
          const base = page.getViewport({ scale: 1 });
          const scale = (PAGE_WIDTH / base.width) * dpr;
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.width = `${PAGE_WIDTH}px`;
          canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
          canvas.className = 'pdf-page';
          const ctx = canvas.getContext('2d');
          if (!ctx) continue;
          await page.render({ canvasContext: ctx, viewport, canvas }).promise;
          canvases.push(canvas);
        }
        if (cancelled) return;
        stage.replaceChildren(...canvases);
        scroller.scrollTop = savedScroll;
      } catch (err) {
        if (!cancelled) console.warn('[pdf] render failed:', err);
      }
    })();

    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [url]);

  return (
    <div className="paper-scroll pdf-scroll" ref={scrollRef}>
      <div
        className="pdf-stage"
        ref={stageRef}
        title="クリックして編集"
        onClick={onActivateEdit}
      />
    </div>
  );
}
