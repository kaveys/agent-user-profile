"""tts.py — 把一段中文文本合成语音（本地小模型优先，云端兜底）。

用法：
    python scripts/tts.py <文本文件> <输出文件> [引擎] [音色] [语速]

引擎：
    chattts  本地 ChatTTS（对话式韵律，听起来最像人在说话；需要 pip install ChatTTS）
    kokoro   本地 Kokoro-82M 小模型（离线、24kHz）
    edge     微软 edge-tts 神经音色（需要联网）

音色：
    chattts 用第五个参数当 seed（同一个 seed 永远是同一个声音；3 是女声）
    kokoro  默认 zf_xiaoxiao（也可以 zf_xiaoni / zf_xiaobei / zf_xiaoyi）
    edge    默认 zh-CN-XiaoxiaoNeural

输出：chattts / kokoro 写 .wav（24kHz PCM16）；edge 写 .mp3。
"""

import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))


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


def synth_chattts(text: str, out_path: str, voice: str, seed: str) -> int:
    """对话式韵律的本地模型。seed 就是音色编号（同 seed 同声音）。"""
    speaker = ""
    if voice.endswith(".npy"):
        speaker = voice if os.path.isabs(voice) else os.path.join(HERE, "voices", voice)
        if not os.path.exists(speaker):
            print(f"chattts: 找不到音色 {speaker}", file=sys.stderr)
            return 1
    helper = os.path.join(HERE, "tts_chattts.py")
    python = os.environ.get("CHATTTS_PY") or sys.executable
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as handle:
        handle.write(text)
        text_path = handle.name
    try:
        result = subprocess.run(
            [python, helper, text_path, out_path, speaker, seed or "20261118"],
            capture_output=True,
            text=True,
        )
    finally:
        os.unlink(text_path)
    if result.returncode != 0:
        print((result.stderr or result.stdout or "chattts 失败").strip()[-300:], file=sys.stderr)
    return result.returncode


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

    if engine == "chattts":
        return synth_chattts(text, out_path, voice or "warm", speed_raw or "20261118")

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
