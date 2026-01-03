"use client"

import React from "react"
import { DiffEditor } from "@monaco-editor/react"
import { X } from "lucide-react"

type DiffViewerProps = {
  original: string
  modified: string
  onClose: () => void
  isOpen: boolean
}

const buildLineDiff = (beforeLines: string[], afterLines: string[]) => {
  const rows = beforeLines.length
  const cols = afterLines.length
  const table = Array.from({ length: rows + 1 }, () => Array(cols + 1).fill(0))
  for (let i = 1; i <= rows; i += 1) {
    for (let j = 1; j <= cols; j += 1) {
      if (beforeLines[i - 1] === afterLines[j - 1]) {
        table[i][j] = table[i - 1][j - 1] + 1
      } else {
        table[i][j] = Math.max(table[i - 1][j], table[i][j - 1])
      }
    }
  }
  const diff: Array<{ type: "add" | "del" | "same" }> = []
  let i = rows
  let j = cols
  while (i > 0 && j > 0) {
    if (beforeLines[i - 1] === afterLines[j - 1]) {
      diff.push({ type: "same" })
      i -= 1
      j -= 1
    } else if (table[i - 1][j] >= table[i][j - 1]) {
      diff.push({ type: "del" })
      i -= 1
    } else {
      diff.push({ type: "add" })
      j -= 1
    }
  }
  while (i > 0) {
    diff.push({ type: "del" })
    i -= 1
  }
  while (j > 0) {
    diff.push({ type: "add" })
    j -= 1
  }
  return diff.reverse()
}

const getDiffCounts = (before: string, after: string) => {
  const beforeText = before.trimEnd()
  const afterText = after.trimEnd()
  const beforeLines = beforeText.length ? beforeText.split(/\r?\n/) : [""]
  const afterLines = afterText.length ? afterText.split(/\r?\n/) : [""]
  const diffLines = buildLineDiff(beforeLines, afterLines)
  let adds = 0
  let dels = 0
  diffLines.forEach((entry) => {
    if (entry.type === "add") {
      adds += 1
    } else if (entry.type === "del") {
      dels += 1
    }
  })
  return { adds, dels }
}

export function DiffViewer({ original, modified, onClose, isOpen }: DiffViewerProps) {
  if (!isOpen) return null

  const { adds, dels } = getDiffCounts(original, modified)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-6">
      <div className="w-full max-w-5xl bg-slate-900 rounded-xl shadow-2xl flex flex-col overflow-hidden border border-white/10">
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/10 bg-slate-900">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-slate-100">変更内容の確認</h2>
            <div className="flex items-center gap-2 text-[11px] text-slate-400">
              {adds === 0 && dels === 0 ? (
                <span>変更なし</span>
              ) : (
                <>
                  <span className="rounded-full bg-emerald-500/20 text-emerald-300 px-2 py-0.5 font-semibold">
                    +{adds}
                  </span>
                  <span className="rounded-full bg-rose-500/20 text-rose-300 px-2 py-0.5 font-semibold">
                    -{dels}
                  </span>
                </>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-white/10 rounded-md transition-colors text-slate-300 hover:text-white"
            title="閉じる"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="modal-body" style={{ padding: 0 }}>
          <div style={{ height: 400, background: "#1e1e1e" }}>
            <DiffEditor
              original={original}
              modified={modified}
              language="latex"
              theme="vs-dark"
              options={{
                readOnly: true,
                renderSideBySide: false,
                renderIndicators: true,
                renderMarginRevertIcon: false,
                diffWordWrap: "on",
                wordWrap: "on",
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                fontSize: 13,
                fontFamily: "Menlo, Monaco, 'Courier New', monospace",
                padding: { top: 16, bottom: 16 },
              }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
