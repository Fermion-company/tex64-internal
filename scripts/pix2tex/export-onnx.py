#!/usr/bin/env python3
import argparse
import json
import os
from pathlib import Path

import torch
import yaml
from munch import Munch

import pix2tex
from pix2tex.models import get_model
from pix2tex.utils import parse_args
from pix2tex.model.checkpoints.get_latest_checkpoint import download_checkpoints

MODEL_ROOT = Path(pix2tex.__file__).resolve().parent / "model"


class EncoderWrapper(torch.nn.Module):
    def __init__(self, encoder):
        super().__init__()
        self.encoder = encoder

    def forward(self, image):
        return self.encoder(image)


class DecoderWrapper(torch.nn.Module):
    def __init__(self, decoder, pad_token):
        super().__init__()
        self.decoder = decoder
        self.pad_token = pad_token

    def forward(self, tokens, context):
        mask = tokens != self.pad_token
        return self.decoder(tokens, mask=mask, context=context)


def load_args(config_path, checkpoint_path):
    with open(config_path, "r", encoding="utf-8") as f:
        params = yaml.load(f, Loader=yaml.FullLoader)
    args = parse_args(Munch(params))
    args.no_cuda = True
    args.device = "cpu"
    args.wandb = False
    args.checkpoint = checkpoint_path
    return args


def export_onnx(args, output_dir):
    model = get_model(args)
    model.load_state_dict(torch.load(args.checkpoint, map_location="cpu"))
    model.eval()

    output_dir.mkdir(parents=True, exist_ok=True)
    encoder_path = output_dir / "encoder.onnx"
    decoder_path = output_dir / "decoder.onnx"

    dummy_image = torch.randn(1, 1, args.max_height, args.max_width, dtype=torch.float32)
    encoder = EncoderWrapper(model.encoder)
    with torch.no_grad():
        dummy_context = encoder(dummy_image)

    torch.onnx.export(
        encoder,
        dummy_image,
        encoder_path.as_posix(),
        input_names=["image"],
        output_names=["context"],
        dynamic_axes={"image": {2: "height", 3: "width"}, "context": {1: "seq_len"}},
        opset_version=17,
    )

    decoder = DecoderWrapper(model.decoder, args.pad_token)
    dummy_tokens = torch.full((1, 1), args.bos_token, dtype=torch.long)
    torch.onnx.export(
        decoder,
        (dummy_tokens, dummy_context),
        decoder_path.as_posix(),
        input_names=["tokens", "context"],
        output_names=["logits"],
        dynamic_axes={
            "tokens": {1: "seq_len"},
            "context": {1: "ctx_len"},
            "logits": {1: "seq_len"},
        },
        opset_version=17,
    )

    config = {
        "encoder": "encoder.onnx",
        "decoder": "decoder.onnx",
        "tokenizer": "tokenizer.json",
        "encoderInput": "image",
        "encoderOutput": "context",
        "decoderInputTokens": "tokens",
        "decoderInputContext": "context",
        "decoderOutput": "logits",
        "bosToken": args.bos_token,
        "eosToken": args.eos_token,
        "padToken": args.pad_token,
        "maxSeqLen": args.max_seq_len,
        "decodeStrategy": "top_k",
        "filterThres": 0.9,
        "temperature": args.get("temperature", 0.2),
        "maxWidth": args.max_width,
        "maxHeight": args.max_height,
        "minWidth": args.get("min_width", 32),
        "minHeight": args.get("min_height", 32),
    }
    with open(output_dir / "config.json", "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)

    tokenizer_path = Path(args.tokenizer)
    if not tokenizer_path.is_absolute():
        tokenizer_path = (MODEL_ROOT / tokenizer_path).resolve()
    if tokenizer_path.exists():
        (output_dir / "tokenizer.json").write_bytes(tokenizer_path.read_bytes())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, help="Output directory for ONNX files.")
    parser.add_argument("--config", default=str(MODEL_ROOT / "settings" / "config.yaml"))
    parser.add_argument("--checkpoint", default=str(MODEL_ROOT / "checkpoints" / "weights.pth"))
    args = parser.parse_args()

    output_dir = Path(args.output)
    if not os.path.exists(args.checkpoint):
        download_checkpoints()

    config_path = Path(args.config)
    if not config_path.is_absolute():
        config_path = (MODEL_ROOT / config_path).resolve()
    checkpoint_path = Path(args.checkpoint)
    if not checkpoint_path.is_absolute():
        checkpoint_path = (MODEL_ROOT / checkpoint_path).resolve()
    pix_args = load_args(config_path, checkpoint_path)
    export_onnx(pix_args, output_dir)


if __name__ == "__main__":
    main()
