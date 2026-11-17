Add-Type -AssemblyName System.Drawing
foreach ($f in (Get-ChildItem "scripts/trailer-build/*.png" | Sort-Object Name)) {
  $bmp = [Drawing.Bitmap]::FromFile($f.FullName); $W=$bmp.Width; $H=$bmp.Height
  $minX=$W; $maxX=-1; $minY=$H; $maxY=-1
  for ($y=4; $y -lt $H; $y+=5) { for ($x=0; $x -lt $W; $x+=5) {
    $p=$bmp.GetPixel($x,$y); if ($p.R -gt 60 -or $p.G -gt 60 -or $p.B -gt 70) {
      if($x -lt $minX){$minX=$x}; if($x -gt $maxX){$maxX=$x}; if($y -lt $minY){$minY=$y}; if($y -gt $maxY){$maxY=$y} } } }
  "{0,-24} {1}x{2} bbox=({3},{4})-({5},{6}) 右裁={7} 底裁={8}" -f $f.Name,$W,$H,$minX,$minY,$maxX,$maxY,($maxX -ge $W-8),($maxY -ge $H-4)
  $bmp.Dispose()
}
