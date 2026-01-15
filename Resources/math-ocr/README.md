Math OCR model files go here.

Required files:
- `config.json` (see `config.template.json`)
- `encoder.onnx`
- `decoder.onnx`
- `tokenizer.json`

Config notes:
- `decodeStrategy`: `greedy` (pix2text default), `top_k`, or `top_p`
- `filterThres`: threshold used for `top_k` / `top_p` (default `0.9`)
- `decoderStartToken`: initial token ID for decoding (pix2text uses `</s>`)

Model source:
- The current math OCR model uses `breezedeus/pix2text-mfr` (encoder/decoder ONNX + tokenizer).
- Preprocessor reference lives in `preprocessor_config.json` (resize to 384×384, mean/std 0.5).

At runtime the app loads these files for offline LaTeX OCR.
