// A short message under the toolbar control the user just used: what the
// click did, or why it could not. The Issues panel is often closed, so a
// result reported only there reads as "nothing happened".

export type EditorNoticeTone = "info" | "error";

export type EditorNoticeOptions = {
  tone?: EditorNoticeTone;
  action?: { label: string; run: () => void };
  durationMs?: number;
};

let current: { element: HTMLElement; timer: number | null } | null = null;

export const hideEditorNotice = () => {
  if (!current) return;
  if (current.timer !== null) window.clearTimeout(current.timer);
  current.element.remove();
  current = null;
};

// Returns a dismiss that only removes this notice, not a later one.
export const showEditorNotice = (
  anchor: HTMLElement | null,
  message: string,
  options: EditorNoticeOptions = {},
): (() => void) => {
  hideEditorNotice();
  const tone = options.tone ?? "info";
  const element = document.createElement("div");
  element.className = `editor-notice is-${tone}`;
  element.setAttribute("role", tone === "error" ? "alert" : "status");
  const text = document.createElement("span");
  text.className = "editor-notice-text";
  text.textContent = message;
  element.appendChild(text);
  if (options.action) {
    const { label, run } = options.action;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "editor-notice-action";
    button.textContent = label;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      hideEditorNotice();
      run();
    });
    element.appendChild(button);
  }
  element.addEventListener("click", () => hideEditorNotice());
  document.body.appendChild(element);
  // Right-align under the anchor; the toolbar sits at the window's top right.
  const rect = anchor?.getBoundingClientRect();
  if (rect && rect.width > 0) {
    const width = element.offsetWidth;
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    element.style.left = `${left}px`;
    element.style.top = `${rect.bottom + 6}px`;
  } else {
    element.style.right = "16px";
    element.style.top = "52px";
  }
  const durationMs = options.durationMs ?? (tone === "error" || options.action ? 7000 : 4000);
  const entry = { element, timer: null as number | null };
  entry.timer = window.setTimeout(() => {
    if (current === entry) hideEditorNotice();
  }, durationMs);
  current = entry;
  return () => {
    if (current === entry) hideEditorNotice();
  };
};
