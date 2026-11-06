'use strict';
const { execFile } = require('node:child_process');

// Only this fixed program is evaluated. Requests travel over stdin as JSON;
// executable/file names never become PowerShell source or shell commands.
const REGISTRY_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$request=[Console]::In.ReadToEnd() | ConvertFrom-Json
function Relative($key) {
  if (-not $key.StartsWith('HKCU\Software\',[StringComparison]::OrdinalIgnoreCase) -or $key.Contains('UserChoice')) { throw 'Invalid association registry root' }
  return $key.Substring(5)
}
function ReadValue($target) {
  $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey((Relative $target.key),$false)
  if ($null -eq $key) { return $null }
  try {
    if (-not (@($key.GetValueNames()) -contains [string]$target.name)) { return $null }
    $kind=$key.GetValueKind([string]$target.name).ToString()
    $data=$key.GetValue([string]$target.name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if ($kind -eq 'Binary' -or $kind -eq 'None') { $data=[Convert]::ToBase64String([byte[]]$data) }
    if ($kind -eq 'QWord') { $data=$data.ToString([Globalization.CultureInfo]::InvariantCulture) }
    return @{type=$kind;data=$data}
  } finally { $key.Dispose() }
}
function WriteValue($target,$value) {
  if ($null -eq $value) {
    $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey((Relative $target.key),$true)
    if ($null -ne $key) { try { $key.DeleteValue([string]$target.name,$false) } finally { $key.Dispose() } }
  } else {
    if ($value.type -ne 'String') { throw 'Association writes require REG_SZ' }
    $key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey((Relative $target.key))
    try { $key.SetValue([string]$target.name,[string]$value.data,[Microsoft.Win32.RegistryValueKind]::String) } finally { $key.Dispose() }
  }
}
function Same($a,$b) {
  if ($null -eq $a -or $null -eq $b) { return ($null -eq $a -and $null -eq $b) }
  return ($a.type -ceq $b.type -and (($a.data | ConvertTo-Json -Compress -Depth 30) -ceq ($b.data | ConvertTo-Json -Compress -Depth 30)))
}
function SaveState($state) { WriteValue $request.journal @{type='String';data=($state | ConvertTo-Json -Compress -Depth 35)} }
if ($request.action -eq 'read') {
  $values=@{}; foreach ($target in $request.targets) { $values[$target.id]=ReadValue $target }
  @{values=$values;journal=(ReadValue $request.journal)} | ConvertTo-Json -Compress -Depth 35
} elseif ($request.action -eq 'apply') {
  # This is a write-before recheck, not an atomic registry CAS against other
  # applications. Preserve detected external edits and report partial progress.
  $state=$request.state; $results=New-Object System.Collections.ArrayList
  if (-not (Same (ReadValue $request.journal) $request.expectedJournal)) {
    throw 'Association recovery journal changed; retry after refreshing status'
  }
  SaveState $state
  foreach ($step in $request.steps) {
    if (-not (Same (ReadValue $step.target) $step.expected)) {
      [void]$results.Add(@{id=$step.target.id;status='conflict'}); continue
    }
    $state.pending=@{id=$step.target.id;expected=$step.expected;value=$step.value;recordAfter=$step.recordAfter}
    try {
      SaveState $state
      WriteValue $step.target $step.value
      if (-not (Same (ReadValue $step.target) $step.value)) { throw 'Registry value did not match after writing' }
      if ($null -eq $step.recordAfter) { $state.records.PSObject.Properties.Remove($step.target.id) }
      else { $state.records | Add-Member -NotePropertyName $step.target.id -NotePropertyValue $step.recordAfter -Force }
      $state.pending=$null; SaveState $state
      [void]$results.Add(@{id=$step.target.id;status='changed'})
    } catch {
      [void]$results.Add(@{id=$step.target.id;status='failed';message=$_.Exception.Message}); break
    }
  }
  if (@($results | Where-Object {$_.status -eq 'changed'}).Count -gt 0) {
    try {
      Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class SyAssociationNotify{[DllImport("shell32.dll")]public static extern void SHChangeNotify(uint e,uint f,IntPtr a,IntPtr b);}'
      [SyAssociationNotify]::SHChangeNotify(0x08000000,0,[IntPtr]::Zero,[IntPtr]::Zero)
    } catch { [void]$results.Add(@{id='shell-notify';status='failed';message=$_.Exception.Message}) }
  }
  @{results=@($results)} | ConvertTo-Json -Compress -Depth 35
} else { throw 'Invalid association registry operation' }
`;

function runRegistry(request) {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const executable = require('node:path').win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    const child = execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(REGISTRY_SCRIPT, 'utf16le').toString('base64')],
      { shell: false, windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        if (error) return reject(Object.assign(new Error('Windows 文件关联操作未完成，请刷新状态后重试。'), { code: 'SY_ASSOCIATION_REGISTRY_FAILED' }));
        try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, '').trim())); }
        catch { reject(Object.assign(new Error('Windows 文件关联回执无效，请刷新状态后重试。'), { code: 'SY_ASSOCIATION_REGISTRY_RESPONSE' })); }
      });
    child.stdin.on('error', () => { /* execFile callback reports process errors. */ });
    child.stdin.end(JSON.stringify(request), 'utf8');
  });
}
function createWindowsAssociationRegistry({ run = runRegistry } = {}) {
  return {
    read: (targets, journal) => run({ action: 'read', targets, journal }),
    apply: (request, journal) => run({ action: 'apply', ...request, journal }),
  };
}
module.exports = { createWindowsAssociationRegistry, REGISTRY_SCRIPT };
