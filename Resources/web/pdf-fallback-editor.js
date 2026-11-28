// The PDF.js viewer uses the same MathLive field and keyboard controller as the AI paper.
let loadPromise;
function loadMath() {
  if (!loadPromise) loadPromise = (async () => {
    if (!customElements.get("math-field")) await import("./mathlive/mathlive.min.js");
    await import("./math/wysiwyg/native-editor.js");
    MathfieldElement.fontsDirectory = new URL("./mathlive/fonts", import.meta.url).href;
    MathfieldElement.soundsDirectory = null;
  })().catch(error => { loadPromise = null; throw error; });
  return loadPromise;
}

function clickedCharacter(event) {
  const spans = document.elementsFromPoint(event.clientX, event.clientY)
    .filter(el => el.matches(".textLayer span") && el.textContent.trim());
  const range = document.createRange();
  for (const span of spans) {
    const walk = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
    for (let node; (node = walk.nextNode());) {
      let i = 0;
      for (const glyph of node.textContent) {
        range.setStart(node, i);
        i += glyph.length;
        range.setEnd(node, i);
        const rect = range.getBoundingClientRect();
        if (glyph.trim() && event.clientX >= rect.left && event.clientX <= rect.right &&
            event.clientY >= rect.top && event.clientY <= rect.bottom) {
          const after = event.clientX >= (rect.left + rect.right) / 2 - 0.5;
          const raw = node.textContent, before = raw.slice(0, after ? i : i - glyph.length);
          range.selectNodeContents(node);
          return { node, index: i - glyph.length, glyphRect: rect, glyph: glyph.normalize("NFKC"), after, printed: raw.trim().replace(/\s+/gu, " "),
            offset: before.trimStart().replace(/\s+/gu, " ").length, rect: range.getBoundingClientRect(),
            font: getComputedStyle(span).fontFamily, horizontal: (span.dir || "ltr") === "ltr" };
        }
      }
    }
  }
  return null;
}

// Only a repeated source match needs a page-wide measurement. Use actual
// character ranges so two occurrences in the same PDF.js span stay distinct.
function repeatedInk(page, clicked, pointAt) {
  const points = [], text = clicked.printed;
  if (!text) return points;
  const layer = page.querySelector(".textLayer");
  if (!layer) return points;
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node; (node = walker.nextNode());) {
    const run = node.textContent;
    for (let i = run.indexOf(text); i >= 0; i = run.indexOf(text, i + text.length)) {
      if (points.length === 256) return [];
      range.setStart(node, i);
      range.setEnd(node, i + text.length);
      const rect = range.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const point = pointAt({ target: node.parentElement, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 });
      if (point) points.push({ x: point.x, y: point.y, selected: node === clicked.node && clicked.index >= i && clicked.index < i + text.length });
    }
  }
  return points;
}

// The aligned/gathered container exists only inside MathLive. Preserve the
// user's row breaks, indentation and unchanged cells when editing one cell.
function alignmentCells(latex) {
  let start = 0;
  const cells = [];
  for (const token of latex.matchAll(/\\(?:[A-Za-z@]+|[\s\S])|&/g)) {
    if (token[0] !== "&" && token[0] !== "\\\\") continue;
    cells.push(latex.slice(start, token.index), token[0]);
    start = token.index + token[0].length;
  }
  cells.push(latex.slice(start));
  return cells;
}

// Map glyphs, including atoms nested in a fraction or matrix, to the
// outer MathLive alignment cell that owns them.
function alignedGlyphs(atoms, ink) {
  const leaves = atoms.filter(atom => atom.symbol);
  if (!ink) return { leaves };
  const outer = atoms.reduce((best, atom) => atom.array && (!best || atom.depth < best.depth) ? atom : best, null);
  if (!outer || outer.array.rows !== ink.count) return { leaves };
  const cell = ink.cell?.count === outer.array.columns ? ink.cell : null;
  const branches = new Map();
  function branchOf(atom) {
    if (!atom || !Number.isInteger(atom.parentOffset) || atom.parentOffset < 0) return null;
    if (atom.parentOffset === outer.offset) return atom.parentBranch;
    if (!branches.has(atom.parentOffset)) branches.set(atom.parentOffset, branchOf(atoms[atom.parentOffset]));
    return branches.get(atom.parentOffset);
  }
  return { leaves: leaves.filter(atom => {
    const branch = branchOf(atom);
    return Array.isArray(branch) && branch[0] === ink.index && (!cell || branch[1] === cell.index);
  }), box: cell?.box ?? ink.box };
}

