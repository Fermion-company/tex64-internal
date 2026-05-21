// Binds the settings-page font controls to the editor settings store. Kept
// self-contained (looks up its own DOM by id) so the store stays the single
// source of truth and we don't thread font state through the legacy settings-ui
// ops. Call once at startup after the DOM exists.

import { editorSettings, MIN_FONT_SIZE, MAX_FONT_SIZE } from "./editor-settings-store.js";

export const initEditorSettingsControls = (): void => {
  const familySelect = document.getElementById("editor-font-family");
  const sizeInput = document.getElementById("editor-font-size");

  if (familySelect instanceof HTMLSelectElement) {
    familySelect.value = editorSettings.getFontFamilyRaw();
    familySelect.addEventListener("change", () => {
      editorSettings.setFontFamily(familySelect.value);
    });
  }

  if (sizeInput instanceof HTMLInputElement) {
    sizeInput.min = String(MIN_FONT_SIZE);
    sizeInput.max = String(MAX_FONT_SIZE);
    sizeInput.value = String(editorSettings.getFontSize());
    sizeInput.addEventListener("change", () => {
      editorSettings.setFontSize(Number(sizeInput.value));
      // Reflect the clamped value back into the control.
      sizeInput.value = String(editorSettings.getFontSize());
    });
  }
};
