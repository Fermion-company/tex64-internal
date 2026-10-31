// Remote cursors and selections: y-monaco decorates them with per-client
// classes (yRemoteSelection-<id>, yRemoteSelectionHead-<id>); this writes the
// matching colour rules and the small name label above the caret.

const STYLE_ID = "collab-cursor-styles";
const known = new Map<number, { color: string; name: string }>();

const cssString = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");

const render = () => {
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.append(style);
  }
  const rules: string[] = [];
  for (const [clientId, { color, name }] of known) {
    rules.push(
      `.yRemoteSelection-${clientId}{background-color:${color}2e;}`,
      `.yRemoteSelectionHead-${clientId}{position:absolute;border-left:2px solid ${color};border-top:2px solid ${color};height:100%;box-sizing:border-box;}`,
      `.yRemoteSelectionHead-${clientId}::after{content:"${cssString(name)}";position:absolute;top:-1.15em;left:-2px;padding:0 4px;font-size:10px;line-height:1.15em;font-family:var(--font-ui, system-ui);background:${color};color:#fff;white-space:nowrap;border-radius:3px 3px 3px 0;opacity:0;transition:opacity .15s;pointer-events:none;z-index:5;}`,
      `.yRemoteSelectionHead-${clientId}:hover::after,.collab-labels-visible .yRemoteSelectionHead-${clientId}::after{opacity:.92;}`,
    );
  }
  style.textContent = rules.join("\n");
};

// Names show while a remote caret moves and on hover, not permanently (a
// permanent label hides the line above).
let labelTimer: number | null = null;
const flashLabels = () => {
  document.body.classList.add("collab-labels-visible");
  if (labelTimer !== null) window.clearTimeout(labelTimer);
  labelTimer = window.setTimeout(() => document.body.classList.remove("collab-labels-visible"), 1500);
};

export const collabCursors = {
  // Feed the awareness states of one doc; clients seen anywhere keep a rule.
  observe: (states: Map<number, { user?: { name?: string; color?: string } }>, selfClientId: number, remote = true) => {
    let changed = false;
    states.forEach((state, clientId) => {
      if (clientId === selfClientId || !state?.user) return;
      const name = String(state.user.name || "").slice(0, 40) || "?";
      const color = /^#[0-9a-fA-F]{6}$/.test(String(state.user.color || "")) ? String(state.user.color) : "#2563eb";
      const previous = known.get(clientId);
      if (!previous || previous.name !== name || previous.color !== color) {
        known.set(clientId, { name, color });
        changed = true;
      }
    });
    if (changed) render();
    if (remote) flashLabels();
  },
  reset: () => {
    known.clear();
    render();
  },
};
