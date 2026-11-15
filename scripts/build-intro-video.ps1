# 生成功能介绍短片：静音、1280x720、约 38 秒。
# 关键约束：ffmpeg 8 的 filter 里不能出现未转义的盘符冒号，也不能用单引号包值。
# 解决办法：所有素材（字体、文本、截图）复制进工作目录，用相对文件名引用，cwd 设为工作目录。
$ErrorActionPreference = 'Stop'
$root = '<home>\Desktop\DSH默认工作区\20261114-2354-用户画像插件'
$work = Join-Path $env:TEMP 'upvideo'
$out  = Join-Path $root 'docs\video'
New-Item -ItemType Directory -Force -Path $work, $out | Out-Null
$ff = '<home>\AppData\Local\Programs\ffmpeg\bin\ffmpeg.exe'

Copy-Item 'C:\Windows\Fonts\msyh.ttc'  (Join-Path $work 'msyh.ttc')  -Force
Copy-Item 'C:\Windows\Fonts\msyhbd.ttc' (Join-Path $work 'msyhbd.ttc') -Force

function TextFile($name, $content) {
  Set-Content -Path (Join-Path $work "$name.txt") -Value $content -Encoding utf8 -NoNewline
  return "$name.txt"
}
function FilterFile($name, $line) {
  Set-Content -Path (Join-Path $work "$name.flt") -Value $line -Encoding utf8 -NoNewline
  return "$name.flt"
}
function Run($argv) {
  Push-Location $work
  try {
    & $ff @argv
    if ($LASTEXITCODE -ne 0) { throw "ffmpeg 失败：$($argv -join ' ')" }
  } finally { Pop-Location }
}
function Fade($dur) {
  $st = [math]::Round(([double]$dur) - 0.4, 2)
  return "fade=t=in:st=0:d=0.4,fade=t=out:st=${st}:d=0.4,format=yuv420p[v]"
}

$shots = @{
  overview = 'docs\screenshots\01-overview.png'
  items    = 'docs\screenshots\02-items.png'
  pending  = 'docs\screenshots\03-pending.png'
}
foreach ($k in $shots.Keys) { Copy-Item (Join-Path $root $shots[$k]) (Join-Path $work "$k.png") -Force }

# ---------- 场景 1：标题 ----------
$t1 = TextFile 't1' 'agent-user-profile'
$t2 = TextFile 't2' 'Agent 的用户画像层'
$t3 = TextFile 't3' 'DSH 插件 · 核心也可纯 CLI 单独运行'
$f1 = "[0:v]drawtext=fontfile=msyhbd.ttc:textfile=${t1}:fontcolor=0xF5F7FA:fontsize=66:x=(w-text_w)/2:y=250"
$f1 += ",drawtext=fontfile=msyh.ttc:textfile=${t2}:fontcolor=0xA8B3C4:fontsize=30:x=(w-text_w)/2:y=350"
$f1 += ",drawtext=fontfile=msyh.ttc:textfile=${t3}:fontcolor=0x6C7686:fontsize=20:x=(w-text_w)/2:y=402,"
$f1 += (Fade 4)
Run @('-y','-f','lavfi','-i','color=c=0x0B0D10:s=1280x720:r=30','-t','4','-filter_complex_script',(FilterFile 's1' $f1),'-map','[v]','-c:v','libx264','-preset','medium','-crf','20','-pix_fmt','yuv420p','s1.mp4')

# ---------- 场景 2：问题 ----------
$p1 = TextFile 'p1' '每开一个新会话，你都要重新解释一遍：'
$p2 = TextFile 'p2' '我喜欢什么样 · 别用什么 · 按什么标准算做完'
$p3 = TextFile 'p3' '画像解决的，就是这件事。'
$f2 = "[0:v]drawtext=fontfile=msyh.ttc:textfile=${p1}:fontcolor=0xE6EAF0:fontsize=34:x=(w-text_w)/2:y=250"
$f2 += ",drawtext=fontfile=msyh.ttc:textfile=${p2}:fontcolor=0x8E98A8:fontsize=24:x=(w-text_w)/2:y=310"
$f2 += ",drawtext=fontfile=msyhbd.ttc:textfile=${p3}:fontcolor=0x4C8DFF:fontsize=30:x=(w-text_w)/2:y=400,"
$f2 += (Fade 6)
Run @('-y','-f','lavfi','-i','color=c=0x0B0D10:s=1280x720:r=30','-t','6','-filter_complex_script',(FilterFile 's2' $f2),'-map','[v]','-c:v','libx264','-preset','medium','-crf','20','-pix_fmt','yuv420p','s2.mp4')

