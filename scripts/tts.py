"""tts.py — 用 edge-tts 的神经网络音色把文本合成语音（离线调用，不依赖浏览器）。

用法：
    python scripts/tts.py <文本文件> <输出 mp3> [voice] [rate]

默认音色 zh-CN-XiaoxiaoNeural（自然女声），rate 形如 -4%。
"""

import asyncio
import sys

import edge_tts


async def main() -> int:
    if len(sys.argv) < 3:
        print("usage: tts.py <textfile> <out.mp3> [voice] [rate]", file=sys.stderr)
        return 2
    text_path, out_path = sys.argv[1], sys.argv[2]
    voice = sys.argv[3] if len(sys.argv) > 3 else "zh-CN-XiaoxiaoNeural"
    rate = sys.argv[4] if len(sys.argv) > 4 else "-4%"

    with open(text_path, encoding="utf-8") as handle:
        text = handle.read().strip()
    if not text:
        print("empty text", file=sys.stderr)
        return 1

    kwargs = {"voice": voice}
    if rate:
        kwargs["rate"] = rate
    await edge_tts.Communicate(text, **kwargs).save(out_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
