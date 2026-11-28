const path = require("node:path");

// Old SyncTeX files keep the paths where TeX ran. Only a unique best suffix
// identifies a file after moving a project containing equally named chapters.
const matchSourcePathBySuffix = (target, candidates) => {
  const targetParts = path.normalize(target).split(path.sep);
  let best = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const parts = path.normalize(candidate).split(path.sep);
    const limit = Math.min(parts.length, targetParts.length);
    let score = 0;
    while (score < limit && parts[parts.length - 1 - score] === targetParts[targetParts.length - 1 - score]) {
      score += 1;
    }
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    } else if (score === bestScore) {
      best = null;
    }
  }
  return best;
};

module.exports = { matchSourcePathBySuffix };
