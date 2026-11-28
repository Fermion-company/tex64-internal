"use client";

import { useMemo, useState } from "react";
import styles from "./paper-files.module.css";

export type PaperFilesProps = { files: string[]; folders: string[]; mainFile: string };

type Folder = { folders: Map<string, Folder>; files: string[] };
const folder = (): Folder => ({ folders: new Map(), files: [] });
const byName = new Intl.Collator("ja", { numeric: true }).compare;

function buildFolders(files: string[], folders: string[]) {
  const root = folder();
  const branch = (segments: string[]): Folder => {
    let current = root;
    for (const name of segments) {
      let next = current.folders.get(name);
      if (!next) { next = folder(); current.folders.set(name, next); }
      current = next;
    }
    return current;
  };
  for (const path of folders) branch(path.split("/"));
  for (const path of files) {
    const segments = path.split("/");
    const name = segments.pop();
    if (name) branch(segments).files.push(name);
  }
  return root;
}

function FolderItems({ node, prefix, mainFile }: { node: Folder; prefix: string; mainFile: string }) {
  return <ul className={styles.items}>
    {Array.from(node.folders.keys()).sort(byName).map(name => {
      const path = prefix + name;
      return <li key={path}><details open={mainFile.startsWith(path + "/") || undefined}>
        <summary>{name}</summary>
        <FolderItems node={node.folders.get(name)!} prefix={path + "/"} mainFile={mainFile} />
      </details></li>;
    })}
    {node.files.slice().sort(byName).map(name => {
      const path = prefix + name;
      return <li key={path} className={styles.file} title={path} aria-current={path === mainFile ? "true" : undefined}>{name}</li>;
    })}
    {!node.folders.size && !node.files.length && <li className={styles.empty}>空のフォルダ</li>}
  </ul>;
}

export function PaperFiles({ mainFile, files, folders }: PaperFilesProps) {
  const [open, setOpen] = useState(false);
  const tree = useMemo(() => open ? buildFolders(files, folders) : null, [open, files, folders]);
  return <details className={styles.section} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>プロジェクトのファイル</summary>
    {tree && <div className={styles.contents}>
      <p className={styles.target}><span>組版する原稿</span><strong>{mainFile}</strong></p>
      <FolderItems node={tree} prefix="" mainFile={mainFile} />
    </div>}
  </details>;
}
