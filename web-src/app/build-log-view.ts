/**
 * Turns a TeX transcript into something you can skim.
 *
 * The .log file is thousands of lines of package banners and font paths with
 * the few lines that matter buried somewhere inside. Marking those lines is
 * what makes the log usable without knowing where TeX puts things.
 */
export type BuildLogSeverity = "error" | "warning" | "context";

export type BuildLogSegment = {
  text: string;
  /** null for the ordinary noise between the interesting lines. */
  severity: BuildLogSeverity | null;
};

// `-file-line-error` prefixes real errors with "./main.tex:31:", which hides
// the keyword from an anchored test.
const LOCATION_PREFIX = /^(?:\.[\\/])?[^\s:]+:\d+(?::\d+)?:\s*/;

const isErrorLine = (line: string) => {
  const text = line.trim().replace(LOCATION_PREFIX, "") || line.trim();
  const lower = text.toLowerCase();
  return (
    text.startsWith("!") ||
    /^(?:package|class|document class)\s+\S+\s+error:/i.test(text) ||
    /^\S+\s+error:/i.test(text) ||
    lower.includes("latex error") ||
    lower.includes("undefined control sequence") ||
    lower.includes("emergency stop") ||
    lower.includes("fatal error occurred") ||
    lower.includes("missing $ inserted")
  );
};

const isWarningLine = (line: string) => {
  const text = line.trim();
  const lower = text.toLowerCase();
  return (
    lower.includes(" warning:") ||
    lower.startsWith("warning:") ||
    lower.startsWith("overfull \\hbox") ||
    lower.startsWith("underfull \\hbox") ||
    lower.startsWith("overfull \\vbox") ||
    lower.startsWith("underfull \\vbox") ||
    lower.includes("missing character:")
  );
};

// TeX prints "l.42 \thecommand" straight after an error to show where it was
// standing. On its own it is meaningless; next to the error it is the answer.
const isContextLine = (line: string) => /^l\.\d+\s/.test(line.trim());

export const segmentBuildLog = (log: string): BuildLogSegment[] => {
  if (!log) {
    return [];
  }
  const segments: BuildLogSegment[] = [];
  let plain: string[] = [];
  const flushPlain = () => {
    if (plain.length > 0) {
      segments.push({ text: plain.join("\n"), severity: null });
      plain = [];
    }
  };
  let afterError = false;
  for (const line of log.split("\n")) {
    let severity: BuildLogSeverity | null = null;
    if (isErrorLine(line)) {
      severity = "error";
    } else if (isWarningLine(line)) {
      severity = "warning";
    } else if (afterError && isContextLine(line)) {
      severity = "context";
    }
    if (severity) {
      flushPlain();
      segments.push({ text: line, severity });
      afterError = severity !== "warning";
    } else {
      plain.push(line);
      if (line.trim()) {
        afterError = false;
      }
    }
  }
  flushPlain();
  return segments;
};

export const countMarkedLines = (segments: readonly BuildLogSegment[]) =>
  segments.filter((segment) => segment.severity !== null).length;

/**
 * Renders the segments into `host` and returns the first line worth looking at,
 * so the caller can scroll straight to it.
 */
export const renderBuildLog = (host: HTMLElement, log: string): HTMLElement | null => {
  const segments = segmentBuildLog(log);
  const fragment = document.createDocumentFragment();
  let firstError: HTMLElement | null = null;
  let firstMarked: HTMLElement | null = null;
  segments.forEach((segment) => {
    if (!segment.severity) {
      fragment.append(document.createTextNode(`${segment.text}\n`));
      return;
    }
    const mark = document.createElement("mark");
    mark.className = `build-log-line is-${segment.severity}`;
    mark.textContent = segment.text;
    fragment.append(mark, document.createTextNode("\n"));
    if (!firstMarked) {
      firstMarked = mark;
    }
    if (!firstError && segment.severity === "error") {
      firstError = mark;
    }
  });
  host.replaceChildren(fragment);
  return firstError ?? firstMarked;
};
