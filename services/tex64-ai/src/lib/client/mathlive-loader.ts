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
    loading = null;
    throw error;
  });
  return loading;
}
