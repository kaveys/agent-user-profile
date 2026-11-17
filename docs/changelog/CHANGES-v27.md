# v27：介绍片改用本地语音模型重配（Kokoro-82M · 女声）

## 一、为什么换

用户听完 72 秒那版的原话：「音色太差了，可以跑一个文字转语音的小模型，但是一定要用好听拟真的女声」。

原配音是 `edge-tts` 的 `zh-CN-XiaoxiaoNeural`（云端神经音色）。问题不在发音准不准，而在三点：

| 症状 | 真实原因 |
| --- | --- |
| 像播音腔、没有起伏 | 云端音色是「标准朗读」风格，情绪几乎是平的 |
| 句尾拖、句间黏 | 整段一次合成，句间停顿由模型自己决定，和我们切好的字幕对不上 |
| 听着不像真人在跟你说话 | 48kHz→44.1kHz 再编码 + 低码率，齿音发闷 |

## 二、换成什么

**Kokoro-82M**（本地小模型，82M 参数，24kHz 输出）——不是云端，不上传任何文本。

| 项 | 值 |
| --- | --- |
| 引擎 | `kokoro`（Python 包 + `misaki[zh]`，jieba + pypinyin 做中文 G2P） |
| 音色 | `zf_xiaoxiao`（另有 `zf_xiaoni` / `zf_xiaobei` / `zf_xiaoyi` 可选） |
| 语速 | `0.92`（比默认略慢，句尾更稳） |
| 输出 | 24kHz WAV → ffmpeg 转 44.1kHz 单声道 |
| 依赖 | `torch`（本机已装）、`kokoro`、`misaki[zh]`、`soundfile` |
| 网络 | 首次会下载模型（约 327MB），之后完全离线 |

## 三、改了什么代码

- `scripts/tts.py` 重写：参数变成 `tts.py <文本> <输出> [引擎] [音色] [语速]`；`kokoro` 为默认引擎，**失败自动退回 edge-tts**（不让出片流程断在半路），失败信息走 stderr。
- `scripts/build-trailer.ps1`：
  - 参数 `-Voice` 由 `zh-CN-XiaoxiaoNeural` 改为 `zf_xiaoxiao`，新增 `-Engine`（kokoro/edge）、`-Speed`（默认 0.92）；
  - 配音分支改为「本地模型直接出 WAV → 重采样」或「edge 出 MP3 → 转 WAV」，两条路都归一成 44.1kHz 单声道再进合成；
  - `ffmpeg` / `ffprobe` 改为**环境变量优先、其次 PATH**（原来写 `Split-Path 'ffmpeg.exe'` 在没设 `$env:FFMPEG` 时直接报「自变量为空」，这次真撞上了）。

## 四、成片参数（实测）

| 项 | 值 |
| --- | --- |
| 文件 | `docs/video/agent-user-profile.mp4`（同名覆盖，引用不用改） |
| 时长 | **76.62 秒**（原 72.39 秒——新配音句间停顿更长） |
| 画面 | 1920×1080 / 30fps / H.264 |
| 声音 | AAC 44.1kHz 单声道；`volumedetect` mean **−20.4 dB** / max **−2.6 dB** |
| 体积 | 3.06 MB（318 kbps） |
| 字幕 | `agent-user-profile.srt` 八条，时间码由实际音频时长累加 |

七场时间码：0.00 / 7.13 / 21.56 / 31.49 / 43.24 / 56.34 / 67.52 / 76.55。

## 五、语音样本

同一句话（「你大概遇到过这种情况：每开一个新对话，都要从头说一遍…」）用四个音色各合成一遍，
中间留 0.6 秒间隔拼成一条 `voice-samples.mp3` 供试听：`zf_xiaoxiao` → `zf_xiaoni` → `zf_xiaobei` → `zf_xiaoyi`。
样本不进仓库（属一次性素材），需要时重跑：`python scripts/tts.py line.txt out.wav kokoro zf_xiaoni 0.92`。

## 六、仍未做

- 只有中文配音；英文版 README 里的视频仍是中文旁白。
- 没有做 AB 盲测——"更好听"目前只靠音色本身的拟真度与用户听感确认。
- 语速是按字数/秒（4.0–5.3）粗调的，没有做逐句重音标注。