export function fallbackPaperEditor({ bridge, pages, scroll, pointAt, currentPaper, typeAt, emptyTextRect }) {
  let sequence = 0, active = null, resolving = Promise.resolve();
  const request = (payload) => {
    if (bridge?.fallbackMath) return bridge.fallbackMath(payload);
    const channel = new MessageChannel();
    return new Promise(resolve => {
      const finish = value => { channel.port1.close(); clearTimeout(timer); resolve(value); };
      const timer = setTimeout(() => finish(null), 8000);
      channel.port1.onmessage = event => finish(event.data);
      window.parent.postMessage({ source: "tex64-pdf", payload: { type: "fallback-math", payload } }, "*", [channel.port2]);
    });
  };
  let emptyCaret = null, filledGeneration = null, viewSequence = 0;
  const view = (displayed, loading) => {
    const id = ++viewSequence;
    if (emptyCaret?.generation !== displayed) emptyCaret = null;
    if (displayed !== filledGeneration) filledGeneration = null;
    void request({ action: "view", displayed, loading }).then(result => {
      if (id === viewSequence) emptyCaret = result?.emptyCaret ? { generation: displayed, point: result.emptyCaret } : null;
    }).catch(() => {});
  };
  const send = (sessionId, value, finish, cancel) =>
    request({ action: "edit", sessionId, value, finish, cancel }).catch(() => null);
  const close = (cancel = false) => {
    sequence++;
    const edit = active;
    if (!edit) return;
    active = null;
    edit.cancelled = cancel;
    if (cancel && edit.emptyGeneration === filledGeneration) filledGeneration = null;
    edit.endComposition?.();
    const value = edit.read();
    edit.dispose?.();
    edit.shell.remove();
    if (edit.sessionId) void send(edit.sessionId, value, true, cancel);
  };
  const position = () => {
    if (!active) return;
    const page = pages.querySelector(`[data-page-number="${active.page}"]`);
    // PDF.js temporarily empties the page host when replacing a PDF.
    // Hiding the focused input here cancels native composition and drops
    // subsequent keystrokes. Keep it at its last painted position.
    if (!page) return;
    const rect = page.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    if (active.textBounds) {
      const b = active.textBounds, field = active.shell;
      const left = rect.left + b.x * rect.width, top = rect.top + b.y * rect.height;
      field.style.left = (left - 1) + "px";
      field.style.top = (top - 1) + "px";
      field.style.fontSize = ((b.em ?? b.h) * rect.height) + "px";
      field.style.minWidth = Math.min(Math.max(8, b.w * rect.width + 2), innerWidth) + "px";
      field.style.maxWidth = Math.max(16, Math.min(rect.right, innerWidth) - left) + "px";
      return;
    }
    const x = rect.left + active.u * rect.width, y = rect.top + active.v * rect.height;
    // Anchor to the clicked ink. A SyncTeX box for align can span the
    // entire measure even when the printed formula occupies a single cell.
    const dx = active.inkOffset?.x ?? active.shell.offsetWidth / 2;
    const dy = active.inkOffset?.y ?? active.shell.offsetHeight / 2;
    active.shell.style.left = Math.max(2, Math.min(x - dx, innerWidth - active.shell.offsetWidth - 2)) + "px";
    active.shell.style.top = (y - dy) + "px";
  };
  scroll.addEventListener("scroll", position, { passive: true });
  window.addEventListener("resize", position);
  document.addEventListener("pointerdown", event => {
    if (!event.target.closest?.(".math-wysiwyg-panel") && (!active || !active.shell.contains(event.target))) close();
  }, true);
  window.addEventListener("pagehide", () => { close(); view(null, null); });
  window.addEventListener("blur", () => close());
  const open = async (event, point) => {
    const paper = currentPaper();
    const page = event.target.closest(".page");
    if (!paper || !page || !point || window.getSelection()?.toString()) return;
    let clicked;
    if (point.page === 1 && emptyCaret?.generation === paper.generation && filledGeneration !== paper.generation) {
      const rect = emptyTextRect(point.page, emptyCaret.point);
      if (rect) clicked = { printed: "", rect, offset: 0, font: "serif", horizontal: true };
    } else if (event.target.closest(".textLayer span")) {
      clicked = clickedCharacter(event);
      if (clicked) {
        // Italic ink can overhang the closing dollar marker.
        const ink = clicked.glyphRect;
        point = pointAt({ target: clicked.node.parentElement, clientX: ink.left + ink.width / 2,
          clientY: ink.top + ink.height / 2 }) ?? point;
      }
    }
    if (!clicked) return;
    const id = ++sequence, rect = page.getBoundingClientRect();
    const ink = clicked.glyphRect;
    const u = ((ink ? ink.left + ink.width / 2 : event.clientX) - rect.left) / rect.width;
    const v = ((ink ? ink.top + ink.height / 2 : event.clientY) - rect.top) / rect.height;
    // Capture native typing from the click itself. Japanese composition stays
    // in this very textarea if the ink resolves to text; it is never replayed
    // as individual intermediate characters.
    const draft = document.createElement("textarea");
    draft.className = "pdf-fallback-text is-resolving";
    draft.rows = 1;
    draft.spellcheck = false;
    draft.style.fontFamily = clicked.font;
    draft.setAttribute("aria-label", clicked.printed || paper.pdfPath);
    draft.value = clicked.printed;
    const b = clicked.rect, operations = [];
    let composition = null, previous = draft.value, previousCommitted = draft.value, sent = draft.value;
    const input = { shell: draft, page: point.page, read: () => composition ? previousCommitted : draft.value, sessionId: null,
      endComposition: () => composition?.resolve(),
      textBounds: { x: (b.left - rect.left) / rect.width, y: (b.top - rect.top) / rect.height,
        w: b.width / rect.width, h: b.height / rect.height } };
    if (!clicked.node) input.emptyGeneration = paper.generation;
    active = input;
    const publish = () => {
      if (!composition) previousCommitted = draft.value;
      if (active !== input || !input.sessionId || sent === previousCommitted) return;
      sent = previousCommitted;
      if (input.emptyGeneration != null) filledGeneration = sent ? input.emptyGeneration : null;
      void send(input.sessionId, sent, false, false);
    };
    draft.addEventListener("compositionstart", () => {
      let resolve;
      const done = new Promise(r => { resolve = r; });
      composition = { done, resolve };
      draft.classList.add("is-composing");
    });
    draft.addEventListener("compositionend", e => {
      if (!input.sessionId && e.data) operations.push({ text: e.data, composed: true });
      draft.classList.remove("is-composing");
      composition?.resolve();
      composition = null;
      previous = draft.value;
      publish();
    });
    draft.addEventListener("input", e => {
      if (!input.sessionId && !composition && !e.isComposing && previous !== draft.value) {
        if (e.inputType === "deleteContentBackward") operations.push({ command: "deleteBackward" });
        else if (e.inputType === "deleteContentForward") operations.push({ command: "deleteForward" });
        else if (e.inputType === "insertLineBreak" || e.inputType === "insertParagraph") operations.push({ enter: true });
        else {
          const inserted = e.data ?? draft.value.slice(Math.max(0, draft.selectionEnd - (draft.value.length - previous.length)), draft.selectionEnd);
          if (inserted) operations.push({ text: inserted });
        }
      }
      previous = draft.value;
      publish();
    });
    draft.addEventListener("keydown", key => {
      if (key.isComposing || composition || key.keyCode === 229) return;
      if (!input.sessionId && !key.altKey && !key.metaKey && !key.ctrlKey) {
        const move = { ArrowLeft: ["moveToPreviousChar", "extendSelectionBackward"], ArrowRight: ["moveToNextChar", "extendSelectionForward"],
          ArrowUp: ["moveUp", "extendSelectionUpward"], ArrowDown: ["moveDown", "extendSelectionDownward"],
          Home: ["moveToMathfieldStart", "extendToMathFieldStart"], End: ["moveToMathfieldEnd", "extendToMathFieldEnd"] }[key.key];
        if (move) operations.push({ command: move[Number(key.shiftKey)] });
      }
      if (key.key === "Escape" || (key.key === "Enter" && (key.ctrlKey || key.metaKey))) {
        key.preventDefault();
        key.stopPropagation();
        close(key.key === "Escape");
      }
    });
    draft.addEventListener("blur", e => { if (active === input && e.relatedTarget) close(); });
    document.body.append(draft);
    position();
    draft.focus({ preventScroll: true });
    draft.setSelectionRange(clicked.offset, clicked.offset);
    // Reverse lookup uses the clicked revision. A repaint of the same paper
    // may finish before SyncTeX or MathLive returns.
    const sameDocument = () => currentPaper()?.documentId === paper.documentId && currentPaper()?.pdfPath === paper.pdfPath;
    // Do not let a second click abort the source lookup for already typed
    // text from the first. The new click still captures its own input now.
    const openTarget = resolving.then(async () => {
      if ((id !== sequence && (input.cancelled || draft.value === clicked.printed)) || !sameDocument()) return null;
      const query = { action: "open", ...paper, page: point.page, x: point.x, y: point.y,
        printed: clicked.horizontal ? clicked.printed : null };
      const result = await request(query);
      if (!result?.needsOccurrences || !page.isConnected || !sameDocument()) return result;
      return request({ ...query, occurrences: repeatedInk(page, clicked, pointAt) });
    });
    resolving = openTarget.catch(() => null);
    const result = await resolving;
    const hasPendingMath = () => result?.kind === "math" && !input.cancelled &&
      operations.some(op => op.text || op.command?.startsWith("delete"));
    if (!result?.ok || !sameDocument() || (id !== sequence && !hasPendingMath())) {
      if (result?.ok) {
        const value = input.read();
        const accept = result.kind === "text" && !input.cancelled && sameDocument() && value !== clicked.printed;
        await send(result.sessionId, value, true, !accept);
      }
      if (active === input) close(true);
      return;
    }
    if (result.kind === "text") {
      input.sessionId = result.sessionId;
      operations.length = 0;
      draft.classList.remove("is-resolving");
      publish();
      if (!clicked.node) return;
      void typeAt(point.page, clicked.node).then(type => {
        if (!type || active !== input) return;
        draft.style.fontFamily = type.family;
        draft.style.fontWeight = type.bold ? "bold" : "normal";
        draft.style.fontStyle = type.italic ? "italic" : "normal";
        input.textBounds.em = type.em;
        input.textBounds.y = type.top;
        position();
      }).catch(() => {});

      return;
    }
    try { await loadMath(); } catch { /* keep the PDF usable when math assets are unavailable */ }
    if (composition && active === input) await composition.done;
    const background = active !== input;
    if ((background && !hasPendingMath()) || !sameDocument() || !window.tex64PaperMath) {
      await send(result.sessionId, "", true, true);
      if (active === input) close(true);
      return;
    }
    if (!background) active = null;
    draft.remove();
    const shell = document.createElement("div"), field = document.createElement("math-field");
    shell.className = "pdf-fallback-math";
    if (background) {
      shell.style.visibility = "hidden";
      shell.setAttribute("aria-hidden", "true");
    }
    field.setAttribute("math-virtual-keyboard-policy", "manual");
    field.removeExtraneousParentheses = false;
    shell.append(field);
    document.body.append(shell);
    const begin = result.wrap ? `\\begin{${result.wrap}}` : "";
    const end = result.wrap ? `\\end{${result.wrap}}` : "";
    field.setValue(begin + result.value + end, { silenceNotifications: true });
    // MathLive can update its model before delivering the input event.
    // Compare at commit time and preserve the original TeX for a no-op edit.
    const initialLatex = field.getValue("latex-without-placeholders");
    const inner = latex => begin && latex.startsWith(begin) && latex.endsWith(end)
      ? latex.slice(begin.length, -end.length) : null;
    const initialBody = inner(initialLatex);
    const originalCells = begin ? alignmentCells(result.value) : null;
    const initialCells = initialBody !== null ? alignmentCells(initialBody) : null;
    if (begin) field.addEventListener("selection-change", () => {
      if (!field.selectionIsCollapsed || field.lastOffset < 2) return;
      const pos = field.position;
      if (pos !== 0 && pos !== field.lastOffset) return;
      const inside = pos === 0 ? 1 : pos - 1;
      if (field.getEnvironmentContext(inside).environments.at(-1) === result.wrap) field.position = inside;
    });
    const read = () => {
      const latex = field.getValue("latex-without-placeholders");
      if (latex === initialLatex) return result.value;
      const body = inner(latex);
      if (body !== null && initialCells) {
        const cells = alignmentCells(body);
        if (cells.length !== originalCells.length || cells.length !== initialCells.length ||
            cells.some((v, i) => i % 2 && (v !== originalCells[i] || v !== initialCells[i]))) return body;
        return cells.map((cell, i) => {
          const original = originalCells[i];
          if (i % 2 || cell === initialCells[i]) return original;
          // An escaped trailing space is a TeX command inside the cell.
          // Keep MathLive's serialization if trimming would remove its argument.
          if ([cell, original, initialCells[i]].some(part => /\\\s+$/.test(part))) return cell;
          if (cell.trim() === initialCells[i].trim()) return original;
          const leading = original.match(/^\s*/)[0];
          return leading + cell.trim() + original.slice(leading.length).match(/\s*$/)[0];
        }).join("");
      }
      if (body !== null) return body;
      return latex;
    };
    if (!background) {
      active = { shell, sessionId: result.sessionId, page: point.page, u, v, read,
        dispose: window.tex64PaperMath.attach(field, shell, { onEscape: () => close(true), onCommit: () => close() }) };
      position();
      field.addEventListener("input", () => {
        if (active?.shell !== shell) return;
        position();
        void send(result.sessionId, read(), false, false);
      });
      field.focus({ preventScroll: true });
    }
    let placed = false;
    if (clicked) {
      const { leaves, box = result.box } = alignedGlyphs(field.getModelMetadata(), result.alignment);
      const choices = leaves.filter(atom => atom.symbol.normalize("NFKC") === clicked.glyph);
      let hit = choices.length === 1 ? choices[0] : null;
      if (choices.length > 1 && box) {
        const rects = leaves.map(atom => field.getElementInfo(atom.offset)?.glyphBounds).filter(r => r?.width && r.height);
        if (rects.length && box.right > box.left && box.bottom > box.top) {
          const left = Math.min(...rects.map(r => r.left)), top = Math.min(...rects.map(r => r.top));
          const width = Math.max(...rects.map(r => r.right)) - left, height = Math.max(...rects.map(r => r.bottom)) - top;
          const x = left + width * (point.x - box.left) / (box.right - box.left);
          const y = top + height * (point.y - box.top) / (box.bottom - box.top);
          const distance = atom => {
            const r = field.getElementInfo(atom.offset)?.glyphBounds;
            return r ? Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2)) : Infinity;
          };
          hit = choices.reduce((a, b) => distance(a) < distance(b) ? a : b);
        }
      }
      if (hit) {
        field.position = clicked.after ? hit.offset : hit.beforeOffset;
        if (!background) {
          const anchorInk = () => {
            if (active?.shell !== shell || active.inkOffset || read() !== result.value) return;
            const glyph = field.getElementInfo(hit.offset)?.glyphBounds;
            if (!glyph?.width || !glyph.height) return;
            const bounds = shell.getBoundingClientRect();
            active.inkOffset = { x: glyph.left + glyph.width / 2 - bounds.left, y: glyph.top + glyph.height / 2 - bounds.top };
            position();
          };
          anchorInk();
          if (!active?.inkOffset) requestAnimationFrame(anchorInk);
        }
        placed = true;
      }
    }
    if (background && !placed) {
      shell.remove();
      await send(result.sessionId, "", true, true);
      return;
    }
    for (const operation of operations) {
      if (operation.enter) {
        if (background) {
          if (!field.getEnvironmentContext?.().nearestArray) break;
          field.executeCommand("addRowAfterFromReturn");
        } else {
          field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, composed: true }));
          if (active?.shell !== shell) break;
        }
      } else if (operation.command) field.executeCommand(operation.command);
      else field.executeCommand("typedText", operation.text, { focus: !background, feedback: false, simulateKeystroke: !operation.composed });
    }
    if (background) {
      const value = read();
      shell.remove();
      await send(result.sessionId, value, true, false);
    }
  };
  return { open, close, position, view, isEditing: () => active !== null };
}
