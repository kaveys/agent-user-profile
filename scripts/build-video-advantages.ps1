# build-video-advantages.ps1 — 生成「agent-user-profile 优势介绍」中文旁白视频（≥60 秒）
# 用法：pwsh -File scripts/build-video-advantages.ps1
# 依赖：Windows GDI+（System.Drawing）、SAPI 中文语音、ffmpeg。
# 全部素材在本机离线生成，不下载任何第三方素材。

param(
  [string]$OutFile = 'docs/video/intro-advantages.mp4',
  [string]$Voice   = 'Microsoft Huihui Desktop',
  [int]$Rate       = 0
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Speech

$Ffmpeg = if ($env:FFMPEG) { $env:FFMPEG } else { '<home>\AppData\Local\Programs\ffmpeg\bin\ffmpeg.exe' }
$Ffprobe = Join-Path (Split-Path $Ffmpeg) 'ffprobe.exe'
$Root = Split-Path -Parent $PSScriptRoot
$Work = Join-Path $PSScriptRoot 'video-build'
$Shots = Join-Path $Root 'docs/screenshots'
New-Item -ItemType Directory -Force -Path $Work | Out-Null

$W = 1280; $H = 720
$FontFile = 'C:\Windows\Fonts\msyh.ttc'
$FontBold = 'C:\Windows\Fonts\msyhbd.ttc'

# ---------------------------------------------------------------- 调色板
$C = @{
  bg     = [Drawing.ColorTranslator]::FromHtml('#0E1116')
  panel  = [Drawing.ColorTranslator]::FromHtml('#171C24')
  line   = [Drawing.ColorTranslator]::FromHtml('#2A323D')
  text   = [Drawing.ColorTranslator]::FromHtml('#E8ECF2')
  dim    = [Drawing.ColorTranslator]::FromHtml('#93A0AF')
  accent = [Drawing.ColorTranslator]::FromHtml('#6FA8FF')
  ok     = [Drawing.ColorTranslator]::FromHtml('#58C08A')
  warn   = [Drawing.ColorTranslator]::FromHtml('#E0B15A')
}

function New-Font([single]$size, [bool]$bold = $false) {
  $style = if ($bold) { [Drawing.FontStyle]::Bold } else { [Drawing.FontStyle]::Regular }
  return [Drawing.Font]::new('Microsoft YaHei', $size, $style, [Drawing.GraphicsUnit]::Pixel)
}

function Draw-Text($g, [string]$s, [single]$x, [single]$y, [single]$size, $color, [bool]$bold = $false, [single]$boxW = 1100) {
  $f = New-Font $size $bold
  $b = [Drawing.SolidBrush]::new($color)
  $rect = [Drawing.RectangleF]::new($x, $y, $boxW, ($size * 6))
  $g.DrawString($s, $f, $b, $rect)
  $b.Dispose(); $f.Dispose()
}

function New-Slide([scriptblock]$draw) {
  $bmp = [Drawing.Bitmap]::new($W, $H)
  $g = [Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [Drawing.Text.TextRenderingHint]::ClearTypeGridFit
  $g.Clear($C.bg)
  # 顶部细装饰线
  $pen = [Drawing.Pen]::new([Drawing.Color]::FromArgb(90, $C.accent), 2)
  $g.DrawLine($pen, 0, 0, $W, 0)
  $pen.Dispose()
  & $draw $g
  return @($bmp, $g)
}

function Save-Slide($bmp, $g, [string]$path) {
  $g.Dispose()
  $bmp.Save($path, [Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

# 底部字幕条（烧进画面，避免 ffmpeg 转义中文）
function Draw-Subtitle($g, [string]$s) {
  $bandH = 96
  $band = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(170, 8, 10, 14))
  $g.FillRectangle($band, 0, ($H - $bandH), $W, $bandH)
  $band.Dispose()
  $f = New-Font 25 $false
  $b = [Drawing.SolidBrush]::new($C.text)
  $fmt = [Drawing.StringFormat]::new()
  $fmt.Alignment = [Drawing.StringAlignment]::Center
  $rect = [Drawing.RectangleF]::new(60, ($H - $bandH + 22), ($W - 120), 70)
  $g.DrawString($s, $f, $b, $rect, $fmt)
  $b.Dispose(); $f.Dispose(); $fmt.Dispose()
}

function Draw-Shot($g, [string]$name, [single]$x, [single]$y, [single]$maxW, [single]$maxH) {
  $path = Join-Path $Shots $name
  if (-not (Test-Path $path)) {
    $b = [Drawing.SolidBrush]::new($C.panel)
    $g.FillRectangle($b, $x, $y, $maxW, $maxH)
    $b.Dispose()
    Draw-Text $g "（占位：$name 缺失）" ($x + 24) ($y + 24) 20 $C.dim
    return
  }
  $img = [Drawing.Image]::FromFile($path)
  $scale = [Math]::Min($maxW / $img.Width, $maxH / $img.Height)
  $w = $img.Width * $scale; $h = $img.Height * $scale
  $frame = [Drawing.SolidBrush]::new($C.panel)
  $g.FillRectangle($frame, ($x - 6), ($y - 6), ($w + 12), ($h + 12))
  $frame.Dispose()
  $g.DrawImage($img, $x, $y, $w, $h)
  $img.Dispose()
}

function Draw-Pill($g, [string]$text, [single]$x, [single]$y, $color) {
  $f = New-Font 18 $true
  $size = $g.MeasureString($text, $f)
  $rect = [Drawing.RectangleF]::new($x, $y, ($size.Width + 26), 32)
  $fill = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(38, $color))
  $g.FillRectangle($fill, $rect)
  $fill.Dispose()
  $pen = [Drawing.Pen]::new($color, 1)
  $g.DrawRectangle($pen, $x, $y, ($size.Width + 26), 32)
  $pen.Dispose()
  $b = [Drawing.SolidBrush]::new($color)
  $g.DrawString($text, $f, $b, ($x + 13), ($y + 6))
  $b.Dispose(); $f.Dispose()
}

# ---------------------------------------------------------------- 分镜定义
# 每场：Name / Narration（旁白，逐字）/ Subtitle（字幕，与旁白一致，可断行）/ Draw
$Scenes = @(
  @{
    Name = '01-hook'
    Narration = '同一个 Agent，每开一个新会话，都要重新认识你一遍。你的偏好、习惯、红线，全部归零。'
    Subtitle  = '同一个 Agent，每开一个新会话，都要重新认识你一遍。偏好、习惯、红线，全部归零。'
    Draw = {
      param($g)
      Draw-Pill $g '开场' 100 120 $C.accent
      Draw-Text $g '每开一个新会话' 100 200 58 $C.text $true
      Draw-Text $g '它就把你忘了' 100 288 58 $C.accent $true
      Draw-Text $g '偏好、习惯、红线 —— 一条都不剩' 100 400 26 $C.dim
      Draw-Text $g '画像层要解决的，就是这件事' 100 452 26 $C.dim
    }
  },
  @{
    Name = '02-pain'
    Narration = '能做记忆的插件不少。但常见的问题是：它记了什么，你看不见；能改的键，你改不动；出了问题，也没人告诉你哪一步错了。'
    Subtitle  = '能做记忆的插件不少。但它记了什么你看不见，能改的键改不动，出了问题也说不出哪一步错了。'
    Draw = {
      param($g)
      Draw-Pill $g '通则性痛点' 100 120 $C.warn
      Draw-Text $g '记住 ≠ 可查、可改、可测' 100 196 46 $C.text $true
      $items = @(
        @('看得见', '它记了什么，界面上查不到'),
        @('改得动', '关键开关写死在代码里'),
        @('错得起', '出问题没有自检、没有回归')
      )
      $y = 292
      foreach ($it in $items) {
        $card = [Drawing.SolidBrush]::new($C.panel)
        $g.FillRectangle($card, 100, $y, 1080, 92)
        $card.Dispose()
        Draw-Text $g $it[0] 128 ($y + 26) 26 $C.warn $true 200
        Draw-Text $g $it[1] 330 ($y + 28) 24 $C.text $false 800
        $y += 112
      }
    }
  },
  @{
    Name = '03-bidirectional'
    Narration = '这个插件把能改和看得见，绑成同一条规矩：配置里能 set 的每一个键，面板上必须看得到；反过来，面板上的每个键，都必须改得动。两个方向一起查，漂移就躲不掉。'
    Subtitle  = '能 set 的每个键，面板必须看得到；面板上的每个键，必须改得动。两个方向一起查。'
    Draw = {
      param($g)
      Draw-Pill $g '优势一 · 双向核对' 100 120 $C.ok
      Draw-Text $g '能改 ↔ 看得见' 100 192 46 $C.text $true
      Draw-Text $g '只查一个方向时，漂移可以躲在另一个方向。' 100 258 24 $C.dim
      Draw-Shot $g '06-settings.png' 620 320 600 320
      Draw-Text $g 'set list  →  panel.settings' 100 330 26 $C.ok $true
      Draw-Text $g 'panel.settings  →  set' 100 376 26 $C.accent $true
      Draw-Text $g '上一轮：13 个键能改却看不到，已全部补齐' 100 452 24 $C.dim
      Draw-Text $g '现在 31 项核对全绿' 100 490 24 $C.ok
    }
  },
  @{
    Name = '04-evidence'
    Narration = '它还回答两个问题。这条为什么被带进本轮？用 explain 看相关度，百分之多少、够不够门槛、哪些被挡在外面。画像现在是健康的吗？用 health 看五项打分，短板直接给建议。'
    Subtitle  = '这条为什么被带进本轮？explain 给相关度。画像健康吗？health 五项打分，短板直接给建议。'
    Draw = {
      param($g)
      Draw-Pill $g '优势二 · 证据可查' 100 120 $C.ok
      Draw-Text $g 'explain 与 health' 100 192 46 $C.text $true
      Draw-Shot $g '01-overview.png' 700 300 520 340
      Draw-Text $g 'explain "界面美化 风格"' 100 300 24 $C.accent $true
      Draw-Text $g '带入 6 / 18 · 其余列明被挡原因' 100 340 24 $C.text
      Draw-Text $g 'health' 100 410 24 $C.accent $true
      Draw-Text $g '新鲜度 / 覆盖度 / 精度 / 一致性 / 重点' 100 450 24 $C.text
      Draw-Text $g '实测 96 / 100，短板给建议' 100 490 24 $C.ok
    }
  },
  @{
    Name = '05-tests'
    Narration = '配套的是一整套自检。单元自检，三轮边界审计，兼容性测试，渲染烟测，还有打真实宿主的端到端。最近一次全绿：三十三、三十四、五十一、二十二、三十一、二十五，安装体检十三项。数字都在仓库里，可以自己跑。'
    Subtitle  = '单元自检 + 三轮边界审计 + 兼容性 + 渲染烟测 + 真实端到端，最近一次全绿。数字在仓库里，可自跑。'
    Draw = {
      param($g)
      Draw-Pill $g '优势三 · 配套自检' 100 120 $C.ok
      Draw-Text $g '七套测试，不是口号' 100 192 46 $C.text $true
      $rows = @(
        @('_selftest.mjs', '单元自检', '全部通过'),
        @('_audit.mjs', '边界审计 一', '33 / 33'),
        @('_audit2.mjs', '边界审计 二', '34 / 34'),
        @('_audit3.mjs', '逻辑审计 三', '51 / 51'),
        @('_audit4.mjs', '兼容性审计 四', '22 / 22'),
        @('_audit5.mjs', '双向核对 五', '31 / 31'),
        @('_audit6.mjs', '异常输入 六', '25 / 25'),
        @('verify-install.mjs', '安装体检', '13 / 13')
      )
      $y = 268
      foreach ($r in $rows) {
        Draw-Text $g $r[0] 100 $y 21 $C.accent $false 300
        Draw-Text $g $r[1] 420 $y 21 $C.dim $false 360
        Draw-Text $g $r[2] 860 $y 21 $C.ok $true 300
        $y += 46
      }
    }
  },
  @{
    Name = '06-norestart'
    Narration = '生效方式也很克制。命令行每次现起进程，改完立即生效；界面走热重载，刷新就好；只有新增面板动作，才需要重启一次。删掉的数据也不怕，每次删除前自动留快照，可以整批还原。'
    Subtitle  = '改完立即生效：CLI 现起进程、界面热重载；只有新增面板动作要重启一次。删除前自动留快照。'
    Draw = {
      param($g)
      Draw-Pill $g '优势四 · 免重启、可回滚' 100 120 $C.ok
      Draw-Text $g '改完就跑，删错能还原' 100 192 46 $C.text $true
      $rows = @(
        @('bin/profile.mjs', '立即生效', '每次请求现起进程'),
        @('client.js', '刷新即可', '宿主热重载'),
        @('index.js 新增动作', '重启一次', '仅这一种情况')
      )
      $y = 292
      foreach ($r in $rows) {
        $card = [Drawing.SolidBrush]::new($C.panel)
        $g.FillRectangle($card, 100, $y, 1080, 84)
        $card.Dispose()
        Draw-Text $g $r[0] 128 ($y + 24) 23 $C.text $true 340
        Draw-Text $g $r[1] 500 ($y + 24) 23 $C.ok $true 200
        Draw-Text $g $r[2] 700 ($y + 24) 21 $C.dim $false 460
        $y += 104
      }
      Draw-Text $g '每次写入前留快照 · 面板「恢复点」一键还原' 100 618 22 $C.accent
    }
  },
  @{
    Name = '07-proof'
    Narration = '实测一次双向一致。把相关性门槛改成零点二，面板读回来就是零点二；改回零点一二，面板跟着回到零点一二。命令行说什么，界面就显示什么。'
    Subtitle  = '实测：门槛改 0.2 → 面板读到 0.2；改回 0.12 → 面板回到 0.12。'
    Draw = {
      param($g)
      Draw-Pill $g '实测 · 不是说法' 100 120 $C.accent
      Draw-Text $g '同一条事实，两边一致' 100 192 46 $C.text $true
      $card = [Drawing.SolidBrush]::new($C.panel)
      $g.FillRectangle($card, 100, 262, 1080, 300)
      $card.Dispose()
      $lines = @(
        '$ profile set inject.relevanceFloor 0.2',
        '  已更新 inject.relevanceFloor = 0.2',
        '$ profile panel  |  .settings.inject.relevanceFloor',
        '  0.2',
        '$ profile set inject.relevanceFloor 0.12',
        '$ profile panel  |  .settings.inject.relevanceFloor',
        '  0.12'
      )
      $y = 286
      foreach ($l in $lines) {
        $color = if ($l.StartsWith('$')) { $C.accent } else { $C.text }
        Draw-Text $g $l 132 $y 22 $color $false 1020
        $y += 38
      }
      Draw-Text $g '数字与上一轮回归结果完全一致' 100 596 22 $C.dim
    }
  },
  @{
    Name = '08-outro'
    Narration = '它记的是怎么做更像你，不是发生过什么。没有设置页的调试参数，没有写死的门槛，没有你按不到的开关。仓库名 agent-user-profile，测试可以自己跑一遍。'
    Subtitle  = '记的是怎么做更像你，不是发生过什么。仓库 agent-user-profile，测试可自跑。'
    Draw = {
      param($g)
      Draw-Text $g 'agent-user-profile' 100 210 52 $C.accent $true
      Draw-Text $g 'Agent 的用户画像层' 100 288 40 $C.text $true
      Draw-Text $g '可查 · 可改 · 可测 · 可回滚' 100 366 28 $C.dim
      Draw-Text $g 'github.com/OWNER/agent-user-profile' 100 440 24 $C.dim
      Draw-Pill $g 'MIT' 100 520 $C.ok
      Draw-Pill $g 'node >= 20' 210 520 $C.accent
      Draw-Pill $g '34 / 13 / 51 / 31 … 全绿' 380 520 $C.ok
    }
  }
)

# ---------------------------------------------------------------- 逐场渲染
$segments = @()
$srts = @()
$timeline = @()
$t = 0.0
$i = 0

foreach ($s in $Scenes) {
  $i++
  $png = Join-Path $Work ("{0}.png" -f $s.Name)
  $wav = Join-Path $Work ("{0}.wav" -f $s.Name)
  $mp4 = Join-Path $Work ("{0}.mp4" -f $s.Name)

  if (-not (Test-Path $wav)) {
    $pair = New-Slide { param($g) & $s.Draw $g; Draw-Subtitle $g $s.Subtitle }
    Save-Slide $pair[0] $pair[1] $png
  }

  if (-not (Test-Path $wav)) {
    $sp = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $sp.SelectVoice($Voice)
    $sp.Rate = $Rate
    $sp.SetOutputToWaveFile($wav)
    $sp.Speak($s.Narration)
    $sp.Dispose()
  }

  if ((Test-Path $wav) -and -not (Test-Path $png)) { } # 占位，避免误删
  $dur = [double](& $Ffprobe -v error -show_entries format=duration -of csv=p=0 $wav)
  $hold = [Math]::Round($dur + 0.45, 2)
  $fadeOut = [Math]::Max(0, $hold - 0.35)

  if (-not (Test-Path $mp4)) {
  & $Ffmpeg -y -loglevel error -loop 1 -i $png -i $wav `
    -vf ("scale={0}:{1},fade=t=in:st=0:d=0.25,fade=t=out:st={2}:d=0.35" -f $W, $H, $fadeOut) `
    -af 'apad=pad_dur=0.45' -t $hold `
    -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -r 30 `
    -c:a aac -b:a 160k -ar 44100 -ac 1 $mp4
  }

  $segments += $mp4
  $timeline += [pscustomobject]@{ Scene = $s.Name; Start = $t; End = ($t + $hold); Chars = $s.Narration.Length }

  $srtStart = [TimeSpan]::FromSeconds($t)
  $srtEnd = [TimeSpan]::FromSeconds($t + $hold - 0.1)
  $srts += ("{0}`r`n{1} --> {2}`r`n{3}`r`n" -f $i, $srtStart.ToString('hh\:mm\:ss\,fff'), $srtEnd.ToString('hh\:mm\:ss\,fff'), $s.Subtitle)
  $t += $hold
  Write-Host ("[scene {0}] {1}  {2:N2}s" -f $i, $s.Name, $hold)
}

# ---------------------------------------------------------------- 背景音乐（离线合成，克制）
$bedRaw = Join-Path $Work 'bed-raw.wav'
$bed = Join-Path $Work 'bed.wav'
$total = [Math]::Round($t + 1.0, 2)
$bedOut = [Math]::Max(0, $total - 3)
$bedFilter = ('[0:a][1:a][2:a]amix=inputs=3:duration=longest,volume=0.05,lowpass=f=700,afade=t=in:st=0:d=2,afade=t=out:st={0}:d=3' -f $bedOut)
& $Ffmpeg -y -loglevel error -f lavfi -i ("sine=frequency=110:duration={0}" -f $total) `
  -f lavfi -i ("sine=frequency=164.81:duration={0}" -f $total) `
  -f lavfi -i ("sine=frequency=220:duration={0}" -f $total) `
  -filter_complex $bedFilter -ar 44100 -ac 1 $bedRaw
Copy-Item $bedRaw $bed

# ---------------------------------------------------------------- 拼接 + 混音
$listFile = Join-Path $Work 'list.txt'
# 用相对文件名 + 切换工作目录：路径里有中文，写进 list 的绝对路径会被当成本地编码
Push-Location $Work
try {
  ($segments | ForEach-Object { "file '$(Split-Path -Leaf $_)'" }) -join "`n" | Set-Content $listFile -Encoding utf8
  & $Ffmpeg -y -loglevel error -f concat -safe 0 -i 'list.txt' -c copy 'concat.mp4'
  if ($LASTEXITCODE -ne 0) { throw "concat 失败（exit $LASTEXITCODE）" }
} finally { Pop-Location }
$silent = Join-Path $Work 'concat.mp4'

$outPath = Join-Path $Root $OutFile
New-Item -ItemType Directory -Force -Path (Split-Path $outPath) | Out-Null
& $Ffmpeg -y -loglevel error -i $silent -i $bed `
  -filter_complex '[0:a]volume=1.0[a0];[1:a]volume=0.55[a1];[a0][a1]amix=inputs=2:duration=first:normalize=0[aout]' `
  -map 0:v -map '[aout]' -c:v copy -c:a aac -b:a 192k -movflags +faststart $outPath

# ---------------------------------------------------------------- 字幕与旁白文本
$srtPath = Join-Path $Root 'docs/video/intro-advantages.srt'
Set-Content $srtPath ($srts -join "`r`n") -Encoding UTF8

$scriptPath = Join-Path $Root 'docs/video/intro-advantages-narration.txt'
$lines = @()
$lines += 'agent-user-profile 优势介绍 · 旁白全文（与烧入字幕逐句对应）'
$lines += ''
foreach ($s in $Scenes) { $lines += ('[' + $s.Name + '] ' + $s.Narration); $lines += '' }
Set-Content $scriptPath ($lines -join "`r`n") -Encoding UTF8

Write-Host ''
Write-Host ("总时长：{0:N2} 秒" -f $t)
$timeline | Format-Table -AutoSize | Out-String | Write-Host
Write-Host ("成片：{0}" -f $outPath)
Write-Host ("字幕：{0}" -f $srtPath)
Write-Host ("旁白：{0}" -f $scriptPath)
