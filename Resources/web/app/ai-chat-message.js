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
export const createMessageElement = (message) => {
    const wrapper = document.createElement("div");
    wrapper.className = "ai-message";
    if (message.role === "user") {
        wrapper.classList.add("is-user");
        const content = document.createElement("div");
        content.className = "ai-message-content";
        content.textContent = message.text;
        wrapper.appendChild(content);
        // A long writing brief otherwise pushes the whole run (progress, answer,
        // produced files) out of view in a narrow panel.
        if (message.text.length > LONG_USER_MESSAGE_CHARS) {
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
        const body = document.createElement("div");
        body.className = "ai-message-body";
        const content = document.createElement("div");
        content.className = "ai-message-content";
        content.innerHTML = renderMarkdownHtml(message.text);
        attachCopyHandlers(content);
        body.appendChild(content);
        wrapper.appendChild(body);
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
        content.innerHTML = renderMarkdownHtml(text);
        attachCopyHandlers(content);
    }
    else {
        content.textContent = text;
    }
};
import { uiText } from "./i18n.js";
