import type { IssueItem } from "./types.js";
import { uiText } from "./i18n.js";

type ResolutionRule = {
  test: (issue: IssueItem, message: string) => boolean;
  // Lazy: resolved at display time so the locale is the user's current one,
  // not whatever was active when this module happened to be imported.
  // The AI is told this with each recent problem.
  resolution: () => string;
  // What the problem card shows behind its ▾ when it differs from
  // `resolution`: "" where the advice adds nothing the card and the log do
  // not already say.
  shown?: () => string;
};

const NOT_SHOWN = () => "";

const rules: ResolutionRule[] = [
  {
    test: (_issue, message) => message.includes("work space"),
    resolution: () => uiText("Select a working folder from \"Open Folder\".", "Select the working folder from \"Open Folder\"."),
    shown: NOT_SHOWN,
  },
  {
    test: (_issue, message) => message.includes("Native integration"),
    resolution: () => uiText("Make sure it is opened in the desktop app, then restart.", "Make sure it's open in the desktop app and try restarting."),
  },
  {
    test: (issue, message) =>
      issue.action === "open-runtime" || message.includes("TeX environment"),
    resolution: () => uiText("Open Settings > Build and click \"Install\" for the missing tool.", "Open Settings > Build and click \"Install\" for missing tools."),
  },
  {
    test: (_issue, message) => message.includes("latexmk"),
    resolution: () => uiText("Check the status of latexmk in Settings > Build and click \"Install\".", "設定 > ビルド でlatexmkの状態を確認し、「インストール」をクリックしてください。"),
  },
  {
    test: (_issue, message) => message.includes("latexindent"),
    resolution: () => uiText("Check the status of latexindent in Settings > Build. You can turn formatting off in settings if needed.", "Check the status of latexindent in Settings > Build. You can disable formatting in settings if not needed."),
  },
  {
    test: (_issue, message) => message.includes("Format"),
    resolution: () => uiText("Review your formatting settings or turn formatting off and save again.", "Please review your formatting settings or turn formatting off and resave."),
  },
  {
    test: (_issue, message) => message.includes("Failed to start build"),
    resolution: () => uiText("Check that TeX Distribution and latexmk are detected in Settings > Build. Click \"Install\" if they are missing.", "Check that TeX Distribution and latexmk are detected in Settings > Build. Click \"Install\" if not detected."),
  },
  {
    test: (_issue, message) => message.includes("build failed"),
    resolution: () => uiText("Check the build log, fix the relevant file, and rebuild.", "Please check the build log, correct any errors in the relevant file, and rebuild."),
    shown: NOT_SHOWN,
  },
  {
    test: (_issue, message) =>
      /class\s+revtex4-2\s+warning:\s+no type size specified/i.test(message),
    resolution: () => uiText("Specify a font-size option in documentclass (for example: \\documentclass[10pt]{revtex4-2}).", "Please specify the font size in the documentclass option (e.g. \\documentclass[10pt]{revtex4-2})."
    ),
  },
  {
    test: (_issue, message) => /(?:package\s+)?xypdf\s+error:/i.test(message),
    resolution: () => uiText("qcircuit/xypic may fail with lualatex. Change the Engine in Settings > Build to pdflatex and rebuild.", "qcircuit/xypic may fail with lualatex. Please change the Engine in Settings > Build to pdflatex and rebuild."
    ),
  },
  {
    test: (_issue, message) =>
      message.includes("SyncTeX") || message.toLowerCase().includes("synctex"),
    resolution: () => uiText("Build the PDF and run SyncTeX on the .tex file.", "Build to generate PDF and run SyncTeX on the .tex file."),
  },
  {
    test: (_issue, message) => message.includes("PDF not found"),
    resolution: () => uiText("Run a build to generate the PDF.", "Run the build and generate the PDF."),
    shown: NOT_SHOWN,
  },
  {
    test: (_issue, message) =>
      message.includes("can't open file") || message.includes("not found"),
    resolution: () => uiText("Check the file path and existence, then open it again.", "Please check the existence and path of the file and try opening it again."),
  },
  {
    test: (_issue, message) => message.includes("Failed to save"),
    resolution: () => uiText("Check destination permissions and disk space, then try again.", "Please check the permissions and disk space of the save destination and try again."),
  },
  {
    test: (_issue, message) => message.includes("This file format cannot be edited"),
    resolution: () => uiText("Open a text file such as .tex and edit it.", ".texなどのテキストファイルを開いて編集してください。"),
    shown: NOT_SHOWN,
  },
  {
    test: (_issue, message) =>
      message.includes("The block is .tex") || message.includes("Paste is .tex"),
    resolution: () => uiText("Open a .tex file and try again.", "Please open the .tex file and try again."),
    shown: NOT_SHOWN,
  },
  {
    test: (_issue, message) => message.includes("screen capture"),
    resolution: () => uiText("Allow TeX64 in System Settings > Privacy & Security > Screen Recording, then restart the app.", "システム設定 > プライバシーとセキュリティ > 画面収録 でTeX64を許可し、アプリを再起動してください。"),
  },
  {
    test: (_issue, message) =>
      message.includes("Screen recording") ||
      message.includes("Window list") ||
      message.includes("Captureable window"),
    resolution: () => uiText("Allow TeX64 in System Settings > Privacy & Security > Screen Recording, then restart the app. Click Formula import again to open the settings guide.", "Allow TeX64 in System Settings > Privacy & Security > Screen Recording, then restart the app. Click \"Formula import\" again to open the settings guide."),
    shown: () => uiText("Allow TeX64 in System Settings > Privacy & Security > Screen Recording, then restart the app.", "システム設定 > プライバシーとセキュリティ > 画面収録 でTeX64を許可し、アプリを再起動してください。"),
  },
  {
    test: (_issue, message) => message.includes("failed to cut"),
    resolution: () => uiText("Reselect the capture area and try again.", "Please reselect the capture range and try again."),
  },
  {
    test: (_issue, message) => message.includes("OCR"),
    resolution: () => uiText("Retake the image and make sure the text and formulas are clear.", "Please re-obtain the image and check that the characters and formulas are clearly visible."),
  },
  {
    test: (_issue, message) =>
      message.includes("character not detected") ||
      message.includes("Analysis failure") ||
      message.includes("No image available"),
    resolution: () => uiText("Retake the image, increase the contrast, and try importing again.", "Please retake the image, increase the contrast and re-import it."),
  },
  {
    test: (_issue, message) => message.includes("Unsupported file formats"),
    resolution: () => uiText("Select an image file such as PNG or JPEG and try again.", "Please select an image file such as PNG/JPEG and try again."),
  },
  {
    test: (_issue, message) => message.includes("Full storage capacity"),
    resolution: () => uiText("Free up space by deleting unnecessary files and caches.", "Please free up space by deleting unnecessary files and caches."),
  },
  {
    test: (_issue, message) => message.includes("enter name"),
    resolution: () => uiText("Enter a non-empty name.", "Please enter your name so that it is not blank."),
    shown: NOT_SHOWN,
  },
  {
    test: (_issue, message) =>
      message.includes("Absolute path cannot be used") ||
      message.includes("Names that include parent directories cannot be used") ||
      message.includes("Trailing / cannot be used") ||
      message.includes("/ cannot be used in name"),
    resolution: () => uiText("Enter a relative path within the workspace, without / or ..", "ワークスペース内の相対パスで、/ や .. を含めずに入力してください。"),
  },
  {
    test: (_issue, message) => message.includes("Invalid destination"),
    resolution: () => uiText("Check the destination folder and move it somewhere else.", "Please check the destination folder and move to another location."),
    shown: NOT_SHOWN,
  },
  {
    test: (_issue, message) => message.includes("There are unsaved changes"),
    resolution: () => uiText("Save the relevant file before moving or renaming it.", "Please save the relevant file before moving/renaming."),
  },
];

const warningFallback: ResolutionRule = {
  test: () => true,
  resolution: () => uiText("Warnings may not automatically identify the destination. Check the surrounding lines in the build log and fix it.", "Warnings may not be able to automatically identify the destination. Please check the preceding and following lines in the build log and correct it."
  ),
};

const errorFallback: ResolutionRule = {
  test: () => true,
  resolution: () => uiText("Check the log and the relevant line, then fix it.", "Please check the log and the relevant line and correct it."),
  shown: NOT_SHOWN,
};

const ruleFor = (issue: IssueItem, message: string) =>
  rules.find((rule) => rule.test(issue, message)) ??
  (issue.severity === "warning" ? warningFallback : errorFallback);

// For the AI: the advice that goes with each recent problem.
export const getIssueResolution = (issue: IssueItem) => {
  const message = issue.message?.trim() ?? "";
  if (!message) {
    return null;
  }
  return ruleFor(issue, message).resolution();
};

// For the problem card: what its ▾ opens, "" for no ▾.
export const getShownIssueResolution = (issue: IssueItem) => {
  const message = issue.message?.trim() ?? "";
  if (!message) {
    return "";
  }
  const rule = ruleFor(issue, message);
  return (rule.shown ?? rule.resolution)();
};
