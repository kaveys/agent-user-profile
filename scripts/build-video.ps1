# 生成带中文旁白的介绍短片（约 60 秒，1280x720）
# 依赖：Windows SAPI 中文语音 + ffmpeg
param(
  [string]$Ffmpeg = '<home>\AppData\Local\Programs\ffmpeg\bin\ffmpeg.exe',
  [string]$OutDir = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $env:TEMP ('video-' + [guid]::NewGuid().ToString('N')) }
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$shots = Join-Path $root 'docs\screenshots'

# ---------- 设计令牌 ----------
$W = 1280; $H = 720
$bg      = [System.Drawing.Color]::FromArgb(14, 17, 22)
$card    = [System.Drawing.Color]::FromArgb(24, 28, 36)
$line    = [System.Drawing.Color]::FromArgb(45, 52, 64)
$fg      = [System.Drawing.Color]::FromArgb(238, 242, 248)
$fg2     = [System.Drawing.Color]::FromArgb(154, 165, 180)
$accent  = [System.Drawing.Color]::FromArgb(122, 162, 255)
$ok      = [System.Drawing.Color]::FromArgb(88, 214, 141)

$fontPath = 'C:\Windows\Fonts\msyh.ttc'
$fTitle = New-Object System.Drawing.FontFamily('Microsoft YaHei UI')
$fMono  = New-Object System.Drawing.FontFamily('Consolas')

function New-Canvas {
  $bmp = New-Object System.Drawing.Bitmap($W, $H)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'ClearTypeGridFit'
  $g.Clear($bg)
  # 顶部渐隐光带
  $rect = New-Object System.Drawing.Rectangle(0, 0, $W, 240)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, [System.Drawing.Color]::FromArgb(40, 90, 140, 255), $bg, 90.0)
  $g.FillRectangle($brush, $rect)
  $brush.Dispose()
  return @($bmp, $g)
}
function Txt($g, $text, $size, $color, $x, $y, $bold = $false, $family = $null) {
  $fam = if ($family) { $family } else { $fTitle }
  $style = if ($bold) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
  $font = New-Object System.Drawing.Font($fam, $size, $style, [System.Drawing.GraphicsUnit]::Pixel)
  $brush = New-Object System.Drawing.SolidBrush($color)
  $g.DrawString($text, $font, $brush, [single]$x, [single]$y)
  $brush.Dispose(); $font.Dispose()
}
function TxtW($g, $text, $size, $bold = $false) {
  $style = if ($bold) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
  $font = New-Object System.Drawing.Font($fTitle, $size, $style, [System.Drawing.GraphicsUnit]::Pixel)
  $w = $g.MeasureString($text, $font).Width
  $font.Dispose(); return $w
}
function RoundRect($g, $x, $y, $w, $h, $r, $fill, $stroke) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  if ($fill) { $b = New-Object System.Drawing.SolidBrush($fill); $g.FillPath($b, $p); $b.Dispose() }
  if ($stroke) { $pen = New-Object System.Drawing.Pen($stroke, 1); $g.DrawPath($pen, $p); $pen.Dispose() }
  $p.Dispose()
}
function Save($bmp, $g, $path) { $g.Dispose(); $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose() }

# ---------- 分镜 ----------
$scenes = @(
  @{ id = '1'; kind = 'title' },
  @{ id = '2'; kind = 'problem' },
  @{ id = '3'; kind = 'shot'; img = '01-overview.png'; kicker = '每次任务前'; head = '画像自动叠加到上下文'; note = '红线在前，个性化次之，背景参考垫底' },
  @{ id = '4'; kind = 'shot'; img = '02-items.png'; kicker = '你说得算'; head = '一条一条，权重可调'; note = '点 ＋ 抬高优先级，点 － 降下来，不满意随手删' },
  @{ id = '5'; kind = 'cli' },
  @{ id = '6'; kind = 'feats' },
  @{ id = '7'; kind = 'end' }
)

