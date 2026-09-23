const finiteNumber = (value, fallback) =>
  Number.isFinite(value) ? Number(value) : fallback;

export const normalizeLiveToolbarSnapshot = (current = {}, update = {}) => {
  const pageCount = Math.max(
    0,
    Math.floor(finiteNumber(update.pageCount, finiteNumber(current.pageCount, 0)))
  );
  const pageCountAuthoritative = typeof update.pageCountAuthoritative === "boolean"
    ? update.pageCountAuthoritative
    : current.pageCountAuthoritative !== false;
  const requestedPage = Math.max(
    1,
    Math.floor(finiteNumber(update.page, finiteNumber(current.page, 1)))
  );
  const zoom = Math.max(
    0.01,
    finiteNumber(update.zoom, finiteNumber(current.zoom, 1))
  );
  return {
    pageCount,
    pageCountAuthoritative,
    page: Math.min(requestedPage, pageCount || 1),
    zoom,
  };
};

export const stepLiveToolbarPage = (current = {}, delta = 0) =>
  normalizeLiveToolbarSnapshot(current, {
    page: finiteNumber(current.page, 1) + finiteNumber(delta, 0),
  });
