param([string]$RequestPath)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Publish-Once([string]$Path, $Value) {
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 24 -Compress))
  $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  $stream = [IO.FileStream]::new($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
  [IO.File]::Move($temporary,$Path)
}
try {
  $request = if($RequestPath) { Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json } else { [Console]::In.ReadToEnd() | ConvertFrom-Json }
  Add-Type -LiteralPath (Join-Path $PSScriptRoot 'windows-process-identity.cs')
  $machine = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid).MachineGuid
  if($request.action -eq 'host') { @{ hostId=$machine; bootId=[ESProcessOwner]::BootId() } | ConvertTo-Json -Compress; exit 0 }
  if($request.action -eq 'inspect') { $result=[ESProcessOwner]::Inspect([uint32]$request.pid); $result['hostId']=$machine; $result | ConvertTo-Json -Depth 24 -Compress; exit 0 }
  if($request.action -eq 'owned-windows') {
    $expected=$request.identity
    if(!$expected -or $expected.native.kind -ne 'windows-job-v1' -or $expected.hostId -ne $machine -or $expected.bootId -ne [ESProcessOwner]::BootId() -or !$expected.argv) {
      @{status='unknown';reason='OWNED_WINDOW_IDENTITY_UNVERIFIED';windows=@()} | ConvertTo-Json -Compress; exit 0
    }
    $result=[ESProcessOwner]::OwnedWindows([uint32]$expected.pid,[string]$expected.creationFileTime,[string]$expected.startedAt,[string]$expected.userId,[string]$expected.executableIdentity,[string]$expected.commandLine,[string]$expected.bootId,[string[]]$expected.argv,[string]$expected.native.jobName)
    $result | ConvertTo-Json -Depth 24 -Compress; exit 0
  }
  if($request.action -eq 'owned-native-windows') {
    $expected=$request.identity
    if(!$expected -or $expected.native.kind -ne 'windows-job-v1' -or $expected.hostId -ne $machine -or $expected.bootId -ne [ESProcessOwner]::BootId() -or !$expected.argv) {
      @{status='unknown';reason='NATIVE_WINDOW_IDENTITY_UNVERIFIED';windows=@()} | ConvertTo-Json -Compress; exit 0
    }
    $result=[ESProcessOwner]::OwnedNativeWindows([uint32]$expected.pid,[string]$expected.creationFileTime,[string]$expected.startedAt,[string]$expected.userId,[string]$expected.executableIdentity,[string]$expected.commandLine,[string]$expected.bootId,[string[]]$expected.argv,[string]$expected.native.jobName,[string]$request.nativeExecutable)
    $result | ConvertTo-Json -Depth 24 -Compress; exit 0
  }
  if($request.action -eq 'job') {
    if($request.hostId -ne $machine -or $request.bootId -ne [ESProcessOwner]::BootId()) { @{status='conflict';reason='HOST_OR_BOOT_MISMATCH'} | ConvertTo-Json -Compress; exit 0 }
    $result=[ESProcessOwner]::Job($request.jobName,[bool]$request.stop)
    if($request.stop -and $result.activeProcesses -eq 0 -and $result.status -eq 'dead') {
      $end=@{launchId=$request.launchId;jobName=$request.jobName;verified=$true;activeProcesses=0;endedAt=[DateTime]::UtcNow.ToString('o');method='TerminateJobObject-then-query-zero'}
      if(!(Test-Path -LiteralPath $request.treeEndPath)) { try { Publish-Once $request.treeEndPath $end } catch { if(!(Test-Path -LiteralPath $request.treeEndPath)) { throw } } }
    }
    $result | ConvertTo-Json -Depth 24 -Compress; exit 0
  }
  if($request.action -ne 'launch') { throw 'UNSUPPORTED_ACTION' }
  $command=$request.command
  $environment=@{}
  Get-ChildItem Env: | ForEach-Object { $environment[$_.Name]=$_.Value }
  if($command.env) { $command.env.PSObject.Properties | ForEach-Object { $environment[$_.Name]=[string]$_.Value } }
  $environmentBlock=(($environment.Keys | Sort-Object | ForEach-Object { $_ + '=' + $environment[$_] }) -join "`0") + "`0`0"
  $owner=[ESProcessOwner]::Launch($command.executable,[string[]]$command.args,$command.cwd,$environmentBlock,$command.stdinPath,$command.stdoutPath,$command.stderrPath,$request.jobName,[string]$command.argumentSerialization)
  try {
    $identity=$owner.Identity; $identity['instanceId']=$request.instanceId; $identity['hostId']=$machine
    $identity['native']=@{ kind='windows-job-v1';jobName=$request.jobName;launchId=$request.launchId;evidencePath=$request.evidencePath;bootId=$identity.bootId;helperPid=$PID;cwdEvidence=@{path=$command.cwd;kind='frozen-createprocess-argument'};commandLine=$identity.commandLine;creationFileTime=$identity.creationFileTime;jobPolicy='no-breakaway-no-kill-on-close' }
    if($command.argumentSerialization) { $identity['native']['argumentSerialization']=$command.argumentSerialization }
    $receipt=@{pid=$owner.Pid;identity=$identity;treeIdentity=$identity.native;launchEvidence=@{version=1;launchId=$request.launchId;jobName=$request.jobName;launchedAt=[DateTime]::UtcNow.ToString('o');command=$command;identity=$identity;method='CreateProcess-suspended-AssignJob-resume';helperPid=$PID}}
    Publish-Once $request.evidencePath $receipt
    $rootWritten=$false
    do {
      if(!$rootWritten -and $owner.RootEnded()) { Publish-Once $request.rootEndPath @{launchId=$request.launchId;jobName=$request.jobName;pid=$owner.Pid;creationFileTime=$identity.creationFileTime;exitCode=$owner.ExitCode();endedAt=[DateTime]::UtcNow.ToString('o')}; $rootWritten=$true }
      $active=$owner.Active()
      if($active -eq 0) { if(!$rootWritten) { Publish-Once $request.rootEndPath @{launchId=$request.launchId;jobName=$request.jobName;pid=$owner.Pid;creationFileTime=$identity.creationFileTime;exitCode=$owner.ExitCode();endedAt=[DateTime]::UtcNow.ToString('o')} }; Publish-Once $request.treeEndPath @{launchId=$request.launchId;jobName=$request.jobName;verified=$true;activeProcesses=0;endedAt=[DateTime]::UtcNow.ToString('o')}; break }
      Start-Sleep -Milliseconds 100
    } while($true)
  } finally { $owner.Dispose() }
} catch {
  $failure=@{status='unknown';code='WINDOWS_IDENTITY_HELPER_FAILED';message=$_.Exception.Message}
  if($request.action -eq 'launch' -and !(Test-Path -LiteralPath $request.evidencePath)) { try { Publish-Once ($request.evidencePath + '.error.json') $failure } catch {} }
  $failure | ConvertTo-Json -Compress
  exit 1
}
