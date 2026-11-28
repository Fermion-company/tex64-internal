// Where the caret is, as far as the suggest list is concerned, and which key
// accepts a suggestion. Pure functions shared by the texlab provider, the user
// snippet provider and the editor's Tab handler.

// texlab builds its LaTeX-kernel environment list from every "\foo"/"\endfoo"
// macro pair, so after "\begin{" it also offers "input" (\input/\endinput),
// "csname" (\csname/\endcsname) and "line" (\line/\endline). None of them is
// an environment: typing "\begin{i" put "input" at the top of the list, and
// accepting it wrote "\begin{input}". Only texlab's own kernel entries (detail
// "built-in") are dropped; an environment the document defines under one of
// these names is kept, and the commands \input, \line, \csname are untouched.
const TEXLAB_KERNEL_NON_ENVIRONMENTS = new Set(["csname", "input", "line"]);

// True when the caret is in the name argument of "\begin{...}" / "\end{...}".
export const isEnvironmentNameContext = (textBeforeCaret: string): boolean =>
  /\\(?:begin|end)\s*\{[^{}\\]*$/.test(textBeforeCaret);

// True when the caret is in the name argument of "\begin{...}" only.
export const isBeginNameContext = (textBeforeCaret: string): boolean =>
  /\\begin\s*\{[^{}\\]*$/.test(textBeforeCaret);

export const dropNonEnvironmentItems = <T>(items: T[], textBeforeCaret: string): T[] => {
  if (!isEnvironmentNameContext(textBeforeCaret)) {
    return items;
  }
  return items.filter((item) => {
    const { label, detail } = (item ?? {}) as { label?: unknown; detail?: unknown };
    return !(
      detail === "built-in" &&
      typeof label === "string" &&
      TEXLAB_KERNEL_NON_ENVIRONMENTS.has(label)
    );
  });
};

// Arguments that take a name the document or the disk already has: an
// environment, a label, a citation key, a file. A user snippet expanded there
// would put its body inside the braces, so snippets are not offered.
const NAME_ARGUMENT_COMMANDS = [
  "begin",
  "end",
  "[A-Za-z]*ref", // \ref \eqref \pageref \autoref \cref \Cref \vref \nameref \labelcref …
  "[A-Za-z]*cite[A-Za-z]*", // \cite \citep \citet \parencite \textcite \autocite \nocite \citeauthor …
  "input",
  "include",
  "includeonly",
  "includegraphics",
  "includepdf",
  "includestandalone",
  "subfile",
  "import",
  "subimport",
  "inputfrom",
  "subinputfrom",
  "includefrom",
  "subincludefrom",
  "bibliography",
  "addbibresource",
  "lstinputlisting",
  "verbatiminput",
  "inputminted",
];
const NAME_ARGUMENT_CONTEXT = new RegExp(
  `\\\\(?:${NAME_ARGUMENT_COMMANDS.join("|")})\\*?(?:\\[[^\\]]*\\])*(?:\\{[^{}]*\\})*\\{[^{}]*$`
);

export const isNameArgumentContext = (textBeforeCaret: string): boolean =>
  NAME_ARGUMENT_CONTEXT.test(textBeforeCaret);

// monaco drops an item without a label with a console warning
// ("did IGNORE invalid completion item"); texlab can send one in \ref{…} and
// \input{…} lists.
export const keepNamedItems = <T>(items: T[]): T[] =>
  items.filter((item) => {
    const label = (item as { label?: unknown } | null)?.label;
    return typeof label === "string" && label.trim() !== "";
  });

// Environment names the document defines. texlab offers a defined environment
// only once a "\begin{…}" uses it, so a fresh "\newenvironment{PartItems}"
// was missing from the "\begin{" list.
const ENVIRONMENT_DEFINITION =
  /\\(?:newenvironment|renewenvironment|provideenvironment|NewDocumentEnvironment|RenewDocumentEnvironment|ProvideDocumentEnvironment|DeclareDocumentEnvironment|DeclareTColorBox|NewTColorBox|RenewTColorBox|ProvideTColorBox|newtcolorbox|renewtcolorbox|newtheorem)\*?\s*(?:\[[^\]\r\n]*\]\s*)?\{\s*([^{}\\#%\s]+)\s*\}/g;

const withoutComment = (line: string): string => {
  for (let index = line.indexOf("%"); index >= 0; index = line.indexOf("%", index + 1)) {
    let slashes = 0;
    for (let back = index - 1; back >= 0 && line[back] === "\\"; back -= 1) slashes += 1;
    if (slashes % 2 === 0) return line.slice(0, index);
  }
  return line;
};

export const findDefinedEnvironments = (text: string): string[] => {
  const names = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.includes("\\")) continue;
    const line = withoutComment(raw);
    ENVIRONMENT_DEFINITION.lastIndex = 0;
    for (let match = ENVIRONMENT_DEFINITION.exec(line); match; match = ENVIRONMENT_DEFINITION.exec(line)) {
      names.add(match[1]);
    }
  }
  return [...names];
};

// What the editor host does with a key before monaco sees it: "swallow" it,
// run a suggest command, or leave it (null). While an IME composition is open
// no Tab or Enter may reach monaco or the editing helpers, whatever the key
// event says: accepting a suggestion or breaking the line there made the
// composed text commit twice. Keys the IME itself processes (isComposing,
// keyCode 229) are left to the IME.
export const editorKeyCapture = (
  event: { key: string; shiftKey?: boolean; isComposing?: boolean; keyCode?: number },
  state: { suggestVisible: boolean; composing: boolean }
): string | null => {
  const imeKey = Boolean(event.isComposing) || event.keyCode === 229;
  if (state.composing && !imeKey && (event.key === "Tab" || event.key === "Enter")) {
    return "swallow";
  }
  return suggestTabCommand(
    { ...event, isComposing: imeKey || state.composing },
    state.suggestVisible && event.key === "Tab"
  );
};

// The command the editor runs for a key while the suggest list is open, or
// null to leave the key alone. Enter stays a line break
// (acceptSuggestionOnEnter "off"), so Tab accepts; a Tab that belongs to an
// IME composition is left to the IME.
export const suggestTabCommand = (
  event: { key: string; shiftKey?: boolean; isComposing?: boolean; keyCode?: number },
  suggestVisible: boolean
): string | null => {
  if (event.key !== "Tab" || !suggestVisible) {
    return null;
  }
  if (event.isComposing || event.keyCode === 229) {
    return null;
  }
  return event.shiftKey ? "selectPrevSuggestion" : "acceptSelectedSuggestion";
};
