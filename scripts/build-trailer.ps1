# build-trailer.ps1 — 面向普通用户的宣传片（1920x1080，中文旁白 + 大字幕）
# 观众设定：完全不懂技术。所以片子里没有命令行、没有代码、没有测试数字、没有"我们改了什么"。
# 配音：edge-tts 神经网络音色（自然）；不可用时退回系统语音。
#
# 设计网格：以 1280x720 为设计稿，U = 1920/1280 = 1.5 等比放大到 1080p。
# 安全区：内容 y 60..590，底部 y 600..720 保留给字幕条。

param(
  [string]$OutFile = 'docs/video/agent-user-profile.mp4',
  [string]$Engine  = 'chattts',
  [string]$Voice   = '',
  [string]$Speed   = '0.92',
  [string]$Seed    = '3',
  [string]$Tempo   = '1.0',
  [switch]$NoTtsRefresh
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Speech

# ffmpeg / ffprobe：优先环境变量，其次 PATH（不写死本机路径）
function Resolve-Tool {
  param([string]$EnvName, [string]$Name)
  if ([Environment]::GetEnvironmentVariable($EnvName)) { return [Environment]::GetEnvironmentVariable($EnvName) }
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $Name
}
$Ffmpeg  = Resolve-Tool 'FFMPEG' 'ffmpeg'
$Ffprobe = Resolve-Tool 'FFPROBE' 'ffprobe'
if ($env:FFMPEG -and -not $env:FFPROBE) {
  $sibling = Join-Path (Split-Path $env:FFMPEG -Parent) 'ffprobe.exe'
  if (Test-Path $sibling) { $Ffprobe = $sibling }
}
$Root    = Split-Path -Parent $PSScriptRoot
$Work    = Join-Path $PSScriptRoot 'trailer-build'
New-Item -ItemType Directory -Force -Path $Work | Out-Null

$W = 1920; $H = 1080
$U = 1.5          # 设计稿 1280x720 → 1920x1080

$C = @{
  bg     = [Drawing.ColorTranslator]::FromHtml('#0B0E13')
  bg2    = [Drawing.ColorTranslator]::FromHtml('#121821')
  card   = [Drawing.ColorTranslator]::FromHtml('#181F29')
  card2  = [Drawing.ColorTranslator]::FromHtml('#1E2733')
  line   = [Drawing.ColorTranslator]::FromHtml('#2C3644')
  text   = [Drawing.ColorTranslator]::FromHtml('#EDF1F7')
  dim    = [Drawing.ColorTranslator]::FromHtml('#9AA7B6')
  faint  = [Drawing.ColorTranslator]::FromHtml('#6C7A8A')
  accent = [Drawing.ColorTranslator]::FromHtml('#73A9FF')
  ok     = [Drawing.ColorTranslator]::FromHtml('#5FCB92')
  warn   = [Drawing.ColorTranslator]::FromHtml('#E8B75D')
  coral  = [Drawing.ColorTranslator]::FromHtml('#E8837A')
}

function Px([double]$v) { return [single]($v * $U) }

function New-Font([single]$size, [bool]$bold = $false) {
  $style = if ($bold) { [Drawing.FontStyle]::Bold } else { [Drawing.FontStyle]::Regular }
  return [Drawing.Font]::new('Microsoft YaHei', $size, $style, [Drawing.GraphicsUnit]::Pixel)
}

function Txt($g, [string]$s, [double]$x, [double]$y, [double]$size, $color, [bool]$bold = $false, [double]$boxW = 1100) {
  $f = New-Font (Px $size) $bold
  $b = [Drawing.SolidBrush]::new($color)
  $rect = [Drawing.RectangleF]::new((Px $x), (Px $y), (Px $boxW), (Px ($size * 4)))
  $g.DrawString($s, $f, $b, $rect)
  $b.Dispose(); $f.Dispose()
}

function TxtCenter($g, [string]$s, [double]$y, [double]$size, $color, [bool]$bold = $false) {
  $f = New-Font (Px $size) $bold
  $b = [Drawing.SolidBrush]::new($color)
  $fmt = [Drawing.StringFormat]::new()
  $fmt.Alignment = [Drawing.StringAlignment]::Center
  $rect = [Drawing.RectangleF]::new(0, (Px $y), $W, (Px ($size * 3)))
  $g.DrawString($s, $f, $b, $rect, $fmt)
  $b.Dispose(); $f.Dispose(); $fmt.Dispose()
}

function RoundRect($g, [double]$x, [double]$y, [double]$w, [double]$h, [double]$r, $fill, $stroke = $null, [double]$sw = 2) {
  $rx = Px $x; $ry = Px $y; $rw = Px $w; $rh = Px $h; $rr = Px $r
  $path = New-Object Drawing.Drawing2D.GraphicsPath
  $d = $rr * 2
  $path.AddArc($rx, $ry, $d, $d, 180, 90)
  $path.AddArc(($rx + $rw - $d), $ry, $d, $d, 270, 90)
  $path.AddArc(($rx + $rw - $d), ($ry + $rh - $d), $d, $d, 0, 90)
  $path.AddArc($rx, ($ry + $rh - $d), $d, $d, 90, 90)
  $path.CloseFigure()
  if ($fill) { $b = [Drawing.SolidBrush]::new($fill); $g.FillPath($b, $path); $b.Dispose() }
  if ($stroke) { $p = [Drawing.Pen]::new($stroke, (Px $sw)); $g.DrawPath($p, $path); $p.Dispose() }
  $path.Dispose()
}

function Dots($g, [double]$x, [double]$y, [int]$filled, [int]$total, $onColor, $offColor) {
  $r = Px 7; $gap = Px 20
  for ($i = 0; $i -lt $total; $i++) {
    $col = if ($i -lt $filled) { $onColor } else { $offColor }
    $b = [Drawing.SolidBrush]::new($col)
    $g.FillEllipse($b, ((Px $x) + $i * $gap), (Px $y), $r, $r)
    $b.Dispose()
  }
}

function New-Slide([scriptblock]$draw) {
  $bmp = [Drawing.Bitmap]::new($W, $H)
  $g = [Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $rect = [Drawing.Rectangle]::new(0, 0, $W, $H)
  $grad = [Drawing.Drawing2D.LinearGradientBrush]::new($rect, $C.bg, $C.bg2, 90)
  $g.FillRectangle($grad, $rect)
  $grad.Dispose()
  & $draw $g
  return @($bmp, $g)
}

function Draw-Subtitle($g, [string]$s) {
  $bandTop = Px 600
  $band = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(170, 6, 8, 12))
  $g.FillRectangle($band, 0, $bandTop, $W, ($H - $bandTop))
  $band.Dispose()
  $f = New-Font (Px 33) $false
  $b = [Drawing.SolidBrush]::new($C.text)
  $fmt = [Drawing.StringFormat]::new()
  $fmt.Alignment = [Drawing.StringAlignment]::Center
  $fmt.LineAlignment = [Drawing.StringAlignment]::Center
  $rect = [Drawing.RectangleF]::new((Px 90), $bandTop, ($W - (Px 180)), ($H - $bandTop))
  $g.DrawString($s, $f, $b, $rect, $fmt)
  $b.Dispose(); $f.Dispose(); $fmt.Dispose()
}

# ---------------------------------------------------------------- 分镜
$Scenes = @(
  @{
    Name = '00-cover'
    Narration = ''
    Subtitle  = ''
    Silent    = $true
    Hold      = 3.0
    HideBand  = $true
    Draw = {
      param($g)
      RoundRect $g 506 330 268 56 28 ([Drawing.Color]::FromArgb(40, $C.accent))
      TxtCenter $g 'DSH 新插件' 345 30 $C.accent $true
      TxtCenter $g '人物画像' 414 120 $C.text $true
      RoundRect $g 592 600 96 5 2 $C.accent
      TxtCenter $g '让 AI 更懂你是谁' 630 46 $C.dim
    }
  },
  @{
    Name = '01-hook'
    Narration = '它读过整个互联网，却记不住你昨天说的一句话。换个对话，你又变回陌生人。'
    Subtitle  = '不是它笨，是它不认识你'
    Draw = {
      param($g)
      TxtCenter $g '它读过整个互联网' 158 70 $C.text $true
      TxtCenter $g '却记不住你昨天说的话' 258 70 $C.accent $true
      TxtCenter $g '换个对话，你又成了陌生人' 402 36 $C.dim
    }
  },
  @{
    Name = '02-pain'
    Narration = '你说过，你喜欢简单一点。第二天，它又开始绕圈子。你说那个文件夹别动，它还是动了。每换一个新对话，你就得从头再讲一遍。'
    Subtitle  = '每换一个对话，就得重新交代一遍，很累'
    Draw = {
      param($g)
      Txt $g '每开一个新对话，你都得从头再说一遍' 80 88 46 $C.text $true 1100
      $rows = @(
        @('我是谁', '做什么的、习惯用什么工具'),
        @('我喜欢什么', '简洁还是详细、正式还是轻松'),
        @('别碰什么', '哪些文件不能动、哪些话不要说')
      )
      $y = 196
      foreach ($row in $rows) {
        RoundRect $g 80 $y 1120 110 18 $C.card $C.line 2
        $dot = [Drawing.SolidBrush]::new($C.warn)
        $g.FillEllipse($dot, (Px 118), (Px ($y + 46)), (Px 18), (Px 18))
        $dot.Dispose()
        Txt $g $row[0] 156 ($y + 24) 34 $C.text $true 300
        Txt $g $row[1] 470 ($y + 30) 28 $C.dim $false 700
        $y += 132
      }
    }
  },
  @{
    Name = '03-what'
    Narration = '现在，有一份关于你的说明书。说一次，写清楚。以后每次开口之前，它都会先看一眼。'
    Subtitle  = '一次说清，往后每次开口之前它都会先看一眼'
    Draw = {
      param($g)
      TxtCenter $g '给 AI 一份「关于你」的说明书' 96 60 $C.text $true
      TxtCenter $g '你说一次，它以后都记得' 176 36 $C.accent
      RoundRect $g 300 240 680 320 24 $C.card $C.line 2
      RoundRect $g 332 268 616 54 14 $C.card2
      Txt $g '关于你 · 私人资料' 356 280 28 $C.dim
      $lines = @('喜欢简洁、直接的答复', '习惯用中文，说话不绕弯', '重要的事必须给证据', '别动桌面上的「项目」文件夹')
      $ly = 350
      foreach ($line in $lines) {
        $b = [Drawing.SolidBrush]::new($C.accent)
        $g.FillRectangle($b, (Px 356), (Px ($ly + 12)), (Px 8), (Px 8))
        $b.Dispose()
        Txt $g $line 380 $ly 30 $C.text $false 560
        $ly += 50
      }
    }
  },
  @{
    Name = '04-categories'
    Narration = '里面写的是：你是谁，你喜欢什么，你习惯怎么做，还有你绝对不想要什么。一共十类。每一条，你都能看，能改，也能删。'
    Subtitle  = '分成十类，每条都能看、能改、能删'
    Draw = {
      param($g)
      Txt $g '它到底记得什么' 80 76 52 $C.text $true 900
      $cells = @(
        @('身份', '你是谁', '本科在读 · 中文交流', $C.accent),
        @('喜好', '你喜欢什么', '喜欢简洁 · 冷色调', $C.ok),
        @('习惯', '你习惯怎么做', '先给结论 · 要证据', $C.warn),
        @('底线', '你绝对不要什么', '别动项目文件夹', $C.coral)
      )
      $cw = 540; $ch = 176; $gapX = 40; $x0 = 80; $y0 = 164
      $idx = 0
      foreach ($cell in $cells) {
        $cx = $x0 + ($idx % 2) * ($cw + $gapX)
        $cy = $y0 + [Math]::Floor($idx / 2) * ($ch + 26)
        RoundRect $g $cx $cy $cw $ch 22 $C.card $C.line 2
        $chip = [Drawing.Color]::FromArgb(46, $cell[3])
        RoundRect $g ($cx + 32) ($cy + 24) 104 40 12 $chip
        Txt $g $cell[0] ($cx + 56) ($cy + 32) 26 $cell[3] $true 120
        Txt $g $cell[1] ($cx + 32) ($cy + 82) 34 $C.text $true 460
        Txt $g $cell[2] ($cx + 32) ($cy + 132) 23 $C.dim $false 460
        $idx++
      }
      Dots $g 700 424 0 0 $C.faint $C.faint
    }
  },
  @{
    Name = '04b-vs'
    Narration = '那它和别的记忆插件差在哪。别的大多只存聊天记录，用的时候再翻。它把记忆整理成一张清单，每次开口前自动读一遍；记的不只是你说的话，还有你是什么样的人。'
    Subtitle  = '别人存聊天记录，它留下一张关于你的清单'
    Draw = {
      param($g)
      Txt $g '和别的记忆插件，差在哪' 80 66 50 $C.text $true 900
      Txt $g '别人存的是记录，它留下的是你' 82 136 28 $C.dim $false 900
      Txt $g '别的记忆插件' 84 196 25 $C.faint $true 380
      Txt $g '这个' 648 196 25 $C.accent $true 200
      $rows = @(
        @('存聊天记录，用的时候翻出来', '整理成一张清单，开口前先读'),
        @('记你说过什么', '还记你是什么样的人'),
        @('删了就没了', '能改能删，删错能还原')
      )
      $y = 232
      foreach ($r in $rows) {
        RoundRect $g 80 $y 500 96 16 $C.card2
        Txt $g $r[0] 108 ($y + 30) 25 $C.faint $false 450
        RoundRect $g 620 $y 580 96 16 $C.card $C.line 2
        $bar = [Drawing.SolidBrush]::new($C.accent)
        $g.FillRectangle($bar, (Px 622), (Px ($y + 20)), (Px 4), (Px 56))
        $bar.Dispose()
        Txt $g $r[1] 650 ($y + 30) 25 $C.text $false 520
        $y += 112
      }
    }
  },
  @{
    Name = '05-control'
    Narration = '哪条不合适，点一下，就能调轻重。说错了，删掉。删错了，随时还原。它还会告诉你，这次为什么这么做。'
    Subtitle  = '不合适的那条调轻或删掉，删错了一键还原'
    Draw = {
      param($g)
      Txt $g '你说了算' 80 62 52 $C.text $true 700
      Txt $g '每条都能调轻重 · 能删 · 删错能还原' 336 80 27 $C.dim $false 760
      RoundRect $g 80 140 1120 396 22 $C.card $C.line 2
      Txt $g '我的资料' 112 164 30 $C.text $true 300
      RoundRect $g 1000 160 168 44 22 $C.card2 $C.line 1
      Txt $g '已开启' 1032 172 24 $C.ok
      $rows = @(
        @('喜好', '喜欢简洁、直接的答复', 3),
        @('习惯', '重要的事必须给证据', 3),
        @('底线', '别动「项目」文件夹', 4),
        @('身份', '中文交流，不绕弯', 2)
      )
      $ry = 224
      foreach ($row in $rows) {
        RoundRect $g 104 $ry 1072 68 14 $C.card2
        $chip3 = [Drawing.Color]::FromArgb(46, $C.accent)
        RoundRect $g 120 ($ry + 16) 82 36 10 $chip3
        Txt $g $row[0] 140 ($ry + 22) 22 $C.accent $true 90
        Txt $g $row[1] 236 ($ry + 18) 28 $C.text $false 460
        Dots $g 720 ($ry + 30) $row[2] 4 $C.accent $C.line
        Txt $g '轻重' 830 ($ry + 22) 20 $C.faint
        Txt $g '删除' 960 ($ry + 22) 20 $C.faint
        $ry += 78
      }
      Txt $g '删除前自动留一份，随时还原' 112 552 22 $C.ok
    }
  },
  @{
    Name = '05b-tidy'
    Narration = '记得多了，它自己也会整理。同一件事记了两遍，合成一条。哪天你换个 AI 用，也能把这些整段搬过去。'
    Subtitle  = '重复的自动合并 · 换工具也能带走'
    Draw = {
      param($g)
      Txt $g '它会自己整理' 80 62 52 $C.text $true 420
      Txt $g '记得越多，越要会整理' 440 84 27 $C.dim $false 780

      RoundRect $g 80 150 540 320 22 $C.card $C.line 2
      Txt $g '同一件事记了两遍' 108 168 26 $C.dim $false 440
      RoundRect $g 108 212 484 60 12 $C.card2
      Txt $g '喜欢简洁的回答' 128 226 26 $C.text $false 440
      RoundRect $g 108 284 484 60 12 $C.card2
      Txt $g '不喜欢啰嗦的说法' 128 298 26 $C.text $false 440
      Txt $g '↓ 自动合并' 120 352 22 $C.ok $true 260
      RoundRect $g 108 392 484 60 12 $C.card2 $C.ok 2
      Txt $g '喜欢简洁，不要啰嗦' 128 406 26 $C.ok $true 440

      RoundRect $g 660 150 540 320 22 $C.card $C.line 2
      Txt $g '换个 AI 也能带走' 688 168 26 $C.dim $false 440
      Txt $g '问它一句：你记得我什么' 688 214 25 $C.text $false 480
      Txt $g '把回答整段贴进来' 688 254 25 $C.text $false 480
      Txt $g '逐条拆开 · 自动归类 · 自动定轻重' 688 294 22 $C.faint $false 490
      $chipTidy = [Drawing.Color]::FromArgb(46, $C.ok)
      RoundRect $g 688 348 320 56 14 $chipTidy
      Txt $g '已经搬过来 12 条' 712 362 24 $C.ok $true 300

      TxtCenter $g '哪一条不该记，划掉就行；删错了还能还原' 500 26 $C.dim
    }
  },
  @{
    Name = '06-payoff'
    Narration = '所以新对话的第一句话，它已经知道你要什么了。哪天你不想让它参考，就说一句：这次别用我的资料。它就停。'
    Subtitle  = '同一句话，它直接给到你要的样子'
    Draw = {
      param($g)
      RoundRect $g 70 120 540 300 22 $C.card $C.line 2
      Txt $g '以前' 104 148 26 $C.faint $true 200
      Txt $g '“帮我写个总结”' 104 196 28 $C.text $false 460
      Txt $g '要多长？正式吗？给谁看？' 104 246 24 $C.dim $false 460
      Txt $g '来回问五轮才开工' 104 340 26 $C.warn $true 460

      RoundRect $g 670 120 540 300 22 $C.card $C.accent 2
      Txt $g '现在' 704 148 26 $C.ok $true 200
      Txt $g '“帮我写个总结”' 704 196 28 $C.text $false 460
      Txt $g '一页、要点式、给同事看' 704 246 24 $C.dim $false 460
      Txt $g '它已经知道你要什么' 704 340 26 $C.ok $true 460

      TxtCenter $g '不想让它参考？说一句「这次别用我的资料」' 480 28 $C.accent
    }
  },
  @{
    Name = '07-outro'
    Narration = '开源，免费。数据只留在你自己的电脑里。想试试，搜索 agent user profile。'
    Subtitle  = '开源免费 · 数据只留在你自己的电脑里'
    Draw = {
      param($g)
      TxtCenter $g 'agent-user-profile' 150 72 $C.text $true
      TxtCenter $g '让 AI 真正认识你' 250 44 $C.accent
      $pills = @('开源免费', '数据在本机', '随时可关闭')
      $startX = 300; $pw2 = 210; $pgap = 30
      $x = $startX
      foreach ($pill in $pills) {
        RoundRect $g $x 340 $pw2 62 31 $C.card2 $C.line 2
        Txt $g $pill ($x + 42) 356 26 $C.text
        $x += $pw2 + $pgap
      }
      TxtCenter $g 'github 搜  agent-user-profile' 452 30 $C.dim
    }
  }
)

# ---------------------------------------------------------------- 配音
$Py = Get-Command python -ErrorAction SilentlyContinue
# ChatTTS 可能装在单独的解释器里，用 CHATTTS_PY 指过去（默认跟系统 python 同一个）
$ChatPy = if ($env:CHATTTS_PY) { $env:CHATTTS_PY } else { if ($Py) { $Py.Source } else { 'python' } }
function Test-Tts {
  param([string]$Which)
  switch ($Which) {
    'chattts' {
      if (-not (Test-Path $ChatPy)) { return $false }
      & $ChatPy -c "import ChatTTS, vocos" 2>$null | Out-Null
      return ($LASTEXITCODE -eq 0)
    }
    default {
      if (-not $Py) { return $false }
      $mod = if ($Which -eq 'kokoro') { 'kokoro' } else { 'edge_tts' }
      & $Py -c "import $mod" 2>$null | Out-Null
      return ($LASTEXITCODE -eq 0)
    }
  }
}
$useChat   = ($Engine -eq 'chattts') -and (Test-Tts 'chattts') -and (-not $NoTtsRefresh)
$useKokoro = (-not $useChat) -and ($Engine -eq 'kokoro') -and (Test-Tts 'kokoro') -and (-not $NoTtsRefresh)
$useEdge   = (-not $useChat) -and (-not $useKokoro) -and ($Engine -eq 'edge') -and (Test-Tts 'edge') -and (-not $NoTtsRefresh)

# 复用仓库里的 scripts/tts.py，不在构建目录里另写一份
$ttsPy = Join-Path $Root 'scripts/tts.py'
if (($useChat -or $useKokoro -or $useEdge) -and -not (Test-Path $ttsPy)) { throw "缺少 $ttsPy" }

$engineLine = if ($useChat) { "ChatTTS 对话式模型 (seed $Seed)" }
  elseif ($useKokoro) { "kokoro 本地模型 ($Voice, speed $Speed)" }
  elseif ($useEdge) { "edge-tts ($Voice, speed $Speed)" }
  else { "系统语音 Huihui" }
Write-Host ("配音引擎：" + $engineLine)

# ---------------------------------------------------------------- 逐场渲染
$segments = @(); $srts = @(); $timeline = @()
$t = 0.0; $idx = 0; $cue = 0

foreach ($scene in $Scenes) {
  $idx++
  $png = Join-Path $Work ("{0}.png" -f $scene.Name)
  $mp4 = Join-Path $Work ("{0}.mp4" -f $scene.Name)
  $txt = Join-Path $Work ("{0}.txt" -f $scene.Name)

  # 每次都重画：留着旧图会让抽帧检查通过、成片却还是上一版文案
  $pair = New-Slide { param($g) & $scene.Draw $g; if (-not $scene.HideBand) { Draw-Subtitle $g $scene.Subtitle } }
  $bmp = $pair[0]; $gfx = $pair[1]
  $gfx.Dispose(); $bmp.Save($png, [Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()

  # 封面场：没有旁白，用等长静音占位，保证所有分段的音轨结构一致
  $silent = [bool]($scene.Silent)
  if ($silent) {
    $hold = [double]$scene.Hold
    $wav = Join-Path $Work ("{0}.silent.wav" -f $scene.Name)
    if (-not (Test-Path $wav)) {
      & $Ffmpeg -y -loglevel error -f lavfi -i 'anullsrc=r=24000:cl=mono' -t $hold -c:a pcm_s16le $wav
    }
  }

  # 配音按「文案+引擎+音色+速度」指纹缓存：改了文案就必然重配，没改就复用
  $sig = '{0}|{1}|{2}|{3}|{4}' -f $scene.Narration, $Engine, $Voice, $Seed, $Tempo
  $sigBytes = [Text.Encoding]::UTF8.GetBytes($sig)
  $sigHash = [Security.Cryptography.SHA256]::Create().ComputeHash($sigBytes)
  $sigKey = (($sigHash[0..5] | ForEach-Object { $_.ToString('x2') }) -join '')
  $wav = Join-Path $Work ("{0}.{1}.wav" -f $scene.Name, $sigKey)
  $mp3 = Join-Path $Work ("{0}.{1}.mp3" -f $scene.Name, $sigKey)

  if (-not $silent -and ($useChat -or $useKokoro -or $useEdge)) {
    if (-not (Test-Path $wav)) {
      Set-Content $txt $scene.Narration -Encoding UTF8
      if ($useChat) {
        & $ChatPy $ttsPy $txt $wav chattts $Voice $Seed
      } elseif ($useKokoro) {
        & $Py $ttsPy $txt $wav kokoro $Voice $Speed
      } else {
        & $Py $ttsPy $txt $mp3 edge $Voice $Speed
      }
      if ($LASTEXITCODE -ne 0) { throw "配音失败：$($scene.Name)" }
      # ChatTTS 读得偏快，用 atempo 放慢而不改音高（0.9 ≈ 慢 10%）
      $tempoArgs = @()
      if ([double]$Tempo -ne 1.0) { $tempoArgs = @('-filter:a', "atempo=$Tempo") }
      if (Test-Path $mp3) {
        # 本地模型不可用时 tts.py 会退回 edge 并留下 mp3
        & $Ffmpeg -y -loglevel error -i $mp3 @tempoArgs -ar 44100 -ac 1 $wav
      } else {
        $tmp44 = Join-Path $Work ("{0}.44k.wav" -f $scene.Name)
        & $Ffmpeg -y -loglevel error -i $wav @tempoArgs -ar 44100 -ac 1 $tmp44
        Move-Item -Force $tmp44 $wav
      }
      if (-not (Test-Path $wav)) { throw "配音文件未生成：$($scene.Name)" }
    }
  } elseif (-not (Test-Path $wav)) {
    $sp = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $sp.SelectVoice('Microsoft Huihui Desktop')
    $sp.Rate = -2
    $sp.SetOutputToWaveFile($wav)
    $sp.Speak($scene.Narration)
    $sp.Dispose()
  }

  if ($silent) {
    $hold = [double]$scene.Hold
  } else {
    $dur = [double](& $Ffprobe -v error -show_entries format=duration -of csv=p=0 $wav)
    $hold = [Math]::Round($dur + 0.55, 2)
  }
  $fadeOut = [Math]::Max(0, $hold - 0.4)

  # 分段每次都重建：图片或配音变了而分段还留着，成片就会是上一版的画面
  & $Ffmpeg -y -loglevel error -loop 1 -i $png -i $wav `
    -vf ("scale={0}:{1},fade=t=in:st=0:d=0.3,fade=t=out:st={2}:d=0.4" -f $W, $H, $fadeOut) `
    -af 'apad=pad_dur=0.55' -t $hold `
    -c:v libx264 -preset slow -crf 17 -pix_fmt yuv420p -r 30 `
    -c:a aac -b:a 192k -ar 44100 -ac 1 $mp4

  $segments += $mp4
  $timeline += [pscustomobject]@{ Scene = $scene.Name; Start = $t; End = ($t + $hold) }
  # 封面没有字幕，别让它占一个空字幕条目
  if ($scene.Subtitle) {
    $cue++
    $srts += ("{0}`r`n{1} --> {2}`r`n{3}`r`n" -f $cue,
      ([TimeSpan]::FromSeconds($t)).ToString('hh\:mm\:ss\,fff'),
      ([TimeSpan]::FromSeconds($t + $hold - 0.1)).ToString('hh\:mm\:ss\,fff'),
      $scene.Subtitle)
  }
  $t += $hold
  Write-Host ("[scene {0}] {1}  {2:N2}s" -f $idx, $scene.Name, $hold)
}

# ---------------------------------------------------------------- 背景音乐
$total = [Math]::Round($t + 1.2, 2)
$bed = Join-Path $Work 'bed.wav'
$fadeOutAt = [Math]::Max(0, $total - 4)
$bedFilter = ('[0:a][1:a][2:a][3:a]amix=inputs=4:duration=longest,volume=0.042,lowpass=f=600,afade=t=in:st=0:d=2.5,afade=t=out:st={0}:d=4' -f $fadeOutAt)
& $Ffmpeg -y -loglevel error `
  -f lavfi -i ("sine=frequency=98:duration={0}" -f $total) `
  -f lavfi -i ("sine=frequency=146.83:duration={0}" -f $total) `
  -f lavfi -i ("sine=frequency=196:duration={0}" -f $total) `
  -f lavfi -i ("sine=frequency=293.66:duration={0}" -f $total) `
  -filter_complex $bedFilter -ar 44100 -ac 1 $bed

# ---------------------------------------------------------------- 拼接与混音
Push-Location $Work
try {
  ($segments | ForEach-Object { "file '$(Split-Path -Leaf $_)'" }) -join "`n" | Set-Content 'list.txt' -Encoding utf8
  & $Ffmpeg -y -loglevel error -f concat -safe 0 -i 'list.txt' -c copy 'concat.mp4'
  if ($LASTEXITCODE -ne 0) { throw 'concat 失败' }
} finally { Pop-Location }

$outPath = Join-Path $Root $OutFile
New-Item -ItemType Directory -Force -Path (Split-Path $outPath) | Out-Null
& $Ffmpeg -y -loglevel error -i (Join-Path $Work 'concat.mp4') -i $bed `
  -filter_complex '[0:a]volume=1.0[a0];[1:a]volume=0.5[a1];[a0][a1]amix=inputs=2:duration=first:normalize=0[aout]' `
  -map 0:v -map '[aout]' -c:v copy -c:a aac -b:a 192k -movflags +faststart $outPath

$srtPath = Join-Path $Root 'docs/video/agent-user-profile.srt'
Set-Content $srtPath ($srts -join "`r`n") -Encoding UTF8
$narPath = Join-Path $Root 'docs/video/agent-user-profile-narration.txt'
(($Scenes | Where-Object { $_.Narration } | ForEach-Object { '[' + $_.Name + '] ' + $_.Narration }) -join "`r`n") | Set-Content $narPath -Encoding UTF8

Write-Host ''
Write-Host ("总时长：{0:N2} 秒" -f $t)
$timeline | Format-Table -AutoSize | Out-String | Write-Host
Write-Host ("成片：{0}" -f $outPath)


