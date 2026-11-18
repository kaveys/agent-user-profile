#!/usr/bin/env python3
"""ChatTTS engine for the trailer voice.

ChatTTS is a conversational model: its prosody moves more than a reading TTS,
which is exactly what makes a narration sound spoken rather than recited.
It is not on PyPI-optional here — install it first:

    pip install ChatTTS vocos vector_quantize_pytorch

Usage:
    python tts_chattts.py <text|text-file> <out.wav> [speaker.npy] [seed]

The speaker embedding pins the voice: the same .npy always sounds the same.
Set HF_ENDPOINT=https://hf-mirror.com when huggingface.co is not reachable.
"""
import os
import sys
import wave

import numpy as np


def read_text(arg: str) -> str:
    if os.path.exists(arg):
        with open(arg, encoding="utf-8") as handle:
            return handle.read().strip()
    return arg


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    text = read_text(sys.argv[1])
    out = sys.argv[2]
    speaker = sys.argv[3] if len(sys.argv) > 3 else ""
    seed = int(sys.argv[4]) if len(sys.argv) > 4 else 20261118

    import torch

    try:
        import ChatTTS
    except ImportError:
        print("chattts-unavailable: pip install ChatTTS vocos vector_quantize_pytorch", file=sys.stderr)
        return 3

    torch.set_num_threads(max(1, (os.cpu_count() or 8) - 2))

    chat = ChatTTS.Chat()
    chat.load(compile=False, source="huggingface")

    # 同一个 seed → 同一个音色（sample_random_speaker 由 torch 随机数决定），
    # 所以 seed 就是音色编号，不用存 embedding 文件，也不会有编码问题。
    emb_file = speaker if speaker.endswith(".npy") else ""
    if emb_file and os.path.exists(emb_file):
        loaded = np.load(emb_file, allow_pickle=True)
        emb = loaded.item() if loaded.shape == () else loaded
        if isinstance(emb, np.ndarray) and emb.dtype.kind in "iuf":
            emb = torch.from_numpy(emb).float()
    else:
        torch.manual_seed(seed)
        emb = chat.sample_random_speaker()

    torch.manual_seed(seed)

    params_infer = ChatTTS.Chat.InferCodeParams(spk_emb=emb, temperature=0.3, top_P=0.7, top_K=20)
    params_refine = ChatTTS.Chat.RefineTextParams(prompt="[oral_0][laugh_0][break_4]")

    wavs = chat.infer([text], params_infer_code=params_infer, params_refine_text=params_refine, use_decoder=True)
    audio = np.asarray(wavs[0], dtype=np.float32).squeeze()
    if audio.size == 0:
        print("chattts-empty", file=sys.stderr)
        return 4

    peak = float(np.abs(audio).max()) or 1.0
    pcm = (audio / peak * 0.9 * 32767).astype(np.int16)
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with wave.open(out, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(24000)
        handle.writeframes(pcm.tobytes())
    print(f"wrote {out} {len(pcm) / 24000:.2f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
