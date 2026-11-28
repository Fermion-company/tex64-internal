"use client";

import { useEffect, useMemo, useState } from "react";
import { getNativeHost, requestFromHost } from "@/lib/client/native-host";
import { workspaceRequestFields, type NativeWorkspaceIdentity } from "@/lib/client/workspace-identity";
import type { PdfOutlineEntry } from "./pdf-preview";
import styles from "./paper-outline.module.css";

export interface PaperHeading {
  title: string;
  path?: string;
  line?: number;
  level: number;
  page: number;
  y: number;
}
type Branch = PaperHeading & { children: Branch[] };
export const paperHeadingKey = (heading: PaperHeading) => JSON.stringify([heading.page, heading.y, heading.title]);

function outlineTree(entries: PaperHeading[]): Branch[] {
  const roots: Branch[] = [];
  const stack: Branch[] = [];
  for (const heading of entries) {
    const node: Branch = { ...heading, children: [] };
    while (stack.length && stack.at(-1)!.level >= node.level) stack.pop();
    (stack.at(-1)?.children ?? roots).push(node);
    stack.push(node);
  }
  return roots;
}

export function PaperOutline({ identity, mainFile, pdfPath, revision, pageReady, bookmarks, selected, onHeadings, onChoose }: {
  identity: NativeWorkspaceIdentity;
  mainFile: string;
  pdfPath: string;
  revision: string;
  pageReady: boolean;
  bookmarks: PdfOutlineEntry[];
  selected?: string;
  onHeadings?: (snapshot: { revision: string; headings: PaperHeading[] }) => void;
  onChoose: (heading: PaperHeading, uniqueInDocument: boolean) => void;
}) {
  const [sources, setSources] = useState<{ revision: string; headings: PaperHeading[] }>({ revision: "", headings: [] });
  const sourcesMatch = sources.revision === revision;
  const headings = useMemo(() => {
    if (!bookmarks.length) return sources.headings;
    const normalized = (title: string) => title.normalize().trim().replace(/\s+/g, " ");
    return bookmarks.map((item) => {
      const matches = sources.headings.filter((source) => sourcesMatch && source.page === item.page &&
        normalized(source.title) === normalized(item.title) && Math.abs(source.y - item.y) < 48);
      const source = matches.length === 1 ? matches[0] : undefined;
      return { ...item, path: source?.path, line: source?.line };
    });
  }, [bookmarks, sourcesMatch, sources.headings]);
  const roots = useMemo(() => outlineTree(headings), [headings]);
  useEffect(() => {
    if (pageReady && sourcesMatch) onHeadings?.({ revision, headings });
  }, [headings, onHeadings, pageReady, revision, sourcesMatch]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    const host = getNativeHost();
    if (!host || !pageReady) return;
    let current = true;
    void requestFromHost(host, {
      type: "paper:outline:get", resultType: "paper:outline:result",
      payload: { documentMainFile: mainFile, pdfPath, ...workspaceRequestFields(identity) },
    }).then((reply) => {
      if (current && Array.isArray(reply.headings)) {
        setSources({ revision, headings: reply.headings.filter((heading): heading is PaperHeading =>
          heading && typeof heading.title === "string" && typeof heading.path === "string" &&
          Number.isInteger(heading.line) && Number.isInteger(heading.level) &&
          Number.isInteger(heading.page) && Number.isFinite(heading.y)) });
      }
    }).catch(() => {
      if (current) setSources({ revision, headings: [] });
    });
    return () => { current = false; };
  }, [identity, mainFile, pdfPath, revision, pageReady]);

  if (!roots.length) return null;
  const rows = (branches: Branch[]) => <ul>{branches.map((node) => {
    const key = paperHeadingKey(node);
    const open = expanded.has(key);
    return <li key={key}>
      <div className={styles.row}>
        {node.children.length > 0 && <button type="button" className={styles.disclosure}
          aria-label={`${node.title}の下位見出し`} aria-expanded={open}
          onClick={() => setExpanded((previous) => {
            const next = new Set(previous);
            if (next.has(key)) next.delete(key); else next.add(key);
            return next;
          })}><svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m4.5 2.5 3.5 3.5-3.5 3.5" stroke="currentColor" strokeWidth="1.4" /></svg></button>}
        <button type="button" className={styles.heading} disabled={!pageReady || (!bookmarks.length && !sourcesMatch)} aria-current={selected === key ? "location" : undefined}
          onClick={() => {
            const candidates = headings.filter(heading => heading.title === node.title && heading.level === node.level &&
              (!node.path || !heading.path || node.path === heading.path));
            onChoose(node, candidates.length === 1);
          }}>{node.title}</button>
      </div>
      {open && rows(node.children)}
    </li>;
  })}</ul>;
  return <nav className={styles.outline} aria-label="原稿の目次"><h2>目次</h2>{rows(roots)}</nav>;
}
