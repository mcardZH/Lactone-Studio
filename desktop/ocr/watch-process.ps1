param([int]$OwnedProcessId, [int]$ThreadGrant)
$ErrorActionPreference = 'Stop'
try {
  $ocrProcess = Get-Process -Id $OwnedProcessId -ErrorAction Stop
  $ocrStartTicks = $ocrProcess.StartTime.Ticks
  $ocrAffinity = [long]$ocrProcess.ProcessorAffinity
  $ocrMask = [long]0
  $ocrCount = 0
  for ($ocrIndex = 0; $ocrIndex -lt 63 -and $ocrCount -lt $ThreadGrant; $ocrIndex++) {
    $ocrBit = [long]1 -shl $ocrIndex
    if (($ocrAffinity -band $ocrBit) -ne 0) { $ocrMask = $ocrMask -bor $ocrBit; $ocrCount++ }
  }
  if ($ocrMask -eq 0) { throw 'No CPU affinity available' }
  $ocrProcess.ProcessorAffinity = [IntPtr]$ocrMask
  if ([long]$ocrProcess.ProcessorAffinity -ne $ocrMask) { throw 'CPU affinity readback differs from grant' }
  while ($true) {
    try { $ocrProcess.Refresh(); if ($ocrProcess.HasExited -or $ocrProcess.StartTime.Ticks -ne $ocrStartTicks) { break } } catch { break }
    @{ workingSetBytes = [long]$ocrProcess.WorkingSet64; peakWorkingSetBytes = [long]$ocrProcess.PeakWorkingSet64; affinityCpuCount = $ocrCount } | ConvertTo-Json -Compress
    Start-Sleep -Milliseconds 200
  }
} catch [Microsoft.PowerShell.Commands.ProcessCommandException] {
  # A short-lived owned child may have exited before the monitor starts.
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
