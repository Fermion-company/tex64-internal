export const chooseImageDirectory = (files) => {
    for (const directory of ["figures", "images", "assets"]) {
        if (files.some((file) => file === directory || file.startsWith(`${directory}/`))) {
            return directory;
        }
    }
    return "assets";
};
export const buildIncludeGraphicsSnippet = (path, figure) => {
    const command = `\\includegraphics[width=0.8\\linewidth]{${path}}`;
    return figure
        ? `\\begin{figure}[htbp]\n  \\centering\n  ${command}\n\\end{figure}\n`
        : `${command}\n`;
};
