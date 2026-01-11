Math OCR model files go here.

Required files:
- `config.json` (see `config.template.json`)
- `encoder.onnx`
- `decoder.onnx`
- `tokenizer.json`

Config notes:
- `decodeStrategy`: `top_k` (pix2tex default), `top_p`, or `greedy`
- `filterThres`: threshold used for `top_k` / `top_p` (default `0.9`)

Export workflow (developer machine):
1) Install Python + PyTorch and pix2tex dependencies.
2) Run `python scripts/pix2tex/export-onnx.py --output Resources/math-ocr`.
3) Copy `config.template.json` to `config.json` if the script did not create it.

At runtime the app loads these files for offline LaTeX OCR.
