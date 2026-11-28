"use client";

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { getNativeHost, hostMessageBody } from "./native-host";

type Layout = { stacked: boolean; reversed: boolean; share: number };
const initial: Layout = { stacked: false, reversed: false, share: 32 };
const min = 24;
const max = 68;
const clamp = (value: number) => Math.min(max, Math.max(min, Math.round(value)));

export function usePaperLayout(native: boolean) {
  const [layout, setLayout] = useState(initial);
  const gesture = useRef<{ id: number; start: Layout; share: number } | null>(null);

  useEffect(() => {
    if (!native) return;
    const host = getNativeHost();
    const dispose = host?.onMessage(message => {
      if (message.type !== "paper:layout") return;
      const saved = hostMessageBody(message);
      if (typeof saved.share === "number" && Number.isFinite(saved.share)) {
        setLayout({ share: clamp(saved.share), stacked: saved.stacked === true, reversed: saved.reversed === true });
      }
    });
    host?.send("paper:layout:get", {});
    return dispose;
  }, [native]);

  function commit(next: Layout) {
    setLayout(next);
    getNativeHost()?.send("paper:layout:set", next);
  }
  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!event.isPrimary || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { id: event.pointerId, start: layout, share: layout.share };
  }
  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const drag = gesture.current;
    const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!drag || drag.id !== event.pointerId || !bounds) return;
    const fraction = drag.start.stacked ? (event.clientY - bounds.top) / bounds.height : (event.clientX - bounds.left) / bounds.width;
    drag.share = clamp((drag.start.reversed ? 1 - fraction : fraction) * 100);
    setLayout({ ...drag.start, share: drag.share });
  }
  function pointerEnd(event: PointerEvent<HTMLDivElement>) {
    const drag = gesture.current;
    if (!drag || drag.id !== event.pointerId) return;
    gesture.current = null;
    commit({ ...drag.start, share: drag.share });
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    const direction = layout.reversed ? -1 : 1;
    const step = event.shiftKey ? 10 : 2;
    let next: number;
    if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    else if (event.key === (layout.stacked ? "ArrowDown" : "ArrowRight")) next = layout.share + direction * step;
    else if (event.key === (layout.stacked ? "ArrowUp" : "ArrowLeft")) next = layout.share - direction * step;
    else return;
    event.preventDefault();
    commit({ ...layout, share: clamp(next) });
  }
  return {
    stacked: layout.stacked, reversed: layout.reversed,
    style: { "--instruction-share": layout.share + "%" } as CSSProperties,
    swap: () => commit({ ...layout, reversed: !layout.reversed }),
    rotate: () => commit({ ...layout, stacked: !layout.stacked }),
    reset: () => commit(initial),
    customized: layout.share !== initial.share || layout.stacked || layout.reversed,
    separator: {
      role: "separator", tabIndex: 0,
      "aria-label": "編集指示とPDFの境界", "aria-controls": "instruction-pane",
      "aria-orientation": layout.stacked ? "horizontal" as const : "vertical" as const,
      "aria-valuemin": min, "aria-valuemax": max, "aria-valuenow": layout.share,
      "aria-valuetext": "編集指示 " + layout.share + "%",
      onPointerDown: pointerDown, onPointerMove: pointerMove, onPointerUp: pointerEnd,
      onLostPointerCapture: pointerEnd, onKeyDown: keyDown,
    },
  };
}