# ---------- 场景 3-5：截屏 + 字幕 ----------
function Shot($name, $title, $bullets, $dur, $file) {
  $tt = TextFile "${name}_t" $title
  $bb = TextFile "${name}_b" $bullets
  # 截图只取设置面板本身（裁掉任务栏、窗口边框与右侧终端），放大到 660 高放左侧
  $line = "[0:v]crop=680:730:455:45,scale=-2:660[shot];color=c=0x0B0D10:s=1280x720:r=30[bg];[bg][shot]overlay=x=62:y=30[base];"
  $line += "[base]drawtext=fontfile=msyhbd.ttc:textfile=${tt}:fontcolor=0xF5F7FA:fontsize=32:x=800:y=250"
  $line += ",drawtext=fontfile=msyh.ttc:textfile=${bb}:fontcolor=0x9AA6B8:fontsize=21:x=800:y=320:line_spacing=14,"
  $line += (Fade $dur)
  Run @('-y','-loop','1','-i',"$name.png",'-t',"$dur",'-filter_complex_script',(FilterFile $name $line),'-map','[v]','-c:v','libx264','-preset','medium','-crf','20','-pix_fmt','yuv420p',$file)
}

Shot 'overview' '每次任务前，画像自动叠加' ('· 13 条画像，5 个维度有条目' + "`n" + '· 越靠上越先被采用' + "`n" + '· 画像过期会直接提示') 8 's3.mp4'
Shot 'items' '每条都能改' ('· 权重 − / + 随手调' + "`n" + '· 内容、分类可编辑' + "`n" + '· 删除前自动留快照') 8 's4.mp4'
# 场景 5：纯 CLI 也能用（不需要宿主）
Copy-Item 'C:\Windows\Fonts\consola.ttf' (Join-Path $env:TEMP 'upvideo\consola.ttf') -Force
$ct = TextFile 'c_title' '也可以只用命令行'
$cl = TextFile 'c_lines' ('node bin/profile.mjs init' + "`n" + 'node bin/profile.mjs declare --dim taste --fact "…"' + "`n" + 'node bin/profile.mjs build --all-scopes' + "`n" + 'cat ~/.dsh/user-profile/inject.md')
$f5 = "[0:v]drawtext=fontfile=msyhbd.ttc:textfile=${ct}:fontcolor=0xF5F7FA:fontsize=32:x=(w-text_w)/2:y=248"
$f5 += ",drawtext=fontfile=consola.ttf:textfile=${cl}:fontcolor=0x8FB6FF:fontsize=19:x=(w-text_w)/2:y=316:line_spacing=16,"
$f5 += (Fade 7)
Run @('-y','-f','lavfi','-i','color=c=0x0B0D10:s=1280x720:r=30','-t','7','-filter_complex_script',(FilterFile 's5' $f5),'-map','[v]','-c:v','libx264','-preset','medium','-crf','20','-pix_fmt','yuv420p','s5.mp4')

# ---------- 场景 6：结尾 ----------
$e1 = TextFile 'e1' '单轮喊停 · 快照回滚 · 规定与数据分离'
$e2 = TextFile 'e2' '说一句「这次别用画像」：只跳过这一轮，并在结果里说明'
$e3 = TextFile 'e3' 'github.com/OWNER/agent-user-profile'
$f6 = "[0:v]drawtext=fontfile=msyhbd.ttc:textfile=${e1}:fontcolor=0xF5F7FA:fontsize=32:x=(w-text_w)/2:y=270"
$f6 += ",drawtext=fontfile=msyh.ttc:textfile=${e2}:fontcolor=0x8E98A8:fontsize=21:x=(w-text_w)/2:y=334"
$f6 += ",drawtext=fontfile=msyh.ttc:textfile=${e3}:fontcolor=0x4C8DFF:fontsize=22:x=(w-text_w)/2:y=430,"
$f6 += (Fade 6)
Run @('-y','-f','lavfi','-i','color=c=0x0B0D10:s=1280x720:r=30','-t','6','-filter_complex_script',(FilterFile 's6' $f6),'-map','[v]','-c:v','libx264','-preset','medium','-crf','20','-pix_fmt','yuv420p','s6.mp4')

# ---------- 拼接 ----------
@('s1.mp4','s2.mp4','s3.mp4','s4.mp4','s5.mp4','s6.mp4') |
  ForEach-Object { "file '$_'" } |
  Set-Content (Join-Path $work 'list.txt') -Encoding utf8

Run @('-y','-f','concat','-safe','0','-i','list.txt','-c','copy','intro.mp4')
Copy-Item (Join-Path $work 'intro.mp4') (Join-Path $out 'intro.mp4') -Force
$size = (Get-Item (Join-Path $out 'intro.mp4')).Length
"生成完成：$(Join-Path $out 'intro.mp4')（$([math]::Round($size/1MB,2)) MB）"
