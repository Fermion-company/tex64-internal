"use client";

export function NativeWorkspacePanel({
  onOpen,
  onCreate,
}: {
  onOpen: () => void;
  onCreate: () => void;
}) {
  return (
    <section className="new-document-panel" aria-label="プロジェクトを選ぶ">
      <div className="native-new-document">
        <h2>プロジェクト</h2>
        <div className="native-new-document-actions">
          <button type="button" onClick={onOpen}>
            開く
          </button>
          <button
            type="button"
            className="native-new-document-create"
            onClick={onCreate}
          >
            新規作成
          </button>
        </div>
      </div>
    </section>
  );
}
