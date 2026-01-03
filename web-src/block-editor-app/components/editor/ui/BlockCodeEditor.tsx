"use client"

import React, { useState, useEffect, useRef } from "react"
import { SimpleMathField } from "../document/blocks/SimpleMathField"
import katex from "katex"
import { Eye, Code, Columns, SplitSquareHorizontal, Check, X } from "lucide-react"

interface BlockCodeEditorProps {
  value: string
  onChange: (value: string) => void
  onClose?: () => void
  onSave?: () => void // Optional explicitly if we want a save button
  variant?: "inline" | "block"
}

export function BlockCodeEditor({ value, onChange, onClose, onSave, variant = "block" }: BlockCodeEditorProps) {
  // Mode: "split" (Code + Preview), "code" (Only Code), "preview" (Only Preview)
  // For inline, default might be compact split or tabs? Let's try split for now.
  const [viewMode, setViewMode] = useState<"split" | "code">("split")
  
  // Create a local state for the value to avoid jitter if controlled heavily, 
  // though we probably want to propagate changes immediately if it's a "live" feel.
  // But for a "Modal/Popover" feel, maybe local state is better?
  // The user request said "code editing UI unified", implies we are editing the code.
  // Let's propagate immediately for now so the main editor (if visible) updates, 
  // but this component itself shows the preview.
  
  const [localValue, setLocalValue] = useState(value)
  
  useEffect(() => {
    setLocalValue(value)
  }, [value])

  const handleChange = (newVal: string) => {
    setLocalValue(newVal)
    onChange(newVal)
  }

  // Render Preview
  const previewHtml = React.useMemo(() => {
    try {
      return katex.renderToString(localValue || "\\phantom{empty}", {
        throwOnError: false,
        displayMode: variant === "block",
        output: "html",
         macros: { "\\placeholder": "{\\color{#e2e8f0}\\boxed{\\phantom{x}}}" }
      })
    } catch {
      return `<span style="color: red;">Error</span>`
    }
  }, [localValue, variant])

  const isInline = variant === "inline"

  return (
    <div className={`flex flex-col bg-white border border-slate-200 rounded-lg shadow-xl overflow-hidden ${isInline ? "w-[300px] sm:w-[500px]" : "w-full h-full min-h-[300px]"}`}>
      
      {/* Header / Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 bg-slate-50 border-b border-slate-100">
        <div className="flex items-center gap-2">
           <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
             {isInline ? "Inline Math" : "Math Block"}
           </span>
        </div>
        
        <div className="flex items-center gap-1">
           {/* View Mode Toggles */}
           <button 
             onClick={() => setViewMode("split")}
             className={`p-1 rounded hover:bg-slate-200 ${viewMode === "split" ? "text-indigo-600 bg-indigo-50" : "text-slate-400"}`}
             title="Split View"
           >
             <Columns className="w-4 h-4" />
           </button>
           <button 
             onClick={() => setViewMode("code")}
             className={`p-1 rounded hover:bg-slate-200 ${viewMode === "code" ? "text-indigo-600 bg-indigo-50" : "text-slate-400"}`}
             title="Code Only"
           >
             <Code className="w-4 h-4" />
           </button>
        </div>
      </div>

      {/* Content Area */}
      <div className={`flex flex-1 min-h-0 ${viewMode === "split" ? (isInline ? "flex-col" : "flex-row") : "flex-col"}`}>
        
        {/* Code Editor Side */}
        <div className={`flex-1 flex flex-col min-h-0 ${viewMode === "split" && !isInline ? "border-r border-slate-100" : ""}`}>
           <div className="flex-1 relative">
             {/* We can use SimpleMathField for now as it provides syntax highlighting and math-aware editing.
                 Or we could use a plain textarea if the user strictly wants "Code" difference.
                 SimpleMathField *is* a code editor if configured correctly (it edits LaTeX). 
                 But the prompts say "MathLive block insertion... code edit diff display".
                 Maybe they want to see the Raw Source?
                 MathLive's SimpleMathField is actually a WYSIWYG editor that *generates* LaTeX.
                 If checking "diff", maybe we need a raw textarea.
                 Let's provide a raw textarea for "Code" view to ensure full control,
                 or maybe a switch?
                 Let's stick to a clean Textarea for "Source" as it's the most robust "Code" view.
              */}
              <textarea
                className="w-full h-full p-3 font-mono text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500/20 bg-slate-50/30"
                value={localValue}
                onChange={(e) => handleChange(e.target.value)}
                placeholder="Type LaTeX code here..."
                autoFocus
                spellCheck={false}
              />
           </div>
        </div>

        {/* Preview Side */}
        {(viewMode === "split") && (
           <div className={`flex-1 bg-white flex flex-col min-h-0 relative ${isInline ? "border-t border-slate-100 h-24" : "bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] [background-size:16px_16px]"}`}>
              <div className="absolute inset-0 overflow-auto flex items-center justify-center p-4">
                 <div 
                   className="text-lg text-slate-800"
                   dangerouslySetInnerHTML={{ __html: previewHtml }} 
                 />
              </div>
              {!isInline && (
                <div className="absolute top-2 right-2 text-xs text-slate-400 px-2 py-1 bg-white/80 rounded border border-slate-100">
                  Preview
                </div>
              )}
           </div>
        )}
      </div>
      
      {/* Footer (for inline mainly, or explicit save) */}
      <div className="p-2 border-t border-slate-100 bg-slate-50 flex justify-end gap-2">
         {onClose && (
           <button
             onClick={onClose}
             className="px-3 py-1 text-sm text-slate-600 hover:text-slate-800 hover:bg-slate-200 rounded transition-colors"
           >
             Cancel
           </button>
         )}
         <button
            onClick={() => {
              if (onSave) onSave()
              else if (onClose) onClose()
            }}
            className="px-3 py-1 text-sm bg-indigo-600 text-white hover:bg-indigo-700 rounded shadow-sm flex items-center gap-1 transition-colors"
         >
           <Check className="w-3.5 h-3.5" />
           Done
         </button>
      </div>

    </div>
  )
}
