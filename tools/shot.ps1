param(
  [string]$Query = '',
  [string]$Out = 'shot.png',
  [int]$Wait = 6000,
  [string]$Size = '1440,900',
  [string]$Dir = (Join-Path $PSScriptRoot '..\.shots')
)
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$dir = $Dir
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$path = Join-Path (Resolve-Path $dir) $Out
& $chrome --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 "--window-size=$Size" "--virtual-time-budget=$Wait" "--screenshot=$path" "http://localhost:5180/$Query" 2>$null | Out-Null
Write-Output $path
