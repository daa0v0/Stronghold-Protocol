<#
  卫戍协议：盟约 · 开机自动在后台运行服务器（Windows 任务计划程序）+ 防火墙规则。文档：docs\DEPLOY.md
  用法（会自动请求管理员权限）：
    powershell -ExecutionPolicy Bypass -File scripts\install-service-windows.ps1              # 安装并立即启动
    powershell -ExecutionPolicy Bypass -File scripts\install-service-windows.ps1 -Port 8080 -Verify sample
    powershell -ExecutionPolicy Bypass -File scripts\install-service-windows.ps1 -Status     # 查看状态
    powershell -ExecutionPolicy Bypass -File scripts\install-service-windows.ps1 -Restart    # 更新代码后重启
    powershell -ExecutionPolicy Bypass -File scripts\install-service-windows.ps1 -Stop
    powershell -ExecutionPolicy Bypass -File scripts\install-service-windows.ps1 -Uninstall  # 删除任务和防火墙规则
  做的事：写入 scripts\service.env.cmd（node.exe 路径、PORT、HOST、SP_COMBAT、SP_VERIFY）→ 注册计划任务
  「StrongholdProtocol」（开机时以 SYSTEM 身份运行 scripts\run-server.cmd，无需登录；进程退出 5 秒后自动重启；
  日志 logs\server.log）→ 添加入站防火墙规则「Stronghold Protocol」（TCP 端口，专用/域网络；-AllowPublicNetwork 也放行公用网络）。
#>
param(
  [int]$Port = 3000,
  [string]$BindHost = '::',
  [ValidateSet('client', 'server')][string]$Combat = 'client',
  [ValidateSet('off', 'sample', 'all')][string]$Verify = 'off',
  # 运维后台 (docs/ADMIN.md)。不传 = 首次自动生成一个 32 字节随机密钥（存在 runtime\admin.secret，
  # 并写进 service.env.cmd 的 ADMIN_SECRET_FILE）；重新执行时沿用已有密钥，不会把人踢下线。
  # 传 -NoAdmin 就是完全不开后台。
  [string]$AdminSecret = '',
  [switch]$NoAdmin,
  [string]$TaskName = 'StrongholdProtocol',
  [switch]$AllowPublicNetwork,
  [switch]$NoFirewall,
  [switch]$Status,
  [switch]$Stop,
  [switch]$Restart,
  [switch]$Uninstall
)
# 'Continue': native tools (netsh, node) report through exit codes; Windows PowerShell 5.1 would turn their
# redirected stderr into terminating errors under 'Stop'. Cmdlets that must succeed use -ErrorAction Stop.
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$Root = Split-Path -Parent $PSScriptRoot
$RuleName = 'Stronghold Protocol'
$EnvFile = Join-Path $PSScriptRoot 'service.env.cmd'
$Runner = Join-Path $PSScriptRoot 'run-server.cmd'
$Log = Join-Path $Root 'logs\server.log'

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Stop-ServerProcesses {
  # the task runs cmd.exe (run-server.cmd, a restart loop) → node.exe: stop the loop first, then its children
  $runners = @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*run-server.cmd*' })
  foreach ($r in $runners) {
    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($r.ProcessId)" -ErrorAction SilentlyContinue)
    Stop-Process -Id $r.ProcessId -Force -ErrorAction SilentlyContinue
    foreach ($ch in $children) { Stop-Process -Id $ch.ProcessId -Force -ErrorAction SilentlyContinue }
  }
}

