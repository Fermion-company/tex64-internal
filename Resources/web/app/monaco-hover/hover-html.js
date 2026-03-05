export const buildImagePreviewHtml = (dataUrl) => {
    const withMarker = dataUrl.includes("#tex64-image") ? dataUrl : `${dataUrl}#tex64-image`;
    const escaped = withMarker.replace(/"/g, "&quot;");
    return `<div class="tex64-hover-preview tex64-hover-preview-image" data-tex64-preview="image"><img src="${escaped}" alt="" /></div>`;
};
export const createHtmlHoverContent = (html) => ({
    value: html,
    supportHtml: true,
    isTrusted: true,
});