$narration = @{
  '1' = '这是 agent-user-profile，一个给编程助手用的用户画像层。'
  '2' = '每开一个新会话，你都得重新解释一遍自己的偏好、习惯和底线。'
  '3' = '它把这些沉淀成一份带权重的画像，每次任务开始前自动叠加进上下文。'
  '4' = '谁重要你说了算：点加号抬高优先级，点减号降下来，不满意随手删掉。'
  '5' = '不装插件也能用，三行命令就能生成注入片段，任何编程助手都吃。'
  '6' = '还有单轮喊停、快照回滚、写入前自动脱敏，以及给别的宿主用的 M C P 接口。'
  '7' = '仓库地址在屏幕上，欢迎试用，也欢迎提 issue。'
}

# ---------- 合成语音 ----------
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(44100, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$durations = @{}
foreach ($k in $narration.Keys) {
  $wav = Join-Path $OutDir "n$k.wav"
  $sp = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $sp.SelectVoice('Microsoft Huihui Desktop')
  $sp.Rate = 0
  $sp.SetOutputToWaveFile($wav, $fmt)
  $sp.Speak($narration[$k])
  $sp.Dispose()
  $durations[$k] = (Get-Item $wav).Length
}

# ---------- 逐场景出图 ----------
foreach ($s in $scenes) {
  $b = New-Canvas; $bmp = $b[0]; $g = $b[1]
  $k = $s.id
  switch ($s.kind) {
    'title' {
      RoundRect $g 88 236 132 40 8 ([System.Drawing.Color]::FromArgb(30, 70, 120, 255)) $accent
      Txt $g '用户画像层' 20 $accent 106 245 $true
      Txt $g 'agent-user-profile' 68 $fg 88 296 $true
      Txt $g '把散落在对话里的偏好，沉淀成每次任务都带着的画像' 26 $fg2 88 420
      Txt $g 'DSH 插件 · 核心也可纯 CLI 单独运行' 20 $fg2 88 478
    }
    'problem' {
      Txt $g '问题' 22 $accent 88 168 $true
      Txt $g '每次新会话，都要重新解释一遍' 50 $fg 88 210 $true
      $items = @('我喜欢什么样的界面、代码风格', '哪些事必须先跑通测试再说完成', '哪几件事是我的红线，别碰')
      $y = 330
      foreach ($it in $items) {
        $g.FillEllipse((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(60, 90, 140, 255))), 92, ($y + 12), 10, 10)
        Txt $g $it 27 $fg2 120 $y
        $y += 62
      }
      RoundRect $g 88 540 640 92 14 $card $line
      Txt $g '画像解决的就是这件事：说一次，之后一直算数。' 24 $fg 116 572
    }
    'shot' {
      Txt $g $s.kicker 20 $accent 88 150 $true
      Txt $g $s.head 46 $fg 88 186 $true
      Txt $g $s.note 22 $fg2 88 254
      $img = [System.Drawing.Image]::FromFile((Join-Path $shots $s.img))
      $maxW = 470; $maxH = 486
      $sc = [Math]::Min($maxW / $img.Width, $maxH / $img.Height)
      $dw = [int]($img.Width * $sc); $dh = [int]($img.Height * $sc)
      $dx = ($W - $dw - 96); $dy = 130
      RoundRect $g ($dx - 8) ($dy - 8) ($dw + 16) ($dh + 16) 14 $card $line
      $g.DrawImage($img, $dx, $dy, $dw, $dh)
      $img.Dispose()
    }
    'cli' {
      Txt $g '也能单独跑' 20 $accent 88 150 $true
      Txt $g '三行命令，任何宿主都能用' 44 $fg 88 184 $true
      RoundRect $g 88 280 1104 300 14 ([System.Drawing.Color]::FromArgb(20, 24, 31)) $line
      $lines = @(
        'node bin/profile.mjs init',
        'node bin/profile.mjs declare --dim taste --fact "界面要有层次和留白"',
        'node bin/profile.mjs build   &&   cat ~/.dsh/user-profile/inject.md'
      )
      $y = 312
      foreach ($l in $lines) {
        Txt $g '$' 20 $ok 112 $y $false $fMono
        Txt $g $l 22 $fg 140 $y $false $fMono
        $y += 62
      }
      Txt $g 'MCP 模式下，Claude / Cursor 等宿主也能读同一份画像' 20 $fg2 112 540
    }
    'feats' {
      Txt $g '还有这些' 20 $accent 88 150 $true
      Txt $g '不是记忆库，是画像层' 46 $fg 88 186 $true
      $cards = @(
        @('单轮喊停', '这一句先别用画像，下次自动恢复'),
        @('快照回滚', '每次删除前留底，删错了能整批还原'),
        @('写入前脱敏', '手机号 / 邮箱 / 证件号 / 密钥 一律打码'),
        @('MCP 接口', '10 个工具 + 2 个资源，外宿主可读写')
      )
      $x = 88; $y = 288
      for ($i = 0; $i -lt 4; $i++) {
        $cx = 88 + ($i % 2) * 552
        $cy = 288 + [Math]::Floor($i / 2) * 172
        RoundRect $g $cx $cy 528 150 14 $card $line
        Txt $g $cards[$i][0] 26 $fg ($cx + 28) ($cy + 26) $true
        Txt $g $cards[$i][1] 20 $fg2 ($cx + 28) ($cy + 76)
      }
    }
    'end' {
      Txt $g 'agent-user-profile' 54 $fg 88 210 $true
      Txt $g '给 AI 一份关于你的说明书' 30 $fg2 88 292
      RoundRect $g 88 386 860 84 12 $card $line
      Txt $g 'github.com/OWNER/agent-user-profile' 30 $accent 116 410 $false $fMono
      Txt $g 'MIT · 零依赖 · 无需构建步骤' 20 $fg2 88 512
    }
  }
  Save $bmp $g (Join-Path $OutDir "s$k.png")
}

