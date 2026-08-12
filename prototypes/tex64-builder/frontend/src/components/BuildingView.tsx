export function BuildingView({ progress }: { progress: number }) {
  return (
    <div className="building-view">
      <div className="building-logo">
        <span>&Sigma;</span>
      </div>
      <div className="building-title">
        論文 をビルド中<span className="building-dots">..</span>
      </div>
      <div className="building-bar">
        <div className="building-bar-fill" style={{ width: `${Math.min(progress, 100)}%` }} />
      </div>
      <div className="building-hint-label">TeX64を最大限に活用しましょう</div>
      <div className="building-hint">数式番号は章ごとに自動採番されます</div>
    </div>
  );
}
