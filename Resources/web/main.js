window.addEventListener("DOMContentLoaded", () => {
  requestAnimationFrame(() => {
    document.body.classList.add("is-ready");
  });

  const editorHost = document.getElementById("editor");
  const fallback = document.getElementById("editor-fallback");

  const updateFallback = (message) => {
    if (!fallback) {
      return;
    }
    const body = fallback.querySelector("p");
    if (body) {
      body.textContent = message;
    }
  };

  if (!editorHost) {
    updateFallback("エディタ領域が見つかりません。");
    return;
  }

  const baseUrl = new URL("monaco/vs/", window.location.href).toString();
  const requireBase = baseUrl.replace(/\/$/, "");

  window.MonacoEnvironment = {
    getWorkerUrl: () => {
      const workerMain = `${baseUrl}base/worker/workerMain.js`;
      const workerBootstrap = [
        `self.MonacoEnvironment = { baseUrl: '${baseUrl}' };`,
        `importScripts('${workerMain}');`,
      ].join("\n");
      return URL.createObjectURL(
        new Blob([workerBootstrap], { type: "text/javascript" })
      );
    },
  };

  if (!window.require || !window.require.config) {
    updateFallback("Monacoのローダーが見つかりません。");
    return;
  }

  window.require.config({ paths: { vs: requireBase } });
  window.require(
    ["vs/editor/editor.main"],
    () => {
      if (!window.monaco) {
        updateFallback("Monacoの初期化に失敗しました。");
        return;
      }

      window.monaco.editor.create(editorHost, {
        value: "",
        language: "plaintext",
        theme: "vs-dark",
        automaticLayout: true,
        minimap: { enabled: false },
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
        fontFamily: "\"SF Mono\", Menlo, monospace",
        fontSize: 13,
        lineHeight: 20,
        scrollBeyondLastLine: false,
        wordWrap: "off",
      });

      document.body.classList.add("has-editor");
    },
    () => {
      updateFallback("Monacoの読み込みに失敗しました。");
    }
  );
});
