import type { DocumentModel } from '../types';
import { stripHtml } from './latex';

export interface OutlineItem {
  id: string;
  label: string;
}

export function outlineItems(doc: DocumentModel): OutlineItem[] {
  const items: OutlineItem[] = [];
  let n = 0;
  for (const b of doc.blocks) {
    if (b.type === 'abstract') items.push({ id: b.id, label: '概要' });
    else if (b.type === 'heading') {
      n += 1;
      items.push({ id: b.id, label: `${n}.  ${stripHtml(b.html)}` });
    } else if (b.type === 'references') items.push({ id: b.id, label: '参考文献' });
  }
  return items;
}

let autoScrollUntil = 0;

/** プログラムによるスクロール中(アウトラインのアクティブ追従を一時停止する) */
export function isAutoScrolling(): boolean {
  return performance.now() < autoScrollUntil;
}

/** 紙面の該当ブロックへスムーススクロール(環境差を避けるため自前アニメーション) */
export function scrollToBlock(id: string): void {
  const el = document.getElementById(`blk-${id}`);
  const scroller = el?.closest('.paper-scroll');
  if (!el || !scroller) return;

  let target = Math.min(
    scroller.scrollTop + el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 20,
    scroller.scrollHeight - scroller.clientHeight,
  );
  if (target < 140) target = 0; // 先頭付近ならタイトルごと見せる
  const from = scroller.scrollTop;
  const dist = target - from;
  if (Math.abs(dist) < 1) return;

  const duration = 320;
  const start = performance.now();
  autoScrollUntil = start + duration + 150;
  const ease = (t: number) => 1 - Math.pow(1 - t, 3);
  const step = (now: number) => {
    const t = Math.min((now - start) / duration, 1);
    scroller.scrollTop = from + dist * ease(t);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
