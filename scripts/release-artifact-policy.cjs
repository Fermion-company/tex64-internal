const path = require("node:path");

const MICROSOFT_STORE_ARTIFACT_EXTENSIONS = Object.freeze([
  ".appx",
  ".msix",
  ".appxbundle",
  ".msixbundle",
  ".appxupload",
  ".msixupload",
]);

const isMicrosoftStoreArtifact = (fileName) => {
  const lower = path.basename(String(fileName || "")).trim().toLowerCase();
  return MICROSOFT_STORE_ARTIFACT_EXTENSIONS.some((extension) =>
    lower.endsWith(extension)
  );
};

const parsePublicUpdateArtifactKind = (fileName) => {
  const lower = String(fileName || "").trim().toLowerCase();
  if (!lower || isMicrosoftStoreArtifact(lower)) return "";
  if (lower.endsWith(".tar.gz")) return "tar.gz";
  if (lower.endsWith(".dmg")) return "dmg";
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".exe")) return "exe";
  if (lower.endsWith(".msi")) return "msi";
  if (lower.endsWith(".appimage")) return "appimage";
  if (lower.endsWith(".deb")) return "deb";
  if (lower.endsWith(".rpm")) return "rpm";
  return "";
};

const isPublicDownloadsArtifact = (fileName) =>
  ["dmg", "zip", "exe", "msi"].includes(
    parsePublicUpdateArtifactKind(fileName)
  );

module.exports = {
  MICROSOFT_STORE_ARTIFACT_EXTENSIONS,
  isMicrosoftStoreArtifact,
  isPublicDownloadsArtifact,
  parsePublicUpdateArtifactKind,
};
