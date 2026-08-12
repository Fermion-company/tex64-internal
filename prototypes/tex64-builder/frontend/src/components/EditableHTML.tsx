import { useEffect, useRef } from 'react';

interface Props {
  html: string;
  className?: string;
  inline?: boolean;
  onCommit: (html: string) => void;
}

/**
 * 非制御のcontenteditable。外部から値が変わったとき(Undo等)だけDOMを同期し、
 * 入力中はキャレットを壊さない。確定はblur時に加え、入力停止(900ms)でも
 * 自動コミットする(裏側のTeXソース同期・バックグラウンド組版のため)。
 */
export function EditableHTML({ html, className, inline, onCommit }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ html, onCommit });
  latest.current = { html, onCommit };

  useEffect(() => {
    const el = ref.current;
    if (el && document.activeElement !== el && el.innerHTML !== html) {
      el.innerHTML = html;
    }
  }, [html]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const commit = () => {
    const el = ref.current;
    if (el && el.innerHTML !== latest.current.html) {
      latest.current.onCommit(el.innerHTML);
    }
  };

  return (
    <div
      ref={ref}
      className={className}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      data-editable="text"
      style={inline ? { display: 'inline' } : undefined}
      onInput={() => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(commit, 900);
      }}
      onBlur={() => {
        if (timer.current) clearTimeout(timer.current);
        commit();
      }}
    />
  );
}
