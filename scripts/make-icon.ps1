# 生成市场卡片图标 assets/icon-180.png（180x180，圆角方形，品牌色底 + 白色「画像」）
# 用法：pwsh -NoProfile -File scripts/make-icon.ps1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$outDir = Join-Path $Root 'assets'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$out = Join-Path $outDir 'icon-180.png'

$size = 180
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear([System.Drawing.Color]::Transparent)

# 品牌色底（与插件面板主色一致），圆角 40
$brand = [System.Drawing.Color]::FromArgb(255, 77, 107, 254)
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$r = 40; $d = $r * 2
$path.AddArc(0, 0, $d, $d, 180, 90)
$path.AddArc($size - $d, 0, $d, $d, 270, 90)
$path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
$path.AddArc(0, $size - $d, $d, $d, 90, 90)
$path.CloseFigure()
$brush = New-Object System.Drawing.SolidBrush($brand)
$g.FillPath($brush, $path)

# 底部一层浅色弧：给卡片一点层次，避免纯色块
$arc = New-Object System.Drawing.Drawing2D.GraphicsPath
$arc.AddEllipse(-60, 96, 300, 200)
$soft = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(38, 255, 255, 255))
$g.FillPath($soft, $arc)

# 白色「画像」两字，居中
$font = New-Object System.Drawing.Font('Microsoft YaHei', 56, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = [System.Drawing.StringAlignment]::Center
$fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
$rect = New-Object System.Drawing.RectangleF(0, 0, $size, $size)
$g.DrawString('画像', $font, $white, $rect, $fmt)

$g.Dispose()
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "icon: $out"
