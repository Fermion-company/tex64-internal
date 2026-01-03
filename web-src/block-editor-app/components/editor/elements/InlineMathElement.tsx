import { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { RenderElementProps, ReactEditor, useSlateStatic } from 'slate-react'
import { Transforms, Range } from 'slate'
import { SimpleMathField } from '@/components/editor/document/blocks/SimpleMathField'
import type { InlineMathElement as SlateInlineMath } from '@/types/slate'
import { nanoid } from 'nanoid'
import katex from 'katex'

// Overlay Component
interface MathOverlayProps {
  initialValue: string
  targetRef: React.RefObject<HTMLElement>
  onChange: (value: string) => void
  onClose: () => void
  onDelete: () => void
  inlineId: string
}

const MathOverlay = ({ initialValue, targetRef, onChange, onClose, onDelete, inlineId }: MathOverlayProps) => {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  // Ref to access the SimpleMathField internal instance if possible, 
  // currently SimpleMathField doesn't expose a ref to the mathfield element directly via forwardRef.
  // We need to find the math-field element in the DOM.
  
  // Update position based on target element
  const updatePosition = useCallback(() => {
    if (targetRef.current) {
      const rect = targetRef.current.getBoundingClientRect()
      setPosition({
        top: rect.top + window.scrollY,
        left: rect.left + window.scrollX,
      })
    }
  }, [targetRef])

  useLayoutEffect(() => {
    updatePosition()
    window.addEventListener('scroll', updatePosition, true)
    window.addEventListener('resize', updatePosition)
    
    // Focus logic: wait for render then focus the math-field
    const timer = setTimeout(() => {
       const mathField = overlayRef.current?.querySelector('math-field') as HTMLElement & { focus: (options?: FocusOptions) => void, executeCommand: (cmd: string) => void }
       if (mathField) {
         // Save scroll position before focus
         const scrollY = window.scrollY
         const scrollX = window.scrollX
         // Focus with preventScroll to avoid page jumping
         mathField.focus({ preventScroll: true })
         // Restore scroll position just in case
         window.scrollTo(scrollX, scrollY)
         // Move cursor to end instead of selectAll (allows normal keyboard input)
         if (mathField.executeCommand) {
            mathField.executeCommand('moveToMathfieldEnd')
         }
       }
    }, 50)

    return () => {
      window.removeEventListener('scroll', updatePosition, true)
      window.removeEventListener('resize', updatePosition)
      clearTimeout(timer)
    }
  }, [updatePosition])

  // Close on outside click is handled by the main component logic or transparent backdrop?
  // Let's use a transparent backdrop for simplicity and robustness
  
  if (!position) return null

  return createPortal(
    <>
      {/* Overlay Editor - No backdrop needed, document click handler in MathFieldContext will close */}
      <div
        ref={overlayRef}
        className="absolute z-50 shadow-lg rounded bg-white"
        style={{
          top: position.top,
          left: position.left,
          minWidth: '40px',
        }}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <SimpleMathField
          asInline
          instanceId={inlineId}
          value={initialValue}
          onChange={onChange}
          onDelete={onDelete}
          autoFocus={true} // Auto focus is safe here as it's outside Slate
          style={{ 
            minHeight: '20px',
            border: '1px solid #a855f7', // purple-500
            borderRadius: '4px',
            padding: '1px 2px',
            backgroundColor: 'white'
          }}
        />
      </div>
    </>,
    document.body
  )
}

export const InlineMathElement = ({ attributes, children, element }: RenderElementProps) => {
  const editor = useSlateStatic()
  const mathElement = element as SlateInlineMath
  const latex = mathElement.latex || ''
  const [fallbackId] = useState(() => nanoid())
  const inlineId = mathElement.id || fallbackId
  
  const [isEditing, setIsEditing] = useState(false)
  const katexRef = useRef<HTMLSpanElement>(null)
  
  // Store Slate selection before entering edit mode
  const savedSelectionRef = useRef<Range | null>(null)

  const handleUpdate = useCallback((newLatex: string) => {
    try {
      const path = ReactEditor.findPath(editor, mathElement)
      Transforms.setNodes(editor, { latex: newLatex } as Partial<SlateInlineMath>, { at: path })
    } catch {
      // Element may have been removed
    }
  }, [editor, mathElement])

  const handleDelete = useCallback(() => {
    try {
      const path = ReactEditor.findPath(editor, mathElement)
      Transforms.removeNodes(editor, { at: path })
      setIsEditing(false)
    } catch {
      // Element may have been removed
    }
  }, [editor, mathElement])

  // Enter edit mode
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    
    savedSelectionRef.current = editor.selection
    
    // Deselect Slate to clear visible selection
    // Transforms.deselect(editor) // <-- REMOVED: This causes scroll jumping on insert
    
    setIsEditing(true)
  }, [editor])

  // Close edit mode
  const closeEdit = useCallback(() => {
    setIsEditing(false)
    
    // Restore selection
    if (savedSelectionRef.current) {
      try {
        Transforms.select(editor, savedSelectionRef.current)
      } catch {
        // Fallback: don't select anything if invalid
      }
      savedSelectionRef.current = null
    }
  }, [editor])

  // Render KaTeX HTML
  const katexHtml = (() => {
    if (!latex) {
      return `<span style="color: #9ca3af; font-style: italic;">数式</span>`
    }
    try {
      return katex.renderToString(latex, {
        throwOnError: false,
        displayMode: false,
        output: 'html',
        macros: { "\\placeholder": "{\\color{#e2e8f0}\\boxed{\\phantom{x}}}" }
      })
    } catch {
      return `<span style="color: red;">Error</span>`
    }
  })()

  return (
    <span {...attributes} className="relative inline-block align-middle mx-0.5" style={{ verticalAlign: 'middle' }}>
      <span
        contentEditable={false}
        style={{ userSelect: 'none', verticalAlign: 'middle' }}
      >
        <span
          ref={katexRef}
          onMouseDown={handleClick}
          className={`inline-block rounded transition-colors border px-1 ${
             isEditing ? 'opacity-0' : 'cursor-pointer hover:bg-blue-50 border-slate-300'
          }`}
          style={{ verticalAlign: 'middle', minWidth: '10px', minHeight: '1em' }}
          dangerouslySetInnerHTML={{ __html: katexHtml }}
        />
      </span>

      {isEditing && (
         <MathOverlay 
            initialValue={latex}
            targetRef={katexRef}
            onChange={handleUpdate}
            onClose={closeEdit}
            onDelete={handleDelete}
            inlineId={inlineId}
         />
      )}
      
      {/* Required: Slate void elements must render children */}
      <span style={{ display: 'none' }}>{children}</span>
    </span>
  )
}
