import type { IssueItem } from "./types.js";
import { uiText } from "./i18n.js";

type ResolutionRule = {
  test: (issue: IssueItem, message: string) => boolean;
  resolution: string;
};

const rules: ResolutionRule[] = [
  {
    test: (_issue, message) => message.includes("work space"),
    resolution: uiText("Select a working folder from \"Open Folder\".", "Select the working folder from \"Open Folder\"."),
  },
  {
    test: (_issue, message) => message.includes("Native integration"),
    resolution: uiText("Make sure it is opened in the desktop app, then restart.", "Make sure it's open in the desktop app and try restarting."),
  },
  {
    test: (issue, message) =>
      issue.action === "open-runtime" || message.includes("TeX environment"),
    resolution: uiText("Open Settings > Environment and click \"Install\" for the missing tool.", "Open Settings > Environment and click \"Install\" for missing tools."),
  },
  {
    test: (_issue, message) => message.includes("latexmk"),
    resolution: uiText("Check the status of latexmk in Settings > Environment and click \"Install\".", "設定 > 環境 で latexmk の状態を確認し、「インストール」をクリックしてください。"),
  },
  {
    test: (_issue, message) => message.includes("latexindent"),
    resolution: uiText("Check the status of latexindent in Settings > Environment. You can turn formatting off in settings if needed.", "Check the status of latexindent in Settings > Environment. You can disable formatting in settings if not needed."),
  },
  {
    test: (_issue, message) => message.includes("Format"),
    resolution: uiText("Review your formatting settings or turn formatting off and save again.", "Please review your formatting settings or turn formatting off and resave."),
  },
  {
    test: (_issue, message) => message.includes("Failed to start build"),
    resolution: uiText("Check that TeX Distribution and latexmk are detected in Settings > Environment. Click \"Install\" if they are missing.", "Check that TeX Distribution and latexmk are detected in Settings > Environment. Click \"Install\" if not detected."),
  },
  {
    test: (_issue, message) => message.includes("build failed"),
    resolution: uiText("Check the build log, fix the relevant file, and rebuild.", "Please check the build log, correct any errors in the relevant file, and rebuild."),
  },
  {
    test: (_issue, message) =>
      /class\s+revtex4-2\s+warning:\s+no type size specified/i.test(message),
    resolution: uiText(
      "Specify a font-size option in documentclass (for example: \\documentclass[10pt]{revtex4-2}).",
      "Please specify the font size in the documentclass option (e.g. \\documentclass[10pt]{revtex4-2})."
    ),
  },
  {
    test: (_issue, message) => /(?:package\s+)?xypdf\s+error:/i.test(message),
    resolution: uiText(
      "qcircuit/xypic may fail with lualatex. Change the Engine in Settings > Build to pdflatex and rebuild.",
      "qcircuit/xypic may fail with lualatex. Please change the Engine in Settings > Build to pdflatex and rebuild."
    ),
  },
  {
    test: (_issue, message) =>
      message.includes("SyncTeX") || message.toLowerCase().includes("synctex"),
    resolution: uiText("Build the PDF and run SyncTeX on the .tex file.", "Build to generate PDF and run SyncTeX on the .tex file."),
  },
  {
    test: (_issue, message) => message.includes("PDF not found"),
    resolution: uiText("Run a build to generate the PDF.", "Run the build and generate the PDF."),
  },
  {
    test: (_issue, message) =>
      message.includes("can't open file") || message.includes("not found"),
    resolution: uiText("Check the file path and existence, then open it again.", "Please check the existence and path of the file and try opening it again."),
  },
  {
    test: (_issue, message) => message.includes("Failed to save"),
    resolution: uiText("Check destination permissions and disk space, then try again.", "Please check the permissions and disk space of the save destination and try again."),
  },
  {
    test: (_issue, message) => message.includes("This file format cannot be edited"),
    resolution: uiText("Open a text file such as .tex and edit it.", ".tex などのテキストファイルを開いて編集してください。"),
  },
  {
    test: (_issue, message) =>
      message.includes("The block is .tex") || message.includes("Paste is .tex"),
    resolution: uiText("Open a .tex file and try again.", "Please open the .tex file and try again."),
  },
  {
    test: (_issue, message) => message.includes("screen capture"),
    resolution: uiText("Allow TeX64 in System Settings > Privacy & Security > Screen Recording, then restart the app.", "システム設定 > プライバシーとセキュリティ > 画面収録 で TeX64 を許可し、アプリを再起動してください。"),
  },
  {
    test: (_issue, message) =>
      message.includes("Screen recording") ||
      message.includes("Window list") ||
      message.includes("Captureable window"),
    resolution: uiText("Allow TeX64 in System Settings > Privacy & Security > Screen Recording, then restart the app. Click Formula import again to open the settings guide.", "Allow TeX64 in System Settings > Privacy & Security > Screen Recording, then restart the app. Click \"Formula import\" again to open the settings guide."),
  },
  {
    test: (_issue, message) => message.includes("failed to cut"),
    resolution: uiText("Reselect the capture area and try again.", "Please reselect the capture range and try again."),
  },
  {
    test: (_issue, message) => message.includes("OCR"),
    resolution: uiText("Retake the image and make sure the text and formulas are clear.", "Please re-obtain the image and check that the characters and formulas are clearly visible."),
  },
  {
    test: (_issue, message) =>
      message.includes("character not detected") ||
      message.includes("Analysis failure") ||
      message.includes("No image available"),
    resolution: uiText("Retake the image, increase the contrast, and try importing again.", "Please retake the image, increase the contrast and re-import it."),
  },
  {
    test: (_issue, message) => message.includes("Unsupported file formats"),
    resolution: uiText("Select an image file such as PNG or JPEG and try again.", "Please select an image file such as PNG/JPEG and try again."),
  },
  {
    test: (_issue, message) => message.includes("Full storage capacity"),
    resolution: uiText("Free up space by deleting unnecessary files and caches.", "Please free up space by deleting unnecessary files and caches."),
  },
  {
    test: (_issue, message) => message.includes("enter name"),
    resolution: uiText("Enter a non-empty name.", "Please enter your name so that it is not blank."),
  },
  {
    test: (_issue, message) =>
      message.includes("Absolute path cannot be used") ||
      message.includes("Names that include parent directories cannot be used") ||
      message.includes("Trailing / cannot be used") ||
      message.includes("/ cannot be used in name"),
    resolution: uiText("Enter a relative path within the workspace, without / or ..", "Please enter the path relative to your workspace without including / or ..."),
  },
  {
    test: (_issue, message) => message.includes("Invalid destination"),
    resolution: uiText("Check the destination folder and move it somewhere else.", "Please check the destination folder and move to another location."),
  },
  {
    test: (_issue, message) => message.includes("There are unsaved changes"),
    resolution: uiText("Save the relevant file before moving or renaming it.", "Please save the relevant file before moving/renaming."),
  },
];

export const getIssueResolution = (issue: IssueItem) => {
  const message = issue.message?.trim() ?? "";
  if (!message) {
    return null;
  }
  for (const rule of rules) {
    if (rule.test(issue, message)) {
      return rule.resolution;
    }
  }
  if (issue.severity === "warning") {
    return uiText(
      "Warnings may not automatically identify the destination. Check the surrounding lines in the build log and fix it.",
      "Warnings may not be able to automatically identify the destination. Please check the preceding and following lines in the build log and correct it."
    );
  }
  return uiText("Check the log and the relevant line, then fix it.", "Please check the log and the relevant line and correct it.");
};
