"use client";

import { ChevronDown } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { NativePlatformState } from "@/lib/client/use-native-platform";
import { PaperFiles, type PaperFilesProps } from "./paper-files";
import { NativePlatformControls } from "./native-platform-controls";

export function NativePaperMenu({ layout, title, projectFiles, platform, building, onBuild, onUndo }: {
  layout: { stacked: boolean; customized: boolean; swap: () => void; rotate: () => void; reset: () => void };
  title: string;
  projectFiles: PaperFilesProps;
  platform: NativePlatformState;
  building: boolean;
  onBuild: () => void;
  onUndo?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = panel.current;
    const button = trigger.current;
    if (!open || !menu || !button) return;
    menu.showPopover();
    const place = () => {
      const anchor = button.getBoundingClientRect();
      const above = anchor.top - 10;
      const below = window.innerHeight - anchor.bottom - 10;
      const openAbove = below < menu.scrollHeight && above > below;
      menu.style.top = openAbove ? "auto" : `${anchor.bottom + 4}px`;
      menu.style.bottom = openAbove ? `${window.innerHeight - anchor.top + 4}px` : "auto";
      menu.style.left = `${Math.max(6, Math.min(anchor.left, window.innerWidth - menu.offsetWidth - 6))}px`;
      menu.style.maxHeight = `${Math.max(0, openAbove ? above : below)}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(menu);
    window.addEventListener("resize", place);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || root.current?.querySelector('[role="listbox"], [role="menu"]')) return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <div className="paper-options" ref={root} onBlur={event => {
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      <button ref={trigger} type="button" className="paper-options-trigger" aria-label={title + "の設定"} aria-expanded={open}
        onClick={() => setOpen(!open)}><span>{title}</span><ChevronDown size={14} /></button>
      {open && <div ref={panel} className="paper-options-panel" popover="manual">
        <PaperFiles {...projectFiles} />
        <NativePlatformControls platform={platform} />
        <button type="button" onClick={() => { layout.swap(); setOpen(false); trigger.current?.focus(); }}>
          {layout.stacked ? "上下を入れ替える" : "左右を入れ替える"}
        </button>
        <button type="button" onClick={() => { layout.rotate(); setOpen(false); trigger.current?.focus(); }}>
          {layout.stacked ? "左右に並べる" : "上下に並べる"}
        </button>
        {layout.customized && <button type="button" onClick={() => { layout.reset(); setOpen(false); trigger.current?.focus(); }}>標準の配置に戻す</button>}
        <button type="button" disabled={building} onClick={() => { setOpen(false); onBuild(); trigger.current?.focus(); }}>
          {building ? "紙面を更新中…" : "紙面を更新"}
        </button>
        {onUndo && <button type="button" onClick={() => { setOpen(false); onUndo(); trigger.current?.focus(); }}>直前の変更を戻す</button>}
      </div>}
    </div>
  );
}