function Show-Status {
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $t) { Write-Host "计划任务「$TaskName」未安装。" -ForegroundColor Yellow }
  else {
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Host "计划任务「$TaskName」：$($t.State)，上次运行 $($info.LastRunTime)，结果 $($info.LastTaskResult)"
  }
  $p = $Port
  if (Test-Path $EnvFile) {
    $m = Select-String -Path $EnvFile -Pattern 'set "PORT=(\d+)"' | Select-Object -First 1
    if ($m) { $p = [int]$m.Matches[0].Groups[1].Value }
  }
  try {
    $h = Invoke-RestMethod -Uri "http://127.0.0.1:$p/healthz" -TimeoutSec 3
    Write-Host "服务器正在运行：端口 $p，房间 $($h.rooms)，对局 $($h.matches)，连接 $($h.sockets)" -ForegroundColor Green
  } catch { Write-Host "端口 $p 上没有响应（刚启动时请等几秒；日志：$Log）" -ForegroundColor Yellow }
  & netsh advfirewall firewall show rule name="$RuleName" | Out-Null
  if ($LASTEXITCODE -eq 0) { Write-Host "防火墙规则「$RuleName」已存在。" } else { Write-Host "防火墙规则「$RuleName」不存在。" -ForegroundColor Yellow }
  # 运维后台：service.env.cmd 里有没有 ADMIN_SECRET_FILE / ADMIN_SECRET
  if (Test-Path $EnvFile) {
    $adminLine = Select-String -Path $EnvFile -Pattern 'set "(ADMIN_SECRET_FILE|ADMIN_SECRET)=' | Select-Object -First 1
    if ($adminLine) {
      $secretPath = Join-Path $Root 'runtime\admin.secret'
      Write-Host "运维后台已启用：http://127.0.0.1:$p/admin" -ForegroundColor Green
      if (Test-Path $secretPath) { Write-Host "  密钥文件：$secretPath（内容即登录密钥，见 docs\ADMIN.md）" }
    } else {
      Write-Host "运维后台未启用（重装时加 -AdminSecret，或不加 -NoAdmin）。" -ForegroundColor Yellow
    }
  }
  if (Test-Path $Log) { Write-Host "`n日志最后 10 行（$Log）："; Get-Content $Log -Tail 10 }
}

# Status needs no elevation
if ($Status) { Show-Status; exit 0 }

