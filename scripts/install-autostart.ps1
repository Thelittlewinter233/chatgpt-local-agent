param([switch]$Remove)
$startup = [Environment]::GetFolderPath('Startup')
$link = Join-Path $startup 'ChatGPTLocalAgent.vbs'
$bat = Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\server-loop.bat'
if ($Remove) {
  if (Test-Path $link) {
    Remove-Item $link -Force
    Write-Output "removed $link"
  } else {
    Write-Output "autostart not installed"
  }
  exit 0
}
if (-not (Test-Path $bat)) { throw "missing $bat" }
$batEsc = $bat.Replace("'", "''")
$vbs = "CreateObject(""WScript.Shell"").Run """"""$batEsc"""""", 0, False"
Set-Content -Path $link -Value $vbs -Encoding ASCII
Write-Output "installed $link"
Write-Output "runs hidden with auto-restart: $bat"
