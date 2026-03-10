import type { ChatMessage } from "./ai-chat-state.js";

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const renderInlineMarkdown = (text: string): string => {
  let html = escapeHtml(text);
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
  html = html.replace(/`([^`]+)`/g, '<code class="ai-inline-code">$1</code>');
  return html;
};

const renderTextBlockHtml = (text: string): string => {
  const lines = text.split(/\r?\n/);
  const blocks: string[] = [];
  let paragraphLines: string[] = [];

  const flushParagraph = () => {
    if (paragraphLines.length === 0) return;
    blocks.push(`<p>${paragraphLines.join("<br>")}</p>`);
    paragraphLines = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i] ?? "";
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
      const items: string[] = [];
      let cursor = i;
      while (cursor < lines.length) {
        const listLine = (lines[cursor] ?? "").trim();
        const listItem = listLine.match(/^[-*]\s+(.+)$/);
        if (!listItem) break;
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
      const items: string[] = [];
      let cursor = i;
      while (cursor < lines.length) {
        const listLine = (lines[cursor] ?? "").trim();
        const listItem = listLine.match(/^\d+\.\s+(.+)$/);
        if (!listItem) break;
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

const renderMarkdownHtml = (text: string): string => {
  const blocks: string[] = [];
  const parts = text.split(/(```[\s\S]*?```)/g);

  for (const part of parts) {
    if (part.startsWith("```")) {
      const match = part.match(/^```(\w*)\n?([\s\S]*?)```$/);
      if (match) {
        const lang = escapeHtml(match[1] || "text");
        const code = escapeHtml(match[2].trimEnd());
        blocks.push(
          `<div class="ai-code-block"><div class="ai-code-header"><span class="ai-code-lang">${lang}</span><button class="ai-code-copy" type="button" data-copy>コピー</button></div><pre><code>${code}</code></pre></div>`
        );
      } else {
        blocks.push(`<pre><code>${escapeHtml(part)}</code></pre>`);
      }
    } else {
      const html = renderTextBlockHtml(part);
      if (html.trim()) blocks.push(html);
    }
  }
  return blocks.join("");
};

const attachCopyHandlers = (container: Element) => {
  container.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const code = btn.closest(".ai-code-block")?.querySelector("code")?.textContent ?? "";
      navigator.clipboard.writeText(code).then(() => {
        btn.textContent = "コピー済み";
        setTimeout(() => { btn.textContent = "コピー"; }, 1500);
      });
    });
  });
};

export const createMessageElement = (message: ChatMessage) => {
  const wrapper = document.createElement("div");
  wrapper.className = "ai-message";

  if (message.role === "user") {
    wrapper.classList.add("is-user");
    const content = document.createElement("div");
    content.className = "ai-message-content";
    content.textContent = message.text;
    wrapper.appendChild(content);
  } else if (message.role === "assistant") {
    wrapper.classList.add("is-assistant");
    const indicator = document.createElement("div");
    indicator.className = "ai-message-indicator";
    indicator.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4L20 12L12 20L4 12Z"/><ellipse cx="12" cy="12" rx="6" ry="2.5" transform="rotate(-30 12 12)" stroke-width="1" opacity="0.4"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/></svg>';
    const body = document.createElement("div");
    body.className = "ai-message-body";
    const content = document.createElement("div");
    content.className = "ai-message-content";
    content.innerHTML = renderMarkdownHtml(message.text);
    attachCopyHandlers(content);
    body.appendChild(content);
    wrapper.appendChild(indicator);
    wrapper.appendChild(body);
  } else if (message.role === "system") {
    wrapper.classList.add("is-system");
    const content = document.createElement("div");
    content.className = "ai-message-content";
    if (message.text.startsWith("\u{1F4AD} ")) {
      content.classList.add("ai-thought-content");
    } else if (message.text.startsWith("\u{1F527} ")) {
      content.classList.add("ai-tool-log-content");
    }
    content.textContent = message.text;
    wrapper.appendChild(content);
  }
  return wrapper;
};

export const updateMessageElement = (wrapper: HTMLElement | null, text: string) => {
  if (!wrapper) return;
  const content = wrapper.querySelector(".ai-message-content");
  if (!content) return;
  if (wrapper.classList.contains("is-assistant")) {
    content.innerHTML = renderMarkdownHtml(text);
    attachCopyHandlers(content);
  } else {
    content.textContent = text;
  }
};
