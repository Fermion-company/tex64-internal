import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const repoRoot = path.resolve(__dirname, "..", "..", "..");
export const sourceWorkspace = path.join(repoRoot, "test-workspace");

export const keepWorkspace = process.env.E2E_KEEP_WORKSPACE === "1";
export const verboseDebug = process.env.E2E_DEBUG === "1";
export const stepDelayMs = Number.parseInt(process.env.E2E_STEP_DELAY_MS ?? "120", 10);
export const typeDelayMs = Number.parseInt(process.env.E2E_TYPE_DELAY_MS ?? "30", 10);
export const slowMoMs = Number.parseInt(process.env.E2E_PLAYWRIGHT_SLOWMO_MS ?? "0", 10);

export const isMac = process.platform === "darwin";
export const selectAllShortcut = isMac ? "Meta+A" : "Control+A";
export const explicitSuggestShortcut = isMac ? "Meta+." : "Control+.";

export const now = () => new Date().toISOString().slice(11, 19);
export const log = (message) => {
  console.log(`[math-wysiwyg-ui-e2e ${now()}] ${message}`);
};

export const pause = async (ms = stepDelayMs) => {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
};

export const normalizeLatex = (value) => String(value ?? "").replace(/\s+/g, "");