# ---------- 合成 ----------
$segments = @()
foreach ($s in $scenes) {
  $k = $s.id
  $png = Join-Path $OutDir "s$k.png"
  $wav = Join-Path $OutDir "n$k.wav"
  $mp4 = Join-Path $OutDir "p$k.mp4"
  $d = [Math]::Round((Get-Item $wav).Length / 88200.0, 2) + 0.55
  & $Ffmpeg -y -loglevel error -loop 1 -framerate 30 -t $d -i $png -i $wav `
    -filter_complex "[0:v]scale=1280:720,fade=t=in:st=0:d=0.3,fade=t=out:st=$([Math]::Round($d - 0.3,2)):d=0.3,format=yuv420p[v];[1:a]adelay=200|200,apad[a]" `
    -map "[v]" -map "[a]" -c:v libx264 -preset medium -crf 20 -c:a aac -b:a 128k -ar 44100 -shortest -movflags +faststart $mp4
  if ($LASTEXITCODE -ne 0) { throw "ffmpeg 失败：场景 $k" }
  $segments += $mp4
}
$list = Join-Path $OutDir 'list.txt'
($segments | ForEach-Object { "file '$_'" }) | Set-Content -Path $list -Encoding utf8
$final = Join-Path $root 'docs\video\intro-60s.mp4'
New-Item -ItemType Directory -Path (Split-Path -Parent $final) -Force | Out-Null
& $Ffmpeg -y -loglevel error -f concat -safe 0 -i $list -c copy -movflags +faststart $final
if ($LASTEXITCODE -ne 0) { throw '拼接失败' }

$info = (Get-Item $final)
"输出: $($info.FullName)"
"大小: $([Math]::Round($info.Length / 1KB, 1)) KB"
"工作目录: $OutDir"