if (-not (Test-Admin)) {
  Write-Host '需要管理员权限，正在请求提升…' -ForegroundColor Yellow
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
  foreach ($kv in $PSBoundParameters.GetEnumerator()) {
    if ($kv.Value -is [System.Management.Automation.SwitchParameter]) { if ($kv.Value.IsPresent) { $argList += "-$($kv.Key)" } }
    else { $argList += @("-$($kv.Key)", "`"$($kv.Value)`"") }
  }
  try {
    $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -Verb RunAs -Wait -PassThru -ErrorAction Stop
    exit $p.ExitCode
  } catch {
    Write-Host "未获得管理员权限，已取消：$($_.Exception.Message)" -ForegroundColor Red
    exit 1
  }
}

try {
  if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
      Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
    }
    Stop-ServerProcesses
    & netsh advfirewall firewall delete rule name="$RuleName" | Out-Null
    if (Test-Path $EnvFile) { Remove-Item $EnvFile -Force }
    Write-Host '已删除计划任务、防火墙规则和 scripts\service.env.cmd。' -ForegroundColor Green
    exit 0
  }
  if ($Stop -or $Restart) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Stop-ServerProcesses
    Write-Host '服务器已停止。'
    if ($Stop) { exit 0 }
    Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    Start-Sleep -Seconds 3
    Show-Status
    exit 0
  }

  # --- install ------------------------------------------------------------------------------------
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) { throw '未找到 Node.js：请先安装（winget install OpenJS.NodeJS.LTS），然后重新打开 PowerShell。' }
  $nodeExe = $nodeCmd.Source
  $major = [int](((& $nodeExe -v) -replace '^v', '').Split('.')[0])
  if ($major -lt 22) { throw "Node.js 版本太旧（需要 22+）：$(& $nodeExe -v)" }
  if ($nodeExe -like "$env:USERPROFILE*") {
    Write-Host "注意：node.exe 位于用户目录（$nodeExe，nvm/便携版？）。SYSTEM 账户一般也能运行它；若服务起不来，请改用 winget / 官网安装包安装的 Node.js。" -ForegroundColor Yellow
  }

  Set-Location $Root
  Write-Host '准备运行环境（node tools\setup.mjs）…' -ForegroundColor Cyan
  & $nodeExe tools\setup.mjs --quiet
  if ($LASTEXITCODE -ne 0) { throw 'setup 失败，请先解决上面的问题（node tools\doctor.mjs 可诊断）。' }

  @(
    '@rem Written by scripts\install-service-windows.ps1 - re-run it to change these values.',
    "set `"NODE_EXE=$nodeExe`"",
    "set `"PORT=$Port`"",
    "set `"HOST=$BindHost`"",
    "set `"SP_COMBAT=$Combat`"",
    "set `"SP_VERIFY=$Verify`""
  ) | Set-Content -Path $EnvFile -Encoding Oem -ErrorAction Stop

  # ---- 运维后台密钥（与 Linux 的 scripts/install-service-linux.sh 对称）--------------------------------
  $AdminSecretFile = Join-Path $Root 'runtime\admin.secret'
  $adminEnabled = -not $NoAdmin
  if ($adminEnabled) {
    $runtimeDir = Join-Path $Root 'runtime'
    if (-not (Test-Path $runtimeDir)) { New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null }
    if (-not $AdminSecret) {
      # 已有密钥就沿用：重装/改端口不该让所有登录失效
      if (Test-Path $AdminSecretFile) {
        $AdminSecret = (Get-Content $AdminSecretFile -Raw).Trim()
      } else {
        $bytes = New-Object byte[] 32
        [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
        $AdminSecret = (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
      }
    }
    if ($AdminSecret.Length -lt 6) { throw "ADMIN_SECRET 至少需要 6 个字符（当前 $($AdminSecret.Length) 个）；12 个以上更适合公网。" }
    Set-Content -Path $AdminSecretFile -Value $AdminSecret -Encoding Ascii -NoNewline -ErrorAction Stop
    # 密钥放文件里（不放 env 文件），服务端启动时自己读，与 Linux 的 ADMIN_SECRET_FILE 用法一致
    Add-Content -Path $EnvFile -Value "set `"ADMIN_SECRET_FILE=$AdminSecretFile`"" -Encoding Oem
    Write-Host "已配置运维后台密钥：$AdminSecretFile" -ForegroundColor Green
  } else {
    Remove-Item -Path (Join-Path $Root 'runtime\admin.secret') -ErrorAction SilentlyContinue
    Write-Host '未启用运维后台（-NoAdmin）。' -ForegroundColor Yellow
  }

  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Stop-ServerProcesses
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
  $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/d /c `"`"$Runner`"`"" -WorkingDirectory $Root
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $trigger.Delay = 'PT20S'   # give the network a moment after boot
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
    -Description "Stronghold Protocol web server ($Root)" -ErrorAction Stop | Out-Null
  Write-Host "已注册计划任务「$TaskName」（开机自动启动，无需登录）。" -ForegroundColor Green

  if (-not $NoFirewall) {
    & netsh advfirewall firewall delete rule name="$RuleName" | Out-Null
    $profiles = if ($AllowPublicNetwork) { 'private,domain,public' } else { 'private,domain' }
    & netsh advfirewall firewall add rule name="$RuleName" dir=in action=allow protocol=TCP localport=$Port profile=$profiles | Out-Null
    Write-Host "已添加防火墙入站规则「$RuleName」：TCP $Port（$profiles）。" -ForegroundColor Green
  }

  Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  Start-Sleep -Seconds 4
  Show-Status
  if ($adminEnabled) {
    Write-Host "`n运维后台（浏览器打开，用下面的密钥登录）："
    Write-Host "  http://localhost:$Port/admin"
    Write-Host "  密钥：$AdminSecret" -ForegroundColor Cyan
    Write-Host "  （也已存到 $AdminSecretFile；公网使用请配合 HTTPS，见 docs\ADMIN.md）"
  }
  Write-Host "`n朋友访问地址（局域网 / IPv6，方括号不能少）："
  # doctor prints a full URL. An IPv6 literal is bracketed, so a pattern that requires a digit right after http://
  # would drop it. Keep every http:// line; the rest of the report is classification text.
  & $nodeExe tools\doctor.mjs --port $Port | Select-String -Pattern 'http://' | ForEach-Object { Write-Host "  $($_.Line.Trim())" }
  Write-Host "`n停止：-Stop   重启：-Restart   状态：-Status   卸载：-Uninstall   日志：$Log"
} catch {
  Write-Host "`n出错：$($_.Exception.Message)" -ForegroundColor Red
  Read-Host '按回车键关闭' | Out-Null
  exit 1
}
if ($Host.Name -eq 'ConsoleHost' -and -not $env:SP_NO_PAUSE) { Read-Host "`n完成。按回车键关闭" | Out-Null }
