import { uiText } from "./i18n.js";
import { aiText } from "./ai-i18n.js";
/* ------------------------------------------------------------------ */
/*  KaTeX math rendering                                              */
/* ------------------------------------------------------------------ */
// Inline $...$ with currency guard: the delimiters must hug non-whitespace
// content ("$x$", not "$5 and $10"), and a closing $ directly followed by a
// digit is treated as currency, not as a math terminator.
const INLINE_DOLLAR_MATH = /(?<![\$\\])\$(?!\$)(?!\s)([^$\n]+?)(?<!\s)\$(?!\$)(?!\d)/g;
const renderMathInText = (html) => {
    const renderKatex = (expr, displayMode) => {
        try {
            return katex.renderToString(expr.trim(), { displayMode, throwOnError: false });
        }
        catch {
            return `<code>${expr}</code>`;
        }
    };
    // Display math first: $$...$$ and \[...\]
    html = html.replace(/\$\$([\s\S]+?)\$\$/g, (_match, expr) => renderKatex(expr, true));
    html = html.replace(/\\\[([\s\S]+?)\\\]/g, (_match, expr) => renderKatex(expr, true));
    // Inline math: \(...\) and $...$
    html = html.replace(/\\\(([\s\S]+?)\\\)/g, (_match, expr) => renderKatex(expr, false));
    html = html.replace(INLINE_DOLLAR_MATH, (_match, expr) => renderKatex(expr, false));
    return html;
};
/* ------------------------------------------------------------------ */
/*  Marked configuration                                              */
/* ------------------------------------------------------------------ */
const escapeHtml = (text) => text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
/* ------------------------------------------------------------------ */
/*  LaTeX syntax highlighter (Monaco-aligned colors)                  */
/* ------------------------------------------------------------------ */
const LATEX_ENV_KEYWORDS = new Set([
    "begin", "end", "documentclass", "usepackage",
]);
const LATEX_KEYWORDS = new Set([
    ...LATEX_ENV_KEYWORDS,
    "newcommand", "renewcommand", "newenvironment", "renewenvironment",
    "def", "let", "providecommand",
    "section", "subsection", "subsubsection", "chapter", "part",
    "paragraph", "subparagraph",
    "title", "author", "date", "maketitle", "tableofcontents", "appendix",
    "label", "ref", "eqref", "pageref", "cite", "nocite",
    "bibliography", "bibliographystyle",
    "input", "include", "includegraphics",
    "caption", "footnote", "footnotetext", "footnotemark",
    "textbf", "textit", "texttt", "textrm", "textsf", "textsc",
    "emph", "underline", "textcolor",
    "centering", "raggedright", "raggedleft",
    "hspace", "vspace", "hfill", "vfill", "newline", "newpage",
    "item", "frac", "sqrt", "sum", "prod", "int", "lim",
    "alpha", "beta", "gamma", "delta", "epsilon", "theta", "lambda",
    "mu", "pi", "sigma", "omega", "phi", "psi",
    "left", "right", "big", "Big", "bigg", "Bigg",
]);
const highlightLatex = (code) => {
    let result = "";
    let i = 0;
    while (i < code.length) {
        // ── Comment: % to end of line ──
        if (code[i] === "%") {
            const end = code.indexOf("\n", i);
            const slice = end === -1 ? code.slice(i) : code.slice(i, end);
            result += `<span class="hl-comment">${escapeHtml(slice)}</span>`;
            i += slice.length;
            continue;
        }
        // ── Command: \name ──
        if (code[i] === "\\") {
            const m = code.slice(i).match(/^\\([a-zA-Z@]+)/);
            if (m) {
                const name = m[1];
                const cls = LATEX_KEYWORDS.has(name) ? "hl-keyword" : "hl-command";
                result += `<span class="${cls}">${escapeHtml(m[0])}</span>`;
                i += m[0].length;
                // After env-keywords, color {arg} as type
                if (LATEX_ENV_KEYWORDS.has(name)) {
                    // optional whitespace
                    const ws = code.slice(i).match(/^(\s*)/);
                    if (ws && ws[1]) {
                        result += escapeHtml(ws[1]);
                        i += ws[1].length;
                    }
                    // optional [...]
                    if (code[i] === "[") {
                        const close = code.indexOf("]", i);
                        if (close !== -1) {
                            result += `<span class="hl-delimiter">[</span>`;
                            result += escapeHtml(code.slice(i + 1, close));
                            result += `<span class="hl-delimiter">]</span>`;
                            i = close + 1;
                        }
                    }
                    // optional whitespace
                    const ws2 = code.slice(i).match(/^(\s*)/);
                    if (ws2 && ws2[1]) {
                        result += escapeHtml(ws2[1]);
                        i += ws2[1].length;
                    }
                    // {envname}
                    if (code[i] === "{") {
                        const close = code.indexOf("}", i);
                        if (close !== -1) {
                            result += `<span class="hl-delimiter">{</span>`;
                            result += `<span class="hl-type">${escapeHtml(code.slice(i + 1, close))}</span>`;
                            result += `<span class="hl-delimiter">}</span>`;
                            i = close + 1;
                        }
                    }
                }
                continue;
            }
            // Escaped char: \\, \{, \}, \$, \%, etc.
            if (i + 1 < code.length) {
                result += `<span class="hl-command">${escapeHtml(code.slice(i, i + 2))}</span>`;
                i += 2;
                continue;
            }
        }
        // ── Delimiters: {, }, [, ], $ ──
        if ("{}[]$".includes(code[i])) {
            result += `<span class="hl-delimiter">${escapeHtml(code[i])}</span>`;
            i++;
            continue;
        }
        // ── Numbers ──
        if (/[0-9]/.test(code[i])) {
            const m = code.slice(i).match(/^[0-9]+(\.[0-9]+)?/);
            if (m) {
                result += `<span class="hl-number">${escapeHtml(m[0])}</span>`;
                i += m[0].length;
                continue;
            }
        }
        // ── Plain text: accumulate non-special chars ──
        let end = i + 1;
        while (end < code.length && !"\\%{}[]$0123456789".includes(code[end])) {
            end++;
        }
        result += escapeHtml(code.slice(i, end));
        i = end;
    }
    return result;
};
/* ------------------------------------------------------------------ */
/*  File / URL links                                                  */
/* ------------------------------------------------------------------ */
/**
 * Links the chat may render. `tex64-file:` targets are workspace-relative
 * paths (the Codex adapter rewrites its internal file citations into this
 * form); http(s) links open in the system browser. Anything else — including
 * javascript:, data: and file: — renders as plain text: the chat body is model
 * output, so nothing may become a navigable target by default.
 */
