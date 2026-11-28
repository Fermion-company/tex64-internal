"use client";

import type { NativeWorkspaceState } from "@/lib/client/use-native-workspace";

export function NativeWorkspacePanel({ workspace }: { workspace: NativeWorkspaceState }) {
  const { hasWorkspace, texFiles, pendingRoot, rootError, chooseRoot, openWorkspace, createWorkspace } = workspace;
  const canChoose = hasWorkspace && texFiles.length > 0;
  const heading = canChoose ? "組版する原稿を選んでください" : hasWorkspace ? "このフォルダにはTeX原稿がありません" : "プロジェクトを開く";
  return (
    <section className="new-document-panel" aria-label={heading}>
      <div className="native-new-document">
        <h2>{heading}</h2>
        {canChoose ? (
          <div className="question-options" aria-label="TeX原稿" style={{ maxHeight: "36dvh", overflowY: "auto" }}>
            {texFiles.map((path) => (
              <button type="button" className="question-option" key={path} title={path}
                style={{ textAlign: "left", overflowWrap: "anywhere" }}
                disabled={pendingRoot !== null} onClick={() => chooseRoot(path)}>
                {path}
              </button>
            ))}
          </div>
        ) : null}
        {pendingRoot ? <p role="status">{pendingRoot} を設定しています。</p> : null}
        {rootError ? <p className="native-new-document-error" role="alert">{rootError}</p> : null}
        <div className="native-new-document-actions">
          <button type="button" onClick={openWorkspace}>
            {hasWorkspace ? "別のフォルダを開く" : "フォルダを開く"}
          </button>
          <button type="button" className="native-new-document-create" onClick={createWorkspace}>
            新規作成
          </button>
        </div>
      </div>
    </section>
  );
}
