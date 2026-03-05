const DEFAULT_CONFIG = {
  encoder: "encoder.onnx",
  decoder: "decoder.onnx",
  tokenizer: "tokenizer.json",
  encoderInput: "pixel_values",
  encoderOutput: "last_hidden_state",
  decoderInputTokens: "input_ids",
  decoderInputContext: "encoder_hidden_states",
  decoderOutput: "logits",
  bosToken: 1,
  eosToken: 2,
  padToken: 0,
  decoderStartToken: 2,
  maxSeqLen: 512,
  decodeStrategy: "greedy",
  filterThres: 0.9,
  topP: 0.9,
  temperature: 1.0,
  channels: 3,
};

const FALLBACK_MIN_CONFIDENCE = 70;
const PIX2TEX_EARLY_ACCEPT_SCORE = 90;
const FALLBACK_EARLY_ACCEPT_CONFIDENCE = 88;
const MAX_DECODE_CANDIDATES = 8;
const MAX_FALLBACK_IMAGE_CANDIDATES = 6;

module.exports = {
  DEFAULT_CONFIG,
  FALLBACK_MIN_CONFIDENCE,
  PIX2TEX_EARLY_ACCEPT_SCORE,
  FALLBACK_EARLY_ACCEPT_CONFIDENCE,
  MAX_DECODE_CANDIDATES,
  MAX_FALLBACK_IMAGE_CANDIDATES,
};

