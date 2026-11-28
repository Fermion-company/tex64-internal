// IME composition state of an editor group (group.isComposing), which the
// editing helpers, the editor's key capture and the outside-edit queue wait on.
//
// The editor's own events drive it. With EditContext (on by default in the
// vendored Monaco and supported by Electron's Chromium) the browser fires
// composition events at the EditContext object, not at any DOM element, so
// listeners on the editor host never heard a composition and isComposing
// stayed false during Japanese input. Monaco raises onDidCompositionStart/End
// in both input modes.
//
// The host's DOM composition events still matter when the editor runs on its
// textarea (EditContext off or unsupported): they carry the composed text,
// which `recover` re-inserts when a composition ends without committing it.
//
// A model replaced under a composition (a forced swap: the folder changed, the
// file went away; opening a file waits for the composition) or the editor
// disposed ends it there, with the old model still attached: the composed
// text belongs to that model and is never committed into the new one, and
// what waited for the composition is answered without running (onCancel). On
// the textarea the browser's composition outlived the swap, holding Tab,
// Enter, saves and outside changes back until the next blur.

import { editorKeyCapture } from "./completion-context.js";

type CompositionGroup = {
  isComposing: boolean;
  compositionText: string;
  composingFilePath: string | null;
  currentFilePath: string | null;
};

type CompositionEditor = {
  onDidCompositionStart?: (listener: () => void) => unknown;
  onDidCompositionEnd?: (listener: () => void) => unknown;
  onDidBlurEditorText?: (listener: () => void) => unknown;
  onWillChangeModel?: (listener: () => void) => unknown;
  onDidChangeModel?: (listener: () => void) => unknown;
  onDidDispose?: (listener: () => void) => unknown;
};

type EventHost = {
  addEventListener: (type: string, listener: (event: Event) => void, capture?: boolean) => void;
};

const compositionData = (event: Event): string => (event as CompositionEvent).data || "";

export const trackComposition = (
  editor: CompositionEditor,
  host: EventHost,
  group: CompositionGroup,
  hooks: { onStart?: () => void; onEnd: () => void; onCancel?: () => void; recover: (text: string) => void }
): void => {
  // True while the host is seeing DOM composition events (textarea input),
  // and the element they come from.
  let domComposition = false;
  let domTarget: EventTarget | null = null;

  const begin = () => {
    if (group.isComposing) {
      return;
    }
    group.isComposing = true;
    group.compositionText = "";
    group.composingFilePath = group.currentFilePath;
    hooks.onStart?.();
  };

  const finish = () => {
    if (!group.isComposing) {
      return;
    }
    group.isComposing = false;
    if (!domComposition) {
      group.compositionText = "";
      group.composingFilePath = null;
    }
    hooks.onEnd();
  };

  const cancel = () => {
    const composing = group.isComposing;
    const target = domComposition ? domTarget : null;
    domComposition = false;
    domTarget = null;
    group.isComposing = false;
    group.compositionText = "";
    group.composingFilePath = null;
    if (!composing) {
      return;
    }
    // The textarea keeps its composition across a swap: blurring it ends the
    // composition now, into the model being replaced.
    (target as HTMLElement | null)?.blur?.();
    hooks.onCancel?.();
  };

  editor.onDidCompositionStart?.(begin);
  editor.onDidCompositionEnd?.(finish);
  // A composition cannot outlive the editor's focus; never leave the flag set
  // (it holds Tab, Enter and outside edits back) if an end went missing.
  editor.onDidBlurEditorText?.(finish);
  editor.onWillChangeModel?.(cancel);
  editor.onDidChangeModel?.(cancel);
  editor.onDidDispose?.(cancel);

  // Textarea input: monaco's own listener on the textarea runs first, so these
  // follow the editor events; the end handler still has the composed text.
  host.addEventListener("compositionstart", (event) => {
    domComposition = true;
    domTarget = event.target;
    begin();
  });
  host.addEventListener("compositionupdate", (event) => {
    group.compositionText = compositionData(event);
  });
  host.addEventListener("compositionend", (event) => {
    if (!compositionData(event) && group.compositionText && group.composingFilePath === group.currentFilePath) {
      hooks.recover(group.compositionText);
    }
    domComposition = false;
    domTarget = null;
    group.compositionText = "";
    group.composingFilePath = null;
    finish();
  });
};

// Keys the editor host handles before monaco (capture phase): Tab accepts a
// suggestion, and nothing accepts, closes or breaks a line while a composition
// is open (editorKeyCapture).
export const attachEditorKeyCapture = (
  editor: { trigger?: (source: string, handlerId: string, payload: unknown) => void },
  host: EventHost,
  group: { isComposing: boolean },
  isSuggestVisible: () => boolean
): void => {
  host.addEventListener(
    "keydown",
    (raw) => {
      const event = raw as KeyboardEvent;
      const action = editorKeyCapture(event, {
        suggestVisible: event.key === "Tab" && isSuggestVisible(),
        composing: group.isComposing,
      });
      if (!action) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (action !== "swallow") {
        editor.trigger?.("tex64", action, {});
      }
    },
    true
  );
};
