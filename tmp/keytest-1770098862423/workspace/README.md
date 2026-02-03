# tex64 test workspace

This folder is a fixture for manual and automated testing of tex64 features.
Open `main.tex` for the primary project; use the other files to check specific UI panels.

Quick checks
- Build/PDF: build `main.tex` and open `assets/pdfs/sample.pdf`
- Build errors/warnings: build files under `cases/build/`
- Outline: open `sections/intro.tex` or `cases/outline/outline-levels.tex`
- Search: search for `TEX64_SEARCH_TOKEN` or open `cases/search/search-many.tex`
- Blocks: open `sections/blocks.tex` or any file under `cases/blocks/`
- Format: run format on `notes/unformatted.tex` or `cases/format/format-blanklines.tex`
- Issues: build `broken.tex` or `cases/build/error-undefined-command.tex`
- Viewer: open files under `figures/` and `cases/viewer/`
- File tree: browse `cases/file-tree/` for deep paths, spaces, and sorting

Structure
- `sections/`: main content files
- `notes/`: alternate root and formatting target
- `figures/`: image assets referenced by TeX
- `assets/`: PDF and non-TeX fixtures
- `cases/`: feature-specific fixtures
  - `cases/build/`: compile errors and warnings
  - `cases/blocks/`: block detection edge cases
  - `cases/format/`: formatter edge cases
  - `cases/outline/`: outline/indexer samples
  - `cases/search/`: search limit and case tests
  - `cases/viewer/`: image/PDF viewer samples and unsupported binary
  - `cases/text/`: text-mode extensions (aux/log/toc/etc.)
  - `cases/file-tree/`: deep paths, spaces, and naming patterns
  - `cases/encoding/`: UTF-8 sample (non-ASCII text)
