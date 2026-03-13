import type { ChatMessage } from "./ai-chat-state.js";

/* ------------------------------------------------------------------ */
/*  Globals loaded via <script> in index.html                         */
/* ------------------------------------------------------------------ */

declare const marked: {
  parse(src: string, options?: Record<string, unknown>): string;
  use(extension: Record<string, unknown>): void;
};

declare const katex: {
  renderToString(
    expression: string,
    options?: { displayMode?: boolean; throwOnError?: boolean },
  ): string;
};

/* ------------------------------------------------------------------ */
/*  KaTeX math rendering                                              */
/* ------------------------------------------------------------------ */

const renderMathInText = (html: string): string => {
  // Display math: $$...$$ (must come before inline)
  html = html.replace(/\$\$([\s\S]+?)\$\$/g, (_match, expr: string) => {
    try {
      return katex.renderToString(expr.trim(), {
        displayMode: true,
        throwOnError: false,
      });
    } catch {
      return `<code>${expr}</code>`;
    }
  });
  // Inline math: $...$  (not preceded/followed by $)
  html = html.replace(/(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)/g, (_match, expr: string) => {
    try {
      return katex.renderToString(expr.trim(), {
        displayMode: false,
        throwOnError: false,
      });
    } catch {
      return `<code>${expr}</code>`;
    }
  });
  return html;
};

/* ------------------------------------------------------------------ */
/*  Marked configuration                                              */
/* ------------------------------------------------------------------ */

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const configureMarked = () => {
  const renderer = {
    code(token: { text: string; lang?: string }): string {
      const lang = escapeHtml(token.lang || "text");
      const code = escapeHtml(token.text);
      return (
        `<div class="ai-code-block">` +
        `<div class="ai-code-header">` +
        `<span class="ai-code-lang">${lang}</span>` +
        `<button class="ai-code-copy" type="button" data-copy>コピー</button>` +
        `</div>` +
        `<pre><code>${code}</code></pre>` +
        `</div>`
      );
    },
    codespan(token: { text: string }): string {
      return `<code class="ai-inline-code">${escapeHtml(token.text)}</code>`;
    },
    heading(token: { text: string; depth: number }): string {
      const level = Math.min(3, token.depth);
      return `<h${level} class="ai-md-heading ai-md-heading-${level}">${token.text}</h${level}>`;
    },
    list(this: { parser: { parse(tokens: unknown[]): string } }, token: { ordered: boolean; items: { tokens: unknown[] }[] }): string {
      const tag = token.ordered ? "ol" : "ul";
      const items = token.items.map((item) => `<li>${this.parser.parse(item.tokens)}</li>`).join("");
      return `<${tag} class="ai-md-list">${items}</${tag}>`;
    },
    table(token: {
      header: { text: string; align: string | null }[];
      rows: { text: string; align: string | null }[][];
    }): string {
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
      return (
        `<div class="ai-table-wrapper">` +
        `<table class="ai-md-table"><thead><tr>${ths}</tr></thead>` +
        `<tbody>${bodyRows}</tbody></table>` +
        `</div>`
      );
    },
  };

  marked.use({ renderer, gfm: true, breaks: false });
};

let markedConfigured = false;

/* ------------------------------------------------------------------ */
/*  Render markdown → HTML                                            */
/* ------------------------------------------------------------------ */

const renderMarkdownHtml = (text: string): string => {
  if (!markedConfigured) {
    configureMarked();
    markedConfigured = true;
  }

  // Protect math blocks from marked's processing
  const mathBlocks: string[] = [];
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
    const original = mathBlocks[Number(idx)] ?? "";
    return renderMathInText(original);
  });

  return html;
};

/* ------------------------------------------------------------------ */
/*  Copy button handler                                               */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  DOM helpers                                                       */
/* ------------------------------------------------------------------ */

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
    const body = document.createElement("div");
    body.className = "ai-message-body";
    const content = document.createElement("div");
    content.className = "ai-message-content";
    content.innerHTML = renderMarkdownHtml(message.text);
    attachCopyHandlers(content);
    body.appendChild(content);
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
