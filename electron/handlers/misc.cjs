const createMiscHandlers = (deps) => {
  const {
    envService,
    ensureUserSettings,
    registerCaptureShortcut,
    clipboard,
    nativeImage,
    workspace,
    sendToRenderer,
    resolveWorkspacePath,
    updateWorkspaceIfNeeded,
    fsp,
    path,
    WorkspaceError,
    blocksStore,
  } = deps;

  const handleEnvCheck = async (command) => {
    const result = await envService.checkCommand(command);
    sendToRenderer("env:checkResult", { command, available: result });
  };

  const handleEnvInstall = async (target) => {
    sendToRenderer("env:installStart", { target });
    const result = await envService.installEnvironment(target);
    sendToRenderer("env:installResult", { target, ...result });
    // Re-check relevant commands after install attempt
    if (target === "basictex") {
      const lualatex = await envService.checkCommand("lualatex");
      const latexmk = await envService.checkCommand("latexmk");
      sendToRenderer("env:checkResult", { command: "lualatex", available: lualatex });
      sendToRenderer("env:checkResult", { command: "latexmk", available: latexmk });
    } else if (target === "latexmk") {
      const available = await envService.checkCommand("latexmk");
      sendToRenderer("env:checkResult", { command: "latexmk", available });
    }
  };

  const handleAlchemySettingsGet = async () => {
    const settings = await ensureUserSettings().getAlchemySettings();
    sendToRenderer("alchemy:settings", { settings });
    registerCaptureShortcut(settings.shortcut);
  };

  const handleAlchemySettingsSet = async (partial) => {
    const settings = await ensureUserSettings().updateAlchemySettings(partial);
    sendToRenderer("alchemy:settings", { settings });
    registerCaptureShortcut(settings.shortcut);
  };

  const readPdfBuffer = (formats) => {
    const candidates = [];
    const detected = formats.find((format) => format.toLowerCase().includes("pdf"));
    if (detected) {
      candidates.push(detected);
    }
    ["application/pdf", "public.pdf", "com.adobe.pdf"].forEach((format) => {
      if (!candidates.includes(format)) {
        candidates.push(format);
      }
    });
    for (const format of candidates) {
      try {
        const buffer = clipboard.readBuffer(format);
        if (buffer && buffer.length > 0) {
          return buffer;
        }
      } catch {
        // ignore PDF read failures
      }
    }
    return null;
  };

  const handleAlchemyClipboardRead = (requestId) => {
    const formats = clipboard.availableFormats();
    const payload = { requestId, formats };
    const text = clipboard.readText();
    if (text) {
      payload.text = text;
    }
    const html = clipboard.readHTML();
    if (html) {
      payload.html = html;
    }
    const image = clipboard.readImage();
    if (image && !image.isEmpty()) {
      payload.imageDataUrl = image.toDataURL();
    }
    const pdfBuffer = readPdfBuffer(formats);
    if (pdfBuffer) {
      payload.pdfBase64 = pdfBuffer.toString("base64");
    }
    sendToRenderer("alchemy:clipboard", payload);
  };

  const handleAlchemySaveImage = async (payload) => {
    const requestId = payload?.requestId ?? null;
    const dataUrl = typeof payload?.dataUrl === "string" ? payload.dataUrl : "";
    const rootPath = workspace.getRootPath();
    if (!rootPath) {
      sendToRenderer("alchemy:image-saved", {
        requestId,
        ok: false,
        error: WorkspaceError.invalidPath,
      });
      return;
    }
    if (!dataUrl) {
      sendToRenderer("alchemy:image-saved", {
        requestId,
        ok: false,
        error: "画像データが空です。",
      });
      return;
    }
    const image = nativeImage.createFromDataURL(dataUrl);
    let buffer = null;
    let normalizedExt = null;
    if (image.isEmpty()) {
      const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
      if (!match) {
        sendToRenderer("alchemy:image-saved", {
          requestId,
          ok: false,
          error: "画像データの読み込みに失敗しました。",
        });
        return;
      }
      const mime = match[1].toLowerCase();
      if (!mime.startsWith("image/")) {
        sendToRenderer("alchemy:image-saved", {
          requestId,
          ok: false,
          error: "画像データの読み込みに失敗しました。",
        });
        return;
      }
      const base64 = match[2];
      buffer = Buffer.from(base64, "base64");
      const rawExt = mime.split("/")[1] ?? "png";
      if (rawExt === "jpeg" || rawExt === "jpg") {
        normalizedExt = "jpg";
      } else if (rawExt === "svg+xml") {
        normalizedExt = "svg";
      } else {
        normalizedExt = rawExt;
      }
    } else {
      const match = dataUrl.match(/^data:image\/([a-zA-Z0-9+]+);/);
      const ext = match?.[1]?.toLowerCase() ?? "png";
      normalizedExt = ext === "jpeg" || ext === "jpg" ? "jpg" : "png";
      buffer = normalizedExt === "jpg" ? image.toJPEG(92) : image.toPNG();
    }
    if (!buffer || !normalizedExt) {
      sendToRenderer("alchemy:image-saved", {
        requestId,
        ok: false,
        error: "画像データの読み込みに失敗しました。",
      });
      return;
    }
    const fileName = `capture-${Date.now()}-${Math.random().toString(16).slice(2, 6)}.${normalizedExt}`;
    const dirPath = resolveWorkspacePath("images");
    const filePath = path.join(dirPath, fileName);
    try {
      await fsp.mkdir(dirPath, { recursive: true });
      await fsp.writeFile(filePath, buffer);
      await updateWorkspaceIfNeeded(rootPath, true);
      sendToRenderer("alchemy:image-saved", {
        requestId,
        ok: true,
        path: `images/${fileName}`,
      });
    } catch (error) {
      sendToRenderer("alchemy:image-saved", {
        requestId,
        ok: false,
        error: error?.message ?? "画像の保存に失敗しました。",
      });
    }
  };

  const handleBlocksSave = async (entry) => {
    const rootPath = workspace.getRootPath();
    if (!rootPath) {
      return;
    }
    let blocks = [];
    try {
      blocks = await blocksStore.load(rootPath);
    } catch {
      blocks = [];
    }
    if (entry && typeof entry === "object") {
      blocks.push(entry);
    }
    await blocksStore.save(rootPath, blocks);
  };

  return {
    handleEnvCheck,
    handleEnvInstall,
    handleAlchemySettingsGet,
    handleAlchemySettingsSet,
    handleAlchemyClipboardRead,
    handleAlchemySaveImage,
    handleBlocksSave,
  };
};

module.exports = { createMiscHandlers };
