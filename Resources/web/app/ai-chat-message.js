const escapeHtml = (text) => text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const renderInlineMarkdown = (text) => {
    let html = escapeHtml(text);
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
    html = html.replace(/`([^`]+)`/g, '<code class="ai-inline-code">$1</code>');
    return html;
};
const renderTextBlockHtml = (text) => {
    var _a, _b, _c;
    const lines = text.split(/\r?\n/);
    const blocks = [];
    let paragraphLines = [];
    const flushParagraph = () => {
        if (paragraphLines.length === 0)
            return;
        blocks.push(`<p>${paragraphLines.join("<br>")}</p>`);
        paragraphLines = [];
    };
    for (let i = 0; i < lines.length; i += 1) {
        const rawLine = (_a = lines[i]) !== null && _a !== void 0 ? _a : "";
        const line = rawLine.trim();
        if (!line) {
            flushParagraph();
            continue;
        }
        const heading = line.match(/^(#{1,3})\s+(.+)$/);
        if (heading) {
            flushParagraph();
            const level = Math.min(3, heading[1].length);
            const content = renderInlineMarkdown(heading[2].trim());
            blocks.push(`<h${level} class="ai-md-heading ai-md-heading-${level}">${content}</h${level}>`);
            continue;
        }
        const unordered = line.match(/^[-*]\s+(.+)$/);
        if (unordered) {
            flushParagraph();
            const items = [];
            let cursor = i;
            while (cursor < lines.length) {
                const listLine = ((_b = lines[cursor]) !== null && _b !== void 0 ? _b : "").trim();
                const listItem = listLine.match(/^[-*]\s+(.+)$/);
                if (!listItem)
                    break;
                items.push(`<li>${renderInlineMarkdown(listItem[1].trim())}</li>`);
                cursor += 1;
            }
            blocks.push(`<ul class="ai-md-list">${items.join("")}</ul>`);
            i = cursor - 1;
            continue;
        }
        const ordered = line.match(/^\d+\.\s+(.+)$/);
        if (ordered) {
            flushParagraph();
            const items = [];
            let cursor = i;
            while (cursor < lines.length) {
                const listLine = ((_c = lines[cursor]) !== null && _c !== void 0 ? _c : "").trim();
                const listItem = listLine.match(/^\d+\.\s+(.+)$/);
                if (!listItem)
                    break;
                items.push(`<li>${renderInlineMarkdown(listItem[1].trim())}</li>`);
                cursor += 1;
            }
            blocks.push(`<ol class="ai-md-list">${items.join("")}</ol>`);
            i = cursor - 1;
            continue;
        }
        paragraphLines.push(renderInlineMarkdown(line));
    }
    flushParagraph();
    return blocks.join("");
};
const renderMarkdownHtml = (text) => {
    const blocks = [];
    const parts = text.split(/(```[\s\S]*?```)/g);
    for (const part of parts) {
        if (part.startsWith("```")) {
            const match = part.match(/^```(\w*)\n?([\s\S]*?)```$/);
            if (match) {
                const lang = escapeHtml(match[1] || "text");
                const code = escapeHtml(match[2].trimEnd());
                blocks.push(`<div class="ai-code-block"><div class="ai-code-header"><span class="ai-code-lang">${lang}</span><button class="ai-code-copy" type="button" data-copy>copy</button></div><pre><code>${code}</code></pre></div>`);
            }
            else {
                blocks.push(`<pre><code>${escapeHtml(part)}</code></pre>`);
            }
        }
        else {
            const html = renderTextBlockHtml(part);
            if (html.trim())
                blocks.push(html);
        }
    }
    return blocks.join("");
};
const attachCopyHandlers = (container) => {
    container.querySelectorAll("[data-copy]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            var _a, _b, _c;
            e.stopPropagation();
            const code = (_c = (_b = (_a = btn.closest(".ai-code-block")) === null || _a === void 0 ? void 0 : _a.querySelector("code")) === null || _b === void 0 ? void 0 : _b.textContent) !== null && _c !== void 0 ? _c : "";
            navigator.clipboard.writeText(code).then(() => {
                btn.textContent = "copied";
                setTimeout(() => { btn.textContent = "copy"; }, 1500);
            });
        });
    });
};
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
        const indicator = document.createElement("div");
        indicator.className = "ai-message-indicator";
        indicator.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2l2.09 6.26L20.18 10l-6.09 1.74L12 18l-2.09-6.26L3.82 10l6.09-1.74z"/></svg>';
        const body = document.createElement("div");
        body.className = "ai-message-body";
        const content = document.createElement("div");
        content.className = "ai-message-content";
        content.innerHTML = renderMarkdownHtml(message.text);
        attachCopyHandlers(content);
        body.appendChild(content);
        wrapper.appendChild(indicator);
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