export const FILE_LINK_SCHEME = "tex64-file:";
const isWebUrl = (href) => /^https?:\/\//i.test(href);
/**
 * Codex's file-citation directive normally arrives already rewritten by the
 * desktop side, which resolves it against the workspace root. A citation can
 * still show up here mid-stream (the deltas are raw), so strip it to the bare
 * file name rather than letting the directive — and an absolute sandbox path —
 * flash in the transcript.
 */
const FILE_CITATION_PATTERN = /:codex-file-citation(?:\[[^\]]*\])?\{([^}]*)\}/g;
const stripFileCitations = (text) => {
    if (!text.includes(":codex-file-citation"))
        return text;
    return text.replace(FILE_CITATION_PATTERN, (_match, attributes) => {
        var _a, _b, _c, _d, _e;
        const cited = (_d = (_b = (_a = attributes.match(/path\s*=\s*"([^"]+)"/)) === null || _a === void 0 ? void 0 : _a[1]) !== null && _b !== void 0 ? _b : (_c = attributes.match(/path\s*=\s*([^\s,}]+)/)) === null || _c === void 0 ? void 0 : _c[1]) !== null && _d !== void 0 ? _d : "";
        const name = (_e = cited.split(/[\\/]/).pop()) !== null && _e !== void 0 ? _e : "";
        return name;
    });
};
const configureMarked = () => {
    const renderer = {
        code(token) {
            const lang = escapeHtml(token.lang || "text");
            const isLatex = /^(la)?tex$/i.test(token.lang || "");
            const code = isLatex ? highlightLatex(token.text) : escapeHtml(token.text);
            return (`<div class="ai-code-block">` +
                `<div class="ai-code-header">` +
                `<span class="ai-code-lang">${lang}</span>` +
                `<button class="ai-code-copy" type="button" data-copy>${uiText("Copy", "コピー")}</button>` +
                `</div>` +
                `<pre><code>${code}</code></pre>` +
                `</div>`);
        },
        codespan(token) {
            return `<code class="ai-inline-code">${escapeHtml(token.text)}</code>`;
        },
        // marked passes raw HTML through untouched by default. The chat body is
        // model output (and quotes file contents), so render it as visible text
        // instead of letting it become live DOM.
        html(token) {
            return escapeHtml(token.text);
        },
        link(token) {
            var _a, _b;
            const label = token.tokens && typeof ((_a = this.parser) === null || _a === void 0 ? void 0 : _a.parseInline) === "function"
                ? this.parser.parseInline(token.tokens)
                : escapeHtml(token.text);
            const href = (_b = token.href) !== null && _b !== void 0 ? _b : "";
            if (href.startsWith(FILE_LINK_SCHEME)) {
                const encoded = href.slice(FILE_LINK_SCHEME.length);
                let filePath = encoded;
                try {
                    filePath = decodeURI(encoded);
                }
                catch {
                    /* malformed escape: fall back to the raw target */
                }
                return (`<button type="button" class="ai-file-link" data-open-file="${escapeHtml(filePath)}"` +
                    ` title="${escapeHtml(filePath)}">${label}</button>`);
            }
            if (isWebUrl(href)) {
                // Opened through the shell, never by navigating the renderer.
                return `<a class="ai-external-link" href="#" data-open-url="${escapeHtml(href)}">${label}</a>`;
            }
            return label;
        },
        heading(token) {
            const level = Math.min(3, token.depth);
            return `<h${level} class="ai-md-heading ai-md-heading-${level}">${token.text}</h${level}>`;
        },
        list(token) {
            const tag = token.ordered ? "ol" : "ul";
            const items = token.items.map((item) => `<li>${this.parser.parse(item.tokens)}</li>`).join("");
            return `<${tag} class="ai-md-list">${items}</${tag}>`;
        },
        table(token) {
            const ths = token.header
                .map((h) => {
                const align = h.align ? ` style="text-align:${h.align}"` : "";
                return `<th${align}>${h.text}</th>`;
            })
                .join("");
            const bodyRows = token.rows
                .map((row) => {
                const tds = row
                    .map((cell) => {
                    const align = cell.align ? ` style="text-align:${cell.align}"` : "";
                    return `<td${align}>${cell.text}</td>`;
                })
                    .join("");
                return `<tr>${tds}</tr>`;
            })
                .join("");
            return (`<div class="ai-table-wrapper">` +
                `<table class="ai-md-table"><thead><tr>${ths}</tr></thead>` +
                `<tbody>${bodyRows}</tbody></table>` +
                `</div>`);
        },
    };
    marked.use({ renderer, gfm: true, breaks: false });
};
let markedConfigured = false;
/* ------------------------------------------------------------------ */
/*  Render markdown → HTML                                            */
/* ------------------------------------------------------------------ */
export const renderMarkdownHtml = (text) => {
    if (!markedConfigured) {
        configureMarked();
        markedConfigured = true;
    }
    // Shield code (fenced blocks and inline spans) from the math regexes:
    // LaTeX answers routinely contain \[ \] or $ inside ```tex fences, and
    // those must stay verbatim code, not become KaTeX.
    const codeSpans = [];
    let protected_ = stripFileCitations(text);
    protected_ = protected_.replace(/```[\s\S]*?(?:```|$)/g, (match) => {
        codeSpans.push(match);
        return `\x01CODE${codeSpans.length - 1}\x01`;
    });
    protected_ = protected_.replace(/`[^`\n]+`/g, (match) => {
        codeSpans.push(match);
        return `\x01CODE${codeSpans.length - 1}\x01`;
    });
    // Protect math blocks from marked's processing
    const mathBlocks = [];
    // Protect display math $$...$$ and \[...\]
    protected_ = protected_.replace(/\$\$([\s\S]+?)\$\$/g, (_match, expr) => {
        mathBlocks.push(`$$${expr}$$`);
        return `\x00MATH${mathBlocks.length - 1}\x00`;
    });
    protected_ = protected_.replace(/\\\[([\s\S]+?)\\\]/g, (_match, expr) => {
        mathBlocks.push(`\\[${expr}\\]`);
        return `\x00MATH${mathBlocks.length - 1}\x00`;
    });
    // Protect inline math \(...\) and $...$
    protected_ = protected_.replace(/\\\(([\s\S]+?)\\\)/g, (_match, expr) => {
        mathBlocks.push(`\\(${expr}\\)`);
        return `\x00MATH${mathBlocks.length - 1}\x00`;
    });
    protected_ = protected_.replace(INLINE_DOLLAR_MATH, (_match, expr) => {
        mathBlocks.push(`$${expr}$`);
        return `\x00MATH${mathBlocks.length - 1}\x00`;
    });
    // Restore code before parsing so marked renders it as normal code.
    protected_ = protected_.replace(/\x01CODE(\d+)\x01/g, (_match, idx) => { var _a; return (_a = codeSpans[Number(idx)]) !== null && _a !== void 0 ? _a : ""; });
    // Parse markdown
    let html;
    try {
        html = marked.parse(protected_);
    }
    catch {
        html = escapeHtml(text);
    }
    // Restore and render math
    html = html.replace(/\x00MATH(\d+)\x00/g, (_match, idx) => {
        var _a;
        const original = (_a = mathBlocks[Number(idx)]) !== null && _a !== void 0 ? _a : "";
        return renderMathInText(original);
    });
    return html;
};
/* ------------------------------------------------------------------ */
/*  Copy button handler                                               */
/* ------------------------------------------------------------------ */
const attachCopyHandlers = (container) => {
    container.querySelectorAll("[data-copy]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            var _a, _b, _c;
            e.stopPropagation();
            const code = (_c = (_b = (_a = btn.closest(".ai-code-block")) === null || _a === void 0 ? void 0 : _a.querySelector("code")) === null || _b === void 0 ? void 0 : _b.textContent) !== null && _c !== void 0 ? _c : "";
            navigator.clipboard.writeText(code).then(() => {
                btn.textContent = uiText("Copied", "コピー済み");
                setTimeout(() => { btn.textContent = uiText("Copy", "コピー"); }, 1500);
            }, () => { });
        });
    });
};
/* ------------------------------------------------------------------ */
/*  DOM helpers                                                       */
/* ------------------------------------------------------------------ */
/** Chars beyond which a user message is collapsed behind a "Show more". */
const LONG_USER_MESSAGE_CHARS = 600;
// Thoughts and tool activity are stored as system lines with these marks;
// the chat folds a run of them into one collapsed work log.
const THOUGHT_MARK = "\u{1F4AD} ";
const TOOL_MARK = "\u{1F527} ";
export const isTraceMessage = (message) => message.role === "system" &&
    (message.text.startsWith(THOUGHT_MARK) || message.text.startsWith(TOOL_MARK));
export const traceLineText = (text) => text.startsWith(THOUGHT_MARK) || text.startsWith(TOOL_MARK) ? text.slice(THOUGHT_MARK.length) : text;
export const formatRelativeTime = (createdAt) => {
    if (typeof createdAt !== "number" || !Number.isFinite(createdAt))
        return "";
    const minutes = Math.floor(Math.max(0, Date.now() - createdAt) / 60000);
    if (minutes < 1)
        return aiText("time_now");
    if (minutes < 60)
        return aiText("time_minutes").replace("{n}", String(minutes));
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return aiText("time_hours").replace("{n}", String(hours));
    return aiText("time_days").replace("{n}", String(Math.floor(hours / 24)));
};
const ICONS = {
    copy: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
    retry: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>',
    up: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 11v9H4v-9zM7 11l4-8a2 2 0 0 1 2 2v4h5a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 16.8 20H7"/></svg>',
    down: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 13V4h3v9zM17 13l-4 8a2 2 0 0 1-2-2v-4H6a2 2 0 0 1-2-2.3l1.2-6A2 2 0 0 1 7.2 4H17"/></svg>',
    branch: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 7v10M6 17c0-4 12-2 12-6"/></svg>',
    send: '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><polygon points="7,4 19,12 7,20"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};
const ACTION_ICON = {
    copy: ICONS.copy,
    retry: ICONS.retry,
    "rate-up": ICONS.up,
    "rate-down": ICONS.down,
    branch: ICONS.branch,
};
const createActionButton = (action, label) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ai-message-action";
    button.dataset.aiAction = action;
    button.setAttribute("aria-label", label);
    button.title = label;
    button.innerHTML = ACTION_ICON[action];
    return button;
};
/** A line of the work log: what the agent read, wrote, or ran. */
export const createTraceLineElement = (message) => {
    const line = document.createElement("div");
    line.className = "ai-trace-line";
    line.textContent = traceLineText(message.text);
    return line;
};
/* ------------------------------------------------------------------ */
/*  Next steps and questions under a reply                            */
/* ------------------------------------------------------------------ */
/**
 * The steps the agent offered: rows the reader can send as they are. The
 * newest set answers to Tab and Enter; older sets stay clickable.
 */
export const createNextStepsElement = (steps, latest) => {
    const root = document.createElement("div");
    root.className = `ai-next-steps${latest ? " is-latest" : ""}`;
    const list = document.createElement("div");
    list.className = "ai-next-list";
    steps.forEach((step, index) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "ai-step-row";
        row.dataset.aiStepId = step.id;
        row.dataset.aiRequest = step.request;
        row.dataset.aiStepKind = step.kind === "mechanical" ? "mechanical" : "writing";
        if (step.asks)
            row.dataset.aiAsks = JSON.stringify(step.asks);
        if (Number.isFinite(step.line))
            row.dataset.aiLine = String(step.line);
        row.style.setProperty("--ai-row-index", String(index));
        row.title = step.asks ? step.asks.question : step.request;
        const number = document.createElement("span");
        number.className = "ai-step-index";
        number.textContent = String(index + 1);
        const text = document.createElement("span");
        text.className = "ai-step-text";
        const stepTitle = document.createElement("span");
        stepTitle.className = "ai-step-title";
        stepTitle.textContent = step.title;
        text.appendChild(stepTitle);
        if (step.scope) {
            const scope = document.createElement("span");
            scope.className = "ai-step-scope";
            scope.textContent = step.scope;
            text.appendChild(scope);
        }
        row.append(number, text);
        if (step.asks) {
            const mark = document.createElement("span");
            mark.className = "ai-step-asks";
            mark.textContent = "?";
            mark.title = step.asks.question;
            row.appendChild(mark);
        }
        list.appendChild(row);
    });
    root.appendChild(list);
    return root;
};
/**
 * The plan from Plan mode: steps with a checkbox each (all on), a line for
 * additions, and the button that starts the checked steps in Agent mode.
 */
export const createPlanElement = (plan, latest) => {
    const root = document.createElement("div");
    root.className = `ai-plan${latest ? " is-latest" : ""}`;
    root.dataset.aiPlan = "true";
    const title = document.createElement("div");
    title.className = "ai-plan-title";
    title.textContent = plan.title;
    root.appendChild(title);
    const list = document.createElement("div");
    list.className = "ai-plan-steps";
    plan.steps.forEach((step, index) => {
        const row = document.createElement("label");
        row.className = "ai-plan-step";
        const check = document.createElement("input");
        check.type = "checkbox";
        check.className = "ai-plan-check";
        check.checked = true;
        check.dataset.aiPlanStep = step.id;
        const number = document.createElement("span");
        number.className = "ai-step-index";
        number.textContent = String(index + 1);
        const text = document.createElement("span");
        text.className = "ai-plan-text";
        const head = document.createElement("span");
        head.className = "ai-plan-step-title";
        head.textContent = step.where ? `${step.title} · ${step.where}` : step.title;
        const what = document.createElement("span");
        what.className = "ai-plan-step-what";
        what.textContent = step.what;
        text.append(head, what);
        if (step.asks) {
            const ask = document.createElement("span");
            ask.className = "ai-plan-step-asks";
            ask.textContent = step.asks.question;
            text.appendChild(ask);
        }
        row.append(check, number, text);
        list.appendChild(row);
    });
    root.appendChild(list);
    const note = document.createElement("textarea");
    note.className = "ai-plan-note";
    note.rows = 1;
    note.placeholder = aiText("plan_note_placeholder");
    root.appendChild(note);
    const actions = document.createElement("div");
    actions.className = "ai-plan-actions";
    const run = document.createElement("button");
    run.type = "button";
    run.className = "panel-button ai-plan-run";
    run.dataset.aiPlanRun = "true";
    run.textContent = aiText("plan_run");
    actions.appendChild(run);
    root.appendChild(actions);
    return root;
};
/** The request that runs a reviewed plan: the checked steps, then the note. */
export const readPlanRequest = (planEl, plan) => {
    var _a, _b;
    const checked = new Set(Array.from(planEl.querySelectorAll("input.ai-plan-check"))
        .filter((input) => input.checked)
        .map((input) => { var _a; return (_a = input.dataset.aiPlanStep) !== null && _a !== void 0 ? _a : ""; }));
    const lines = plan.steps
        .filter((step) => checked.has(step.id))
        .map((step, index) => `${index + 1}. ${step.title}${step.where ? ` (${step.where})` : ""}: ${step.what}`);
    const note = (_b = (_a = planEl.querySelector(".ai-plan-note")) === null || _a === void 0 ? void 0 : _a.value.trim()) !== null && _b !== void 0 ? _b : "";
    return `${aiText("plan_run_request")}\n\n${plan.title}\n${lines.join("\n")}${note ? `\n\n${aiText("plan_note_label")}: ${note}` : ""}`;
};
/**
 * A question the agent put to the reader: short fields, a choice, or a free
 * answer. Submitting sends the answer as the next message; a step's own
 * question sends the step's request together with the answer.
 */
export const createQuestionElement = (question, options = {}) => {
    const root = document.createElement("form");
    root.className = "ai-question";
    root.dataset.aiQuestion = "true";
    if (options.request)
        root.dataset.aiRequest = options.request;
    if (options.stepId)
        root.dataset.aiStepId = options.stepId;
    if (options.lead) {
        const lead = document.createElement("div");
        lead.className = "ai-question-lead";
        lead.textContent = options.lead;
        root.appendChild(lead);
    }
    const text = document.createElement("div");
    text.className = "ai-question-text";
    text.textContent = question.question;
    root.appendChild(text);
    const fields = Array.isArray(question.fields) ? question.fields : [];
    const choices = Array.isArray(question.options) ? question.options : [];
    if (fields.length > 0) {
        const grid = document.createElement("div");
        grid.className = "ai-question-fields";
        fields.forEach((field, index) => {
            const label = document.createElement("label");
            label.className = "ai-question-field";
            const name = document.createElement("span");
            name.className = "ai-question-field-label";
            name.textContent = field.label;
            const input = document.createElement("input");
            input.type = "text";
            input.className = "ai-question-input";
            input.name = field.key;
            input.dataset.aiFieldLabel = field.label;
            if (field.placeholder)
                input.placeholder = field.placeholder;
            if (index === 0)
                input.autofocus = true;
            label.append(name, input);
            grid.appendChild(label);
        });
        root.appendChild(grid);
    }
    if (choices.length > 0) {
        const row = document.createElement("div");
        row.className = "ai-question-options";
        choices.forEach((choice) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "ai-question-option";
            button.dataset.aiOption = choice;
            button.textContent = choice;
            row.appendChild(button);
        });
        root.appendChild(row);
    }
    if (fields.length === 0) {
        const answer = document.createElement("textarea");
        answer.className = "ai-question-answer";
        answer.rows = 1;
        answer.placeholder = aiText("answer_placeholder");
        root.appendChild(answer);
    }
    const actions = document.createElement("div");
    actions.className = "ai-question-actions";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "panel-button ai-question-submit";
    submit.textContent = aiText("answer_send");
    actions.appendChild(submit);
    if (options.stepId) {
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "panel-button ghost";
        cancel.dataset.aiQuestionCancel = "true";
        cancel.textContent = aiText("cancel");
        actions.appendChild(cancel);
    }
    root.appendChild(actions);
    return root;
};
/** The answer a question form holds, as the text the agent receives. */
export const readQuestionAnswer = (form) => {
    var _a, _b, _c;
    const inputs = Array.from(form.querySelectorAll("input.ai-question-input"));
    if (inputs.length > 0) {
        const lines = inputs
            .map((input) => { var _a; return ({ label: (_a = input.dataset.aiFieldLabel) !== null && _a !== void 0 ? _a : input.name, value: input.value.trim() }); })
            .filter((entry) => entry.value)
            .map((entry) => `${entry.label}: ${entry.value}`);
        return lines.join("\n");
    }
    const chosen = form.querySelector(".ai-question-option.is-chosen");
    const free = form.querySelector(".ai-question-answer");
    const freeText = (_a = free === null || free === void 0 ? void 0 : free.value.trim()) !== null && _a !== void 0 ? _a : "";
    if (chosen && freeText)
        return `${(_b = chosen.dataset.aiOption) !== null && _b !== void 0 ? _b : ""}\n${freeText}`;
    if (chosen)
        return (_c = chosen.dataset.aiOption) !== null && _c !== void 0 ? _c : "";
    return freeText;
};
const applyRatingState = (wrapper, rating) => {
    wrapper.dataset.aiRating = rating !== null && rating !== void 0 ? rating : "";
    wrapper.querySelectorAll('[data-ai-action="rate-up"], [data-ai-action="rate-down"]').forEach((button) => {
        const own = button.dataset.aiAction === "rate-up" ? "up" : "down";
        button.classList.toggle("is-active", rating === own);
    });
};
export const createMessageElement = (message, options = {}) => {
    if (isTraceMessage(message))
        return createTraceLineElement(message);
    const wrapper = document.createElement("div");
    wrapper.className = "ai-message";
    if (message.role === "user") {
        wrapper.classList.add("is-user");
        const content = document.createElement("div");
        content.className = "ai-message-content";
        content.textContent = message.text;
        wrapper.appendChild(content);
        if (message.queued) {
            // Typed while a turn was running: it waits its turn, and can be sent
            // at once or taken back from here.
            wrapper.classList.add("is-queued");
            if (message.queueId)
                wrapper.dataset.aiQueueId = message.queueId;
            const bar = document.createElement("div");
            bar.className = "ai-queued-bar";
            const label = document.createElement("span");
            label.className = "ai-queued-label";
            label.textContent = aiText("queued");
            const sendNow = document.createElement("button");
            sendNow.type = "button";
            sendNow.className = "ai-queued-action";
            sendNow.dataset.aiQueueAction = "send";
            sendNow.title = aiText("queue_send_now");
            sendNow.setAttribute("aria-label", aiText("queue_send_now"));
            sendNow.innerHTML = ICONS.send;
            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "ai-queued-action";
            remove.dataset.aiQueueAction = "remove";
            remove.title = aiText("queue_remove");
            remove.setAttribute("aria-label", aiText("queue_remove"));
            remove.innerHTML = ICONS.close;
            bar.append(label, sendNow, remove);
            wrapper.appendChild(bar);
        }
        else if (message.text.length > LONG_USER_MESSAGE_CHARS) {
            // A long writing brief otherwise pushes the whole run (progress, answer,
            // produced files) out of view in a narrow panel.
            wrapper.classList.add("is-clamped", "has-expand");
            const toggle = document.createElement("button");
            toggle.type = "button";
            toggle.className = "ai-message-expand";
            const syncLabel = () => {
                toggle.textContent = wrapper.classList.contains("is-clamped")
                    ? uiText("Show more", "もっと見る")
                    : uiText("Show less", "折りたたむ");
            };
            toggle.addEventListener("click", () => {
                wrapper.classList.toggle("is-clamped");
                syncLabel();
            });
            syncLabel();
            wrapper.appendChild(toggle);
        }
    }
    else if (message.role === "assistant") {
        wrapper.classList.add("is-assistant");
        wrapper.dataset.rawText = message.text;
        if (typeof options.assistantIndex === "number") {
            wrapper.dataset.assistantIndex = String(options.assistantIndex);
        }
        const body = document.createElement("div");
        body.className = "ai-message-body";
        const content = document.createElement("div");
        content.className = "ai-message-content";
        content.innerHTML = renderMarkdownHtml(message.text);
        attachCopyHandlers(content);
        body.appendChild(content);
        wrapper.appendChild(body);
        if (Array.isArray(message.changes) && message.changes.length > 0 && options.renderChanges) {
            const card = options.renderChanges(message, options.latest === true);
            if (card)
                wrapper.appendChild(card);
        }
        if (message.question && options.latest) {
            wrapper.appendChild(createQuestionElement(message.question));
        }
        if (message.plan && Array.isArray(message.plan.steps) && message.plan.steps.length > 0) {
            const planEl = createPlanElement(message.plan, options.latest === true);
            planEl.dataset.aiPlanJson = JSON.stringify(message.plan);
            wrapper.appendChild(planEl);
        }
        if (Array.isArray(message.proposals) && message.proposals.length > 0) {
            wrapper.appendChild(createNextStepsElement(message.proposals, options.latest === true));
        }
        // Quiet row under the reply: copy, try again, rate, branch, and when it
        // was written. It only shows while the pointer rests on the reply.
        const actions = document.createElement("div");
        actions.className = "ai-message-actions";
        actions.appendChild(createActionButton("copy", aiText("action_copy")));
        actions.appendChild(createActionButton("retry", aiText("action_retry")));
        actions.appendChild(createActionButton("rate-up", aiText("rate_up")));
        actions.appendChild(createActionButton("rate-down", aiText("rate_down")));
        actions.appendChild(createActionButton("branch", aiText("branch")));
        const time = document.createElement("span");
        time.className = "ai-message-time";
        time.textContent = formatRelativeTime(message.createdAt);
        actions.appendChild(time);
        wrapper.appendChild(actions);
        applyRatingState(wrapper, message.rating);
    }
    else if (message.role === "system") {
        wrapper.classList.add("is-system");
        const content = document.createElement("div");
        content.className = "ai-message-content";
        if (message.text.startsWith("\u{1F4AD} ")) {
            content.classList.add("ai-thought-content");
        }
        else if (message.text.startsWith("\u{1F527} ")) {
            content.classList.add("ai-tool-log-content");
        }
        content.textContent = message.text;
        wrapper.appendChild(content);
    }
    return wrapper;
};
export const updateMessageElement = (wrapper, text) => {
    if (!wrapper)
        return;
    const content = wrapper.querySelector(".ai-message-content");
    if (!content)
        return;
    if (wrapper.classList.contains("is-assistant")) {
        wrapper.dataset.rawText = text;
        content.innerHTML = renderMarkdownHtml(text);
        attachCopyHandlers(content);
    }
    else {
        content.textContent = text;
    }
};
/** Reflect a rating on an already rendered reply. */
export const setMessageRating = (wrapper, rating) => {
    if (wrapper)
        applyRatingState(wrapper, rating);
};
/**
 * The rating comment box under a reply: a line for what went wrong and a
 * note that the exchange goes to the team. Sending posts the rating.
 */
export const createRatingBox = () => {
    const box = document.createElement("form");
    box.className = "ai-rate-box";
    box.dataset.aiRateBox = "true";
    const input = document.createElement("textarea");
    input.className = "ai-rate-input";
    input.rows = 1;
    input.placeholder = aiText("rate_comment");
    const note = document.createElement("div");
    note.className = "ai-rate-note";
    note.textContent = aiText("rate_note");
    const actions = document.createElement("div");
    actions.className = "ai-rate-actions";
    const send = document.createElement("button");
    send.type = "submit";
    send.className = "panel-button ai-rate-send";
    send.textContent = aiText("rate_send");
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "panel-button ghost";
    cancel.dataset.aiRateCancel = "true";
    cancel.textContent = aiText("cancel");
    actions.append(send, cancel);
    box.append(input, note, actions);
    return box;
};
