"""tts.py — 把一段中文文本合成语音（本地小模型优先，云端兜底）。

用法：
    python scripts/tts.py <文本文件> <输出文件> [引擎] [音色] [语速]

引擎：
    kokoro   本地 Kokoro-82M 小模型（默认，离线、24kHz、自然女声）
    edge     微软 edge-tts 神经音色（需要联网）

音色：
    kokoro 默认 zf_xiaoxiao（也可以 zf_xiaoni / zf_xiaobei / zf_xiaoyi）
    edge   默认 zh-CN-XiaoxiaoNeural

输出：kokoro 写 .wav（24kHz float→PCM16）；edge 写 .mp3。
"""

import os
import sys


def _read(path: str) -> str:
    with open(path, encoding="utf-8") as handle:
        return handle.read().strip()


def synth_kokoro(text: str, out_path: str, voice: str, speed: float) -> int:
    import numpy as np
    import soundfile as sf
    from kokoro import KPipeline

    # lang_code='z' 走中文 G2P（misaki[zh]：jieba + pypinyin）
    pipe = KPipeline(lang_code="z")
    chunks = []
    for _gs, _ps, audio in pipe(text, voice=voice, speed=speed, split_pattern=r"[。！？；\n]+"):
        chunks.append(audio.detach().cpu().numpy())
    if not chunks:
        print("kokoro: 没有合成出音频", file=sys.stderr)
        return 1
    data = np.concatenate(chunks)
    sf.write(out_path, data, 24000, subtype="PCM_16")
    return 0


def synth_edge(text: str, out_path: str, voice: str, rate: str) -> int:
    import asyncio

    import edge_tts

    kwargs = {"voice": voice}
    if rate:
        kwargs["rate"] = rate
    asyncio.run(edge_tts.Communicate(text, **kwargs).save(out_path))
    return 0


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: tts.py <textfile> <out> [kokoro|edge] [voice] [speed]", file=sys.stderr)
        return 2

    text_path, out_path = sys.argv[1], sys.argv[2]
    engine = (sys.argv[3] if len(sys.argv) > 3 else os.environ.get("TTS_ENGINE") or "kokoro").lower()
    voice = sys.argv[4] if len(sys.argv) > 4 else os.environ.get("TTS_VOICE") or ""
    speed_raw = sys.argv[5] if len(sys.argv) > 5 else os.environ.get("TTS_SPEED") or ""

    text = _read(text_path)
    if not text:
        print("空文本", file=sys.stderr)
        return 1

    if engine == "edge":
        return synth_edge(text, out_path, voice or "zh-CN-XiaoxiaoNeural", speed_raw or "-4%")

    try:
        return synth_kokoro(text, out_path, voice or "zf_xiaoxiao", float(speed_raw or "0.92"))
    except Exception as error:  # 模型缺失/下载失败 → 退回云端，不让出片流程断掉
        print(f"kokoro 失败（{error}），退回 edge-tts", file=sys.stderr)
        fallback = out_path[:-4] + ".mp3" if out_path.lower().endswith(".wav") else out_path
        rc = synth_edge(text, fallback, "zh-CN-XiaoxiaoNeural", "-4%")
        if rc == 0:
            print(f"fallback:{fallback}")
        return rc


if __name__ == "__main__":
    raise SystemExit(main())
