import type { BlockInputRuntime } from "./runtime.js";

export const decorateTextareaAsMathfield = (runtime: BlockInputRuntime, textarea: HTMLTextAreaElement) => {
  const shimmed = textarea as HTMLTextAreaElement & {
    [runtime.TEXTAREA_MATHFIELD_SHIM]?: boolean;
    getValue?: (...args: unknown[]) => string;
    mode?: "math";
    position?: number;
    lastOffset?: number;
    selection?: unknown;
  };
  if (shimmed[runtime.TEXTAREA_MATHFIELD_SHIM]) {
    return;
  }
  Object.defineProperty(shimmed, runtime.TEXTAREA_MATHFIELD_SHIM, {
    value: true,
    configurable: false,
    writable: false,
    enumerable: false,
  });

  const clamp = (value: number) => {
    const length = textarea.value.length;
    if (!Number.isFinite(value)) {
      return length;
    }
    return Math.max(0, Math.min(length, Math.trunc(value)));
  };
  const readSelectionStart = () =>
    typeof textarea.selectionStart === "number" ? textarea.selectionStart : textarea.value.length;
  const readSelectionEnd = () =>
    typeof textarea.selectionEnd === "number" ? textarea.selectionEnd : textarea.value.length;
  const setSelection = (start: number, end: number) => {
    const safeStart = clamp(start);
    const safeEnd = clamp(end);
    textarea.setSelectionRange(safeStart, safeEnd);
  };

  if (typeof shimmed.getValue !== "function") {
    Object.defineProperty(shimmed, "getValue", {
      configurable: true,
      value: (...args: unknown[]) => {
        if (args.length === 1 && args[0] === "latex") {
          return textarea.value;
        }
        if (
          args.length >= 3 &&
          typeof args[0] === "number" &&
          typeof args[1] === "number" &&
          args[2] === "latex"
        ) {
          const start = clamp(args[0]);
          const end = clamp(args[1]);
          return textarea.value.slice(Math.min(start, end), Math.max(start, end));
        }
        return textarea.value;
      },
    });
  }

  Object.defineProperty(shimmed, "selection", {
    configurable: true,
    get: () => [readSelectionStart(), readSelectionEnd()],
    set: (value: unknown) => {
      if (Array.isArray(value) && value.length >= 2) {
        const start = Number(value[0]);
        const end = Number(value[1]);
        if (Number.isFinite(start) && Number.isFinite(end)) {
          setSelection(start, end);
        }
        return;
      }
      if (
        value &&
        typeof value === "object" &&
        "ranges" in value &&
        Array.isArray((value as { ranges?: unknown }).ranges)
      ) {
        const first = (value as { ranges: unknown[] }).ranges[0];
        if (Array.isArray(first) && first.length >= 2) {
          const start = Number(first[0]);
          const end = Number(first[1]);
          if (Number.isFinite(start) && Number.isFinite(end)) {
            setSelection(start, end);
          }
        }
      }
    },
  });

  Object.defineProperty(shimmed, "position", {
    configurable: true,
    get: () => readSelectionEnd(),
    set: (value: number) => {
      setSelection(value, value);
    },
  });

  Object.defineProperty(shimmed, "lastOffset", {
    configurable: true,
    get: () => textarea.value.length,
  });

  Object.defineProperty(shimmed, "mode", {
    configurable: true,
    get: () => "math",
    set: () => {
      // Keep textarea fallback in math mode for token detection consistency.
    },
  });
};

