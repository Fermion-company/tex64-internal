# Public workflow evidence

This directory contains Fermion-authored, redistribution-safe LaTeX fixtures and
machine-readable traces produced by the current TeX64 implementation. No model,
account, API key, private document, or third-party paper source is required.

Run the fixture suite from the repository root:

```sh
npm run evidence:public-workflows
npm run evidence:verify
```

The first command uses the cached arXiv Atom response by default. The response is
metadata only; arXiv applies CC0 to metadata. To refresh it from the public arXiv
API, run `npm run evidence:public-workflows -- --refresh-arxiv`. The fixture does
not download or redistribute a paper PDF or source archive.

The generated `results/manifest.json` binds every published source, diff, JSON
trace, and PDF to a SHA-256 digest. Absolute temporary paths, random proposal IDs,
and credentials are excluded from the public traces.

The historical 85-file completion benchmark is deliberately separate. Its
aggregate result and distilled regression test exist, but the original source-ID,
retrieval-date, and per-version rights manifest was not preserved. Because arXiv
states that its default license does not grant third parties redistribution rights,
the corpus and a reconstructed manifest are not published or treated as
reproducible evidence.
