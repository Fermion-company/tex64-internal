# Design QA

## Comparison target

- Source visual truth: `http://localhost:5173/`, captured in the Codex in-app Browser during this task.
- Implementation: `http://localhost:3100/`.
- Desktop comparison: 1280 × 720 CSS px, light theme, populated document.
- Responsive comparison: 390 × 844 CSS px, conversation and document tabs in both light and dark themes.
- The source and final implementation captures were reviewed together at the desktop target size. The implementation preserves the source's two primary regions: conversation on the left and the outline plus paper workspace on the right. It does not introduce a permanent third pane.

## Findings

- No blocking visual or interaction defects remain.
- Desktop has no horizontal overflow (`scrollWidth = innerWidth = 1280`).
- Mobile has no horizontal overflow (`scrollWidth = innerWidth = 390`) in light or dark mode.
- The mobile tab switch exposes either the conversation or document without compressing the desktop layout.
- Light mode uses a white paper and soft purple selection states; dark mode keeps the chrome dark while preserving a white paper surface for document legibility.
- Controls use product-facing Japanese labels. No internal tool names, source-code terms, workflow step names, or file names are exposed in the primary interface.
- Icons are from the installed icon library and remain legible at both checked viewport sizes.

## Primary interactions verified

- Create a new paper from the new-document view.
- Continue from the agent's clarification question with a specific research request.
- Generate a three-section document and a revision-addressed PDF.
- Preserve the topic as the document title instead of copying the full instruction.
- Approve a destructive section deletion and commit exactly the pending change.
- Reject a destructive section deletion and preserve the section.
- Save a direct author edit and reload it from persistence.
- Apply the concise/tone/argument shortcuts without exposing implementation language.
- Switch light/dark themes.
- Switch conversation/document tabs on mobile.
- Open the generated PDF action from the document toolbar.

## Generated document evidence

- Final QA document: `Transformerの注意機構`.
- Current revision: 2.
- Sections: `はじめに`, `考察`, `結論`.
- PDF: one-page A4, PDF 1.5, produced by LuaTeX 1.18.0.
- Stored bytes: 29,909.
- Stored and recomputed SHA-256: `eee535e1206b93bc65b6bae9cf0c23e7bb0a885e25f991df531bab7c01812131`.
- Compile duration recorded by the application: 10,409 ms.

## Console and runtime

- No application console errors were observed during the final flow.
- The only console entries were the normal Next.js development connection and React development notice.
- The development-only Next.js badge is not application UI and is absent from a production build.

## Final result

Pass.
