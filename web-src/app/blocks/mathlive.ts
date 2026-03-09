import type { AppContext } from "../context.js";
import { closeMathfieldInternalMenu } from "../../math/mathfield-private-adapter.js";

type MathLiveDeps = {
  onMathFieldCreated: (mathfield: HTMLElement) => void;
  onAttachMathFieldEvents: (mathfield: HTMLElement) => void;
  onMathLiveReady: () => void;
  onEnsureMathLiveReady: () => void;
};

type MenuItemLike = {
  id?: unknown;
  label?: unknown;
  ariaLabel?: unknown;
  tooltip?: unknown;
  type?: unknown;
  submenu?: MenuItemLike[];
  data?: unknown;
  command?: unknown;
};

export type MathLiveApi = {
  setupMathField: () => Promise<void>;
};

export const initMathLive = (context: AppContext, deps: MathLiveDeps): MathLiveApi => {
  const { blockMathInputContainer } = context.dom;
  let setupInFlight = false;
  let setupRetryScheduled = false;
  let containerPointerDownHandler: ((event: PointerEvent) => void) | null = null;

  const setupMathField = async () => {
    if (setupInFlight) {
      return;
    }
    setupInFlight = true;

    const scheduleSetupRetry = () => {
      if (setupRetryScheduled) {
        return;
      }
      setupRetryScheduled = true;
      window.addEventListener(
        "mathlive-ready",
        () => {
          setupRetryScheduled = false;
          void setupMathField();
        },
        { once: true }
      );
    };

    const readCurrentInputValue = () => {
      if (!blockMathInputContainer) {
        return "";
      }
      const existingInput = blockMathInputContainer.querySelector("#block-math-input") as
        | HTMLTextAreaElement
        | (HTMLElement & {
            getValue?: (format?: string) => unknown;
            value?: unknown;
          })
        | null;
      if (!existingInput) {
        return "";
      }
      const mathfieldInput = existingInput as {
        getValue?: (format?: string) => unknown;
        value?: unknown;
      };
      if (typeof mathfieldInput.getValue === "function") {
        try {
          const value = mathfieldInput.getValue("latex");
          if (typeof value === "string") {
            return value;
          }
        } catch (error) {
          console.debug("[MathLive] getValue('latex') threw; trying .value fallback", error);
        }
      }
      if (typeof mathfieldInput.value === "string") {
        return mathfieldInput.value;
      }
      return "";
    };

    const createMathInputFallback = (message?: string, preserveValue = "") => {
      if (!blockMathInputContainer) {
        return;
      }
      if (containerPointerDownHandler) {
        blockMathInputContainer.removeEventListener("pointerdown", containerPointerDownHandler);
        containerPointerDownHandler = null;
      }
      blockMathInputContainer.innerHTML = "";
      blockMathInputContainer.style.removeProperty("color");

      const scrollHost = document.createElement("div");
      scrollHost.className = "block-math-scroll";

      const fallbackInput = document.createElement("textarea");
      fallbackInput.id = "block-math-input";
      fallbackInput.className = "block-input block-math-input";
      fallbackInput.setAttribute("rows", "4");
      fallbackInput.setAttribute("spellcheck", "false");
      fallbackInput.setAttribute("aria-label", "数式入力（テキスト）");
      fallbackInput.placeholder = "LaTeX を入力";
      fallbackInput.style.width = "100%";
      fallbackInput.style.minHeight = "96px";
      fallbackInput.style.resize = "vertical";
      if (preserveValue) {
        fallbackInput.value = preserveValue;
      }

      scrollHost.appendChild(fallbackInput);
      blockMathInputContainer.appendChild(scrollHost);

      if (message) {
        const note = document.createElement("div");
        note.style.fontSize = "10px";
        note.style.color = "var(--muted)";
        note.style.padding = "0 12px 10px";
        note.textContent = message;
        blockMathInputContainer.appendChild(note);
      }

      deps.onMathFieldCreated(fallbackInput);
    };

    try {
      if (!blockMathInputContainer) {
        console.error("MathLive container not found");
        return;
      }

      if (blockMathInputContainer.querySelector("math-field")) {
        return;
      }

      const preservedValue = readCurrentInputValue();
      const existingFallback = blockMathInputContainer.querySelector(
        "textarea#block-math-input"
      ) as HTMLTextAreaElement | null;

      const MathLiveGlobal = (window as any).MathLive;
      const hasMathLive = !!MathLiveGlobal;
      const hasMathfieldElement = hasMathLive && !!MathLiveGlobal.MathfieldElement;
      const loadError = (window as any).MATHLIVE_LOAD_ERROR;
      const configureMathLiveAudio = () => {
        const mathfieldElement = (MathLiveGlobal?.MathfieldElement ??
          (window as any).MathfieldElement) as
          | {
              soundsDirectory?: string | null;
              keypressSound?: unknown;
              plonkSound?: unknown;
              keypressVibration?: boolean;
            }
          | undefined;
        if (mathfieldElement) {
          try {
            mathfieldElement.soundsDirectory = null;
            mathfieldElement.keypressSound = null;
            mathfieldElement.plonkSound = null;
            mathfieldElement.keypressVibration = false;
          } catch {
            // ignore global audio option failures
          }
        }
        const mathVirtualKeyboard = (window as any).mathVirtualKeyboard as
          | {
              keypressSound?: unknown;
              plonkSound?: unknown;
              keypressVibration?: boolean;
            }
          | undefined;
        if (mathVirtualKeyboard) {
          try {
            mathVirtualKeyboard.keypressSound = null;
            mathVirtualKeyboard.plonkSound = null;
            mathVirtualKeyboard.keypressVibration = false;
          } catch {
            // ignore virtual keyboard audio option failures
          }
        }
      };
      configureMathLiveAudio();

      if (!customElements.get("math-field")) {
        if (hasMathfieldElement) {
          try {
            customElements.define("math-field", MathLiveGlobal.MathfieldElement);
          } catch {
            // element may already be defined
          }
        }
      }

      if (!customElements.get("math-field")) {
        const debugInfo = `MathLive: ${hasMathLive ? "OK" : "NG"}, MathfieldElement: ${
          hasMathfieldElement ? "OK" : "NG"
        }, LoadError: ${loadError || "none"}`;
        scheduleSetupRetry();
        if (!existingFallback) {
          createMathInputFallback("MathLive loading...", preservedValue);
        }
        try {
          await Promise.race([
            customElements.whenDefined("math-field"),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 10000)),
          ]);
        } catch {
          if (customElements.get("math-field")) {
            // A late define can race with timeout; continue with math-field setup.
          } else {
            const retryValue = readCurrentInputValue() || preservedValue;
            createMathInputFallback(`MathLive unavailable (${debugInfo})`, retryValue);
            scheduleSetupRetry();
            return;
          }
        }
      }

      if ((window as any).MathLive?.convertLatexToMarkup) {
        deps.onMathLiveReady();
      } else {
        deps.onEnsureMathLiveReady();
      }

      const mathfield = document.createElement("math-field") as any;
      mathfield.id = "block-math-input";
      mathfield.className = "block-math-field";
      mathfield.setAttribute("placeholder", "数式を入力");


      const scrollHost = document.createElement("div");
      scrollHost.className = "block-math-scroll";
      scrollHost.appendChild(mathfield);

      const menuToggle = document.createElement("button");
      menuToggle.type = "button";
      menuToggle.className = "block-math-menu-toggle";
      menuToggle.setAttribute("aria-label", "数式メニュー");
      menuToggle.setAttribute("aria-haspopup", "menu");
      menuToggle.tabIndex = -1;
      menuToggle.innerHTML = `
      <span class="block-math-menu-line"></span>
      <span class="block-math-menu-line"></span>
      <span class="block-math-menu-line"></span>
    `;

      blockMathInputContainer.innerHTML = "";
      blockMathInputContainer.appendChild(scrollHost);
      blockMathInputContainer.appendChild(menuToggle);
      const closeMathFieldMenu = () => {
        if (closeMathfieldInternalMenu(mathfield)) {
          return;
        }
        const executeCommand = (mathfield as { executeCommand?: (command: string) => void })
          .executeCommand;
        if (typeof executeCommand === "function") {
          const menuElement = document.querySelector("menu.ui-menu-container");
          if (menuElement) {
            executeCommand.call(mathfield, "toggleContextMenu");
          }
        }
      };
      const toggleMathFieldMenu = () => {
        const executeCommand = (mathfield as { executeCommand?: (command: string) => void })
          .executeCommand;
        if (typeof executeCommand === "function") {
          executeCommand.call(mathfield, "toggleContextMenu");
        }
      };
      menuToggle.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      menuToggle.addEventListener("focus", () => {
        menuToggle.blur();
      });
      menuToggle.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleMathFieldMenu();
      });
      if (containerPointerDownHandler) {
        blockMathInputContainer.removeEventListener("pointerdown", containerPointerDownHandler);
      }
      containerPointerDownHandler = (event: PointerEvent) => {
        const path = typeof event.composedPath === "function" ? event.composedPath() : [];
        const clickedMenuToggle = path.some((node) => {
          if (!(node instanceof HTMLElement)) return false;
          if (node.classList?.contains("block-math-menu-toggle")) return true;
          if (node.getAttribute?.("part") === "menu-toggle") return true;
          return node.classList?.contains("ML__menu-toggle") ?? false;
        });
        const clickedMathMenu = path.some((node) => {
          if (!(node instanceof HTMLElement)) return false;
          if (node.matches?.("menu.ui-menu-container")) return true;
          return !!node.closest?.("menu.ui-menu-container");
        });
        if (!clickedMenuToggle && !clickedMathMenu) {
          closeMathFieldMenu();
        }
        if (!clickedMathMenu && !clickedMenuToggle && typeof mathfield.focus === "function") {
          mathfield.focus();
        }
      };
      blockMathInputContainer.addEventListener("pointerdown", containerPointerDownHandler);
      deps.onMathFieldCreated(mathfield);
      if (preservedValue) {
        try {
          if (typeof mathfield.setValue === "function") {
            mathfield.setValue(preservedValue);
          } else if ("value" in mathfield) {
            mathfield.value = preservedValue;
          }
        } catch (restoreError) {
          try {
            if ("value" in mathfield) {
              mathfield.value = preservedValue;
            }
          } catch {
            console.warn("MathLive: failed to restore preserved value", restoreError);
            mathfield.dataset.preservedLatex = preservedValue;
          }
        }
      }

      if (typeof mathfield.setOptions === "function") {
        mathfield.setOptions({
          smartMode: false,
          smartFence: false,
          defaultMode: "math",
          inlineShortcuts: {},
          onInlineShortcut: () => "",
          virtualKeyboardMode: "off",
          fontsDirectory: "mathlive/fonts",
          soundsDirectory: null,
          keypressSound: null,
          plonkSound: null,
          locale: "ja",
        });
      }

      // MathLive doesn't support some LaTeX font commands natively (e.g. \mathds),
      // so we map only those minimal render aliases here.
      try {
        if ("macros" in mathfield) {
          mathfield.macros = {
            ...(mathfield.macros ?? {}),
            mathds: { def: "\\mathbb{#1}", args: 1 },
          };
        }
      } catch {
        // ignore macro configuration failures
      }

    try {
      if ("menuItems" in mathfield) {
        const blockedLabels = [
          "モード",
          "フォントスタイル",
          "色",
          "背景",
          "切り取り",
          "コピー",
          "貼り付け",
          "すべて選択",
        ];
        const blockedPattern =
          /(mode|font\s*style|color|background|cut|copy|paste|select\s*all)/i;

        const readText = (value: unknown): string => {
          if (typeof value === "string") return value;
          if (typeof value === "number" || typeof value === "boolean") return String(value);
          return "";
        };

        const readLabel = (value: unknown): string => {
          if (typeof value === "function") {
            try {
              return readText(value({ alt: false, control: false, shift: false, meta: false }));
            } catch {
              return "";
            }
          }
          return readText(value);
        };

        const isDivider = (item: MenuItemLike) => item.type === "divider";

        const cleanDividers = (items: MenuItemLike[]) => {
          const cleaned: MenuItemLike[] = [];
          let lastWasDivider = true;
          for (const item of items) {
            if (isDivider(item)) {
              if (lastWasDivider) continue;
              cleaned.push(item);
              lastWasDivider = true;
              continue;
            }
            cleaned.push(item);
            lastWasDivider = false;
          }
          while (cleaned.length > 0 && isDivider(cleaned[cleaned.length - 1])) {
            cleaned.pop();
          }
          return cleaned;
        };

        const getCandidates = (item: MenuItemLike) => {
          const candidates: string[] = [];
          candidates.push(readText(item.id));
          candidates.push(readLabel(item.label));
          candidates.push(readLabel(item.ariaLabel));
          candidates.push(readLabel(item.tooltip));
          candidates.push(readText(item.command));
          if (item.data && typeof item.data === "object") {
            const dataObj = item.data as Record<string, unknown>;
            candidates.push(readText(dataObj.command));
            candidates.push(readText(dataObj.id));
            candidates.push(readLabel(dataObj.label));
          } else {
            candidates.push(readText(item.data));
          }
          return candidates.filter(Boolean);
        };

        const shouldHideItem = (candidates: string[]) =>
          candidates.some((text) => {
            const trimmed = text.trim();
            if (!trimmed) return false;
            if (blockedPattern.test(trimmed)) return true;
            return blockedLabels.some((label) => trimmed.includes(label));
          });

        const filterMenuItems = (items: MenuItemLike[]): MenuItemLike[] => {
          const filtered = items
            .map((item) => {
              if (!item || typeof item !== "object") return null;
              if (item.type === "heading") return null;
              const candidates = getCandidates(item);
              if (shouldHideItem(candidates)) return null;
              if (Array.isArray(item.submenu)) {
                const submenu = filterMenuItems(item.submenu);
                if (submenu.length === 0) return null;
                if (submenu === item.submenu) return item;
                return { ...item, submenu };
              }
              if (isDivider(item)) return item;
              return item;
            })
            .filter(Boolean) as MenuItemLike[];
          return cleanDividers(filtered);
        };

        const currentMenuItems = (mathfield as { menuItems?: MenuItemLike[] }).menuItems ?? [];
        (mathfield as { menuItems?: MenuItemLike[] }).menuItems = filterMenuItems(
          currentMenuItems
        );
      }
    } catch {
      // ignore menu configuration failures
    }

    const injectStyles = () => {
      if (!mathfield.shadowRoot) return;
      if (mathfield.shadowRoot.querySelector('style[data-tex64-style]')) return;

      const style = document.createElement("style");
      style.setAttribute("data-tex64-style", "true");
      style.textContent = `
        :host {
          color: var(--text, #eef3fb) !important;
          background-color: transparent !important;
        }
        .ML__container {
          --hue: 200;
          position: relative !important;
          justify-content: flex-start !important;
          align-items: flex-start !important;
          padding-right: 0 !important;
          height: auto !important;
          min-height: 100% !important;
        }
        .ML__field {
          color: var(--text, #eef3fb) !important;
        }
        .ML__placeholder {
          color: var(--accent, #5bc2ff) !important;
          opacity: 0.7;
          background: rgba(91, 194, 255, 0.06);
          border-radius: 2px;
        }
        .ML__selection {
          background: rgba(91, 194, 255, 0.45) !important;
          outline: none !important;
          outline-offset: 0 !important;
          box-shadow: none !important;
          color: var(--text, #f8fbff) !important;
        }
        .ML__prompt {
          border-radius: 4px !important;
          background: rgba(91, 194, 255, 0.08) !important;
        }
        .ML__editablePromptBox {
          outline: none !important;
          box-shadow: none !important;
          background: rgba(91, 194, 255, 0.16) !important;
          z-index: 0 !important;
        }
        .ML__focused .ML__focusedPromptBox {
          outline: none !important;
          box-shadow: none !important;
          background: rgba(91, 194, 255, 0.32) !important;
          z-index: 1 !important;
        }
        .ML__caret {
          background-color: var(--accent, #5bc2ff) !important;
        }
        .ML__contains-highlight {
          background: rgba(91, 194, 255, 0.25) !important;
        }
        .ML__tex64-unknown-command {
          border-color: hsl(205, 20%, 40%) !important;
          background: hsl(210, 15%, 22%) !important;
          color: hsl(210, 30%, 82%) !important;
        }
        .ML__tex64-unknown-command-args {
          border-left-color: hsl(205, 18%, 45%) !important;
        }
        .ML__tex64-aux-command {
          border-color: hsl(208, 22%, 44%) !important;
          background: hsl(210, 18%, 20%) !important;
          color: hsl(210, 40%, 82%) !important;
        }
        .ML__tex64-aux-command-arg {
          border-left-color: hsl(208, 18%, 42%) !important;
        }
        .ML__tex64-aux-command--label,
        .ML__tex64-aux-command--ref,
        .ML__tex64-aux-command--eqref,
        .ML__tex64-aux-command--pageref,
        .ML__tex64-aux-command--autoref {
          border-color: hsl(203, 30%, 42%) !important;
          background: hsl(200, 22%, 20%) !important;
        }
        .ML__tex64-aux-command--tag,
        .ML__tex64-aux-command--tagstar {
          border-color: hsl(30, 35%, 42%) !important;
          background: hsl(32, 22%, 20%) !important;
        }
        .ML__tex64-aux-command--intertext,
        .ML__tex64-aux-command--shortintertext {
          border-color: hsl(149, 22%, 40%) !important;
          background: hsl(145, 18%, 20%) !important;
        }
        .ML__tex64-aux-command--notag,
        .ML__tex64-aux-command--nonumber {
          border-color: hsl(4, 30%, 44%) !important;
          background: hsl(6, 18%, 22%) !important;
        }
        .ML__virtual-keyboard-toggle {
          display: none !important;
        }
        button[part="virtual-keyboard-toggle"] {
          display: none !important;
        }
        .ML__menu-toggle {
          display: none !important;
        }
        button[part="menu-toggle"] {
          display: none !important;
        }
        .ML__content {
          flex: 1 1 auto !important;
          min-width: 0 !important;
        }
        .ML__toggles {
          margin-left: auto !important;
        }
        .ML__menu-toggle {
          margin-right: 0 !important;
          width: 28px !important;
          height: 28px !important;
        }
      `;
      mathfield.shadowRoot.appendChild(style);
    };

      // Try immediate injection first, then retry after a frame in case the
      // shadowRoot isn't available yet (custom element upgrade timing).
      injectStyles();
      if (!mathfield.shadowRoot?.querySelector("style[data-tex64-style]")) {
        requestAnimationFrame(() => {
          injectStyles();
          if (!mathfield.shadowRoot?.querySelector("style[data-tex64-style]")) {
            // Final fallback: observe shadow root creation.
            const observer = new MutationObserver(() => {
              if (mathfield.shadowRoot) {
                injectStyles();
                observer.disconnect();
              }
            });
            observer.observe(mathfield, { childList: true, subtree: true });
            // Safety disconnect after 5 seconds to prevent leaks.
            setTimeout(() => observer.disconnect(), 5000);
          }
        });
      }

      deps.onAttachMathFieldEvents(mathfield);
    } catch (error) {
      const recoveredValue = readCurrentInputValue();
      const message = error instanceof Error ? error.message : String(error);
      console.error("MathLive setup failed; fallback to textarea:", error);
      createMathInputFallback(`MathLive setup error (${message})`, recoveredValue);
      if (!customElements.get("math-field")) {
        scheduleSetupRetry();
      }
    } finally {
      setupInFlight = false;
    }
  };

  return { setupMathField };
};
