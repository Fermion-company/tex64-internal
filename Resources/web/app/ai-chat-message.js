/* ------------------------------------------------------------------ */
/*  KaTeX math rendering                                              */
/* ------------------------------------------------------------------ */
const renderMathInText = (html) => {
    // Display math: $$...$$ (must come before inline)
    html = html.replace(/\$\$([\s\S]+?)\$\$/g, (_match, expr) => {
        try {
            return katex.renderToString(expr.trim(), {
                displayMode: true,
                throwOnError: false,
            });
        }
        catch {
            return `<code>${expr}</code>`;
        }
    });
    // Inline math: $...$  (not preceded/followed by $)
    html = html.replace(/(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)/g, (_match, expr) => {
        try {
            return katex.renderToString(expr.trim(), {
                displayMode: false,
                throwOnError: false,
            });
        }
        catch {
            return `<code>${expr}</code>`;
        }
    });
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
const configureMarked = () => {
    const renderer = {
        code(token) {
            const lang = escapeHtml(token.lang || "text");
            const isLatex = /^(la)?tex$/i.test(token.lang || "");
            const code = isLatex ? highlightLatex(token.text) : escapeHtml(token.text);
            return (`<div class="ai-code-block">` +
                `<div class="ai-code-header">` +
                `<span class="ai-code-lang">${lang}</span>` +
                `<button class="ai-code-copy" type="button" data-copy>コピー</button>` +
                `</div>` +
                `<pre><code>${code}</code></pre>` +
                `</div>`);
        },
        codespan(token) {
            return `<code class="ai-inline-code">${escapeHtml(token.text)}</code>`;
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
const renderMarkdownHtml = (text) => {
    if (!markedConfigured) {
        configureMarked();
        markedConfigured = true;
    }
    // Protect math blocks from marked's processing
    const mathBlocks = [];
    let protected_ = text;
    // Protect display math $$...$$
    protected_ = protected_.replace(/\$\$([\s\S]+?)\$\$/g, (_match, expr) => {
        mathBlocks.push(`$$${expr}$$`);
        return `\x00MATH${mathBlocks.length - 1}\x00`;
    });
    // Protect inline math $...$
    protected_ = protected_.replace(/(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)/g, (_match, expr) => {
        mathBlocks.push(`$${expr}$`);
        return `\x00MATH${mathBlocks.length - 1}\x00`;
    });
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
                btn.textContent = "コピー済み";
                setTimeout(() => { btn.textContent = "コピー"; }, 1500);
            }, () => { });
        });
    });
};
/* ------------------------------------------------------------------ */
/*  DOM helpers                                                       */
/* ------------------------------------------------------------------ */
export const createMessageElement = (message) => {
    const wrapper = document.createElement("div");
    wrapper.className = "ai-message";
    if (message.role === "user") {
        wrapper.classList.add("is-user");
        const content = document.createElement("div");
        content.className = "ai-message-content";
        content.textContent = message.text;
        wrapper.appendChild(content);
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
