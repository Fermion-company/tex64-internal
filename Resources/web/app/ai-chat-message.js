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
const configureMarked = () => {
    const renderer = {
        code(token) {
            const lang = escapeHtml(token.lang || "text");
            const code = escapeHtml(token.text);
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
    let html = marked.parse(protected_);
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
            });
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
