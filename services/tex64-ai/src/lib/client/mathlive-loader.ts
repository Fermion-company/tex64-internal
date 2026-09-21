"use client";

type MathfieldConstructor = CustomElementConstructor & {
  fontsDirectory?: string;
  soundsDirectory?: string | null;
  keypressSound?: string | null;
  plonkSound?: string | null;
  keypressVibration?: boolean;
};

type MathLiveWindow = Window & {
  MathLive?: { MathfieldElement?: MathfieldConstructor };
  MathfieldElement?: MathfieldConstructor;
};

let loading: Promise<void> | null = null;

/** Load the app's existing vendored MathLive build from the local AI server. */
export function ensureMathLive(): Promise<void> {
  if (customElements.get("math-field")) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise<void>((resolve, reject) => {
    const finish = () => {
      const mathWindow = window as MathLiveWindow;
      const constructor =
        mathWindow.MathLive?.MathfieldElement ?? mathWindow.MathfieldElement;
      if (!constructor) {
        reject(new Error("MathLive did not expose MathfieldElement."));
        return;
      }
      constructor.fontsDirectory = "/native-assets/mathlive/fonts";
      constructor.soundsDirectory = null;
      constructor.keypressSound = null;
      constructor.plonkSound = null;
      constructor.keypressVibration = false;
      if (!customElements.get("math-field")) {
        try {
          customElements.define("math-field", constructor);
        } catch {
          // Another editor may have registered it while the script loaded.
        }
      }
      if (customElements.get("math-field")) resolve();
      else reject(new Error("MathLive custom element is unavailable."));
    };

    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-tex64-mathlive="true"]',
    );
    if (existing) {
      if (existing.dataset.loaded === "true") finish();
      else {
        existing.addEventListener("load", finish, { once: true });
        existing.addEventListener("error", () => reject(new Error("MathLive load failed.")), {
          once: true,
        });
      }
      return;
    }

    const script = document.createElement("script");
    script.src = "/native-assets/mathlive/mathlive.min.js";
    script.dataset.tex64Mathlive = "true";
    script.addEventListener(
      "load",
      () => {
        script.dataset.loaded = "true";
        finish();
      },
      { once: true },
    );
    script.addEventListener("error", () => reject(new Error("MathLive load failed.")), {
      once: true,
    });
    document.head.appendChild(script);
  }).catch((error) => {
    document.querySelector('script[data-tex64-mathlive="true"]')?.remove();
    loading = null;
    throw error;
  });
  return loading;
}

type PaperMath = { attach: (field: HTMLElement, container: HTMLElement) => () => void };
let paperMathLoading: Promise<PaperMath> | null = null;

export async function ensurePaperMath(): Promise<PaperMath> {
  await ensureMathLive();
  if (paperMathLoading) return paperMathLoading;
  paperMathLoading = new Promise<PaperMath>((resolve, reject) => {
    if (!document.querySelector('link[data-paper-math]')) {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "/native-assets/mathlive/mathlive-static.css";
      css.dataset.paperMath = "true";
      document.head.appendChild(css);
    }
    const script = document.createElement("script");
    script.type = "module";
    script.src = "/native-assets/editor/math/wysiwyg/native-editor.js";
    script.onload = () => {
      const api = (window as Window & { tex64PaperMath?: PaperMath }).tex64PaperMath;
      if (api) resolve(api);
      else { script.remove(); reject(new Error("数式入力を読み込めませんでした。")); }
    };
    script.onerror = () => { script.remove(); reject(new Error("数式入力を読み込めませんでした。")); };
    document.head.appendChild(script);
  }).catch((error) => { paperMathLoading = null; throw error; });
  return paperMathLoading;
}
