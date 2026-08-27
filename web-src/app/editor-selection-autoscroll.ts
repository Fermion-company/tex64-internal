type VerticalBounds = {
  top: number;
  bottom: number;
};

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

export const selectionAutoScrollVelocity = (
  pointerY: number,
  bounds: VerticalBounds,
  lineHeight: number
): number => {
  if (
    !Number.isFinite(pointerY) ||
    !Number.isFinite(bounds.top) ||
    !Number.isFinite(bounds.bottom) ||
    bounds.bottom <= bounds.top ||
    !Number.isFinite(lineHeight) ||
    lineHeight <= 0
  ) {
    return 0;
  }
  // Chromium cannot place the pointer below a maximized window. Start inside
  // the final line-and-a-half so selection still advances at the screen edge.
  const edge = clamp(lineHeight * 1.5, 24, 48);
  const topEdge = bounds.top + edge;
  const bottomEdge = bounds.bottom - edge;
  let direction = 0;
  let intensity = 0;
  if (pointerY < topEdge) {
    direction = -1;
    intensity = clamp((topEdge - pointerY) / edge, 0, 1);
  } else if (pointerY > bottomEdge) {
    direction = 1;
    intensity = clamp((pointerY - bottomEdge) / edge, 0, 1);
  }
  if (!direction || intensity <= 0) {
    return 0;
  }
  const linesPerSecond = 3 + 12 * intensity * intensity;
  return direction * lineHeight * linesPerSecond;
};

export const selectionAutoScrollDelta = (
  velocity: number,
  elapsedMs: number
): number => {
  if (!Number.isFinite(velocity) || !Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return 0;
  }
  return velocity * clamp(elapsedMs, 0, 50) / 1000;
};

export const attachSelectionDragAutoScroll = (
  monaco: any,
  editor: any,
  host: HTMLElement
): (() => void) => {
  let active = false;
  let pointerX = 0;
  let pointerY = 0;
  let frame: number | null = null;
  let previousFrameTime = 0;

  const stopFrame = () => {
    if (frame !== null) {
      window.cancelAnimationFrame(frame);
      frame = null;
    }
    previousFrameTime = 0;
  };

  const stop = () => {
    active = false;
    stopFrame();
  };

  const updateSelectionEnd = () => {
    const domNode = editor.getDomNode?.() as HTMLElement | null;
    const selection = editor.getSelection?.();
    if (!domNode || !selection || !editor.getTargetAtClientPoint || !monaco?.Selection) {
      return;
    }
    const rect = domNode.getBoundingClientRect();
    const layout = editor.getLayoutInfo?.() ?? {};
    const horizontalScrollbarHeight = Number(layout.horizontalScrollbarHeight) || 0;
    const contentLeft = rect.left + (Number(layout.contentLeft) || 0);
    const contentRight = contentLeft + (Number(layout.contentWidth) || rect.width);
    const target = editor.getTargetAtClientPoint(
      clamp(pointerX, contentLeft + 1, Math.max(contentLeft + 1, contentRight - 1)),
      clamp(pointerY, rect.top + 2, Math.max(rect.top + 2, rect.bottom - horizontalScrollbarHeight - 2))
    );
    const position = target?.position;
    if (!position) {
      return;
    }
    if (
      selection.positionLineNumber === position.lineNumber &&
      selection.positionColumn === position.column
    ) {
      return;
    }
    editor.setSelection?.(new monaco.Selection(
      selection.selectionStartLineNumber,
      selection.selectionStartColumn,
      position.lineNumber,
      position.column
    ));
  };

  const tick = (time: number) => {
    frame = null;
    if (!active) {
      return;
    }
    const domNode = editor.getDomNode?.() as HTMLElement | null;
    if (!domNode) {
      stop();
      return;
    }
    const rect = domNode.getBoundingClientRect();
    const lineHeight = Number(editor.getOption?.(monaco?.editor?.EditorOption?.lineHeight)) || 20;
    const velocity = selectionAutoScrollVelocity(pointerY, rect, lineHeight);
    if (velocity === 0) {
      previousFrameTime = 0;
      return;
    }
    const elapsed = previousFrameTime > 0 ? time - previousFrameTime : 1000 / 60;
    previousFrameTime = time;
    const scrollTop = Number(editor.getScrollTop?.()) || 0;
    editor.setScrollTop?.(
      scrollTop + selectionAutoScrollDelta(velocity, elapsed),
      monaco?.editor?.ScrollType?.Immediate
    );
    updateSelectionEnd();
    frame = window.requestAnimationFrame(tick);
  };

  const ensureFrame = () => {
    if (active && frame === null) {
      frame = window.requestAnimationFrame(tick);
    }
  };

  const onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) {
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest(".view-lines")) {
      return;
    }
    active = true;
    pointerX = event.clientX;
    pointerY = event.clientY;
    previousFrameTime = 0;
  };

  const onMouseMove = (event: MouseEvent) => {
    if (!active) {
      return;
    }
    if (event.buttons === 0) {
      stop();
      return;
    }
    pointerX = event.clientX;
    pointerY = event.clientY;
    ensureFrame();
  };

  host.addEventListener("mousedown", onMouseDown, true);
  window.addEventListener("mousemove", onMouseMove, true);
  window.addEventListener("mouseup", stop, true);
  window.addEventListener("blur", stop);

  const dispose = () => {
    stop();
    host.removeEventListener("mousedown", onMouseDown, true);
    window.removeEventListener("mousemove", onMouseMove, true);
    window.removeEventListener("mouseup", stop, true);
    window.removeEventListener("blur", stop);
  };
  editor.onDidDispose?.(dispose);
  return dispose;
};
