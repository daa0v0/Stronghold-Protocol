<#
  卫戍协议：盟约 · Windows 上线自检（与 scripts/preflight-linux.sh 对称）
  文档：docs\DEPLOY-QUICKSTART.md、docs\ADMIN.md

  用法：
    powershell -ExecutionPolicy Bypass -File scripts\preflight-windows.ps1
    powershell -ExecutionPolicy Bypass -File scripts\preflight-windows.ps1 -Port 8080

  十节：系统 → Node 与依赖 → public\vendor → 数据与素材 → runtime 可写 → 后台密钥 →
 计划任务/服务 → 端口与防火墙 → HTTP 探活（/healthz、/admin、/ws）→ 结论。
  退出码：0 = 通过（可能有警告）；1 = 有失败项。
#>
param(
  [int]$Port = 3000,
  [string]$TaskName = 'StrongholdProtocol'
)
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$Root = Split-Path -Parent $PSScriptRoot
$EnvFile = Join-Path $PSScriptRoot 'service.env.cmd'
$SecretFile = Join-Path $Root 'runtime\admin.secret'

$script:Fails = 0
$script:Warns = 0
function Ok($m)   { Write-Host "  [ OK ]   $m" -ForegroundColor Green }
function Warn($m) { $script:Warns++; Write-Host "  [警告]   $m" -ForegroundColor Yellow }
function Bad($m)  { $script:Fails++; Write-Host "  [失败]   $m" -ForegroundColor Red }
function Head($m) { Write-Host "`n$m" -ForegroundColor Cyan }
function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
$IsAdmin = Test-Admin

# service.env.cmd 里的 PORT 优先（和实际跑起来的一致）
if (Test-Path $EnvFile) {
  $m = Select-String -Path $EnvFile -Pattern 'set "PORT=(\d+)"' | Select-Object -First 1
  if ($m) { $Port = [int]$m.Matches[0].Groups[1].Value }
}

Write-Host '卫戍协议：盟约 · Windows 上线自检'
Write-Host "项目目录：$Root"
Write-Host "监听端口：$Port"
Write-Host "计划任务：$TaskName"

# ---- 1. 系统 -----------------------------------------------------------------------------------
Head '1. 系统'
$os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
Ok ("{0} {1} ({2})" -f $os.Caption, $os.Version, $env:PROCESSOR_ARCHITECTURE)
if ($IsAdmin) { Ok '以管理员运行（防火墙与计划任务检查可用）' } else { Warn '非管理员：防火墙与计划任务看不全（建议用管理员 PowerShell 再跑一次）' }
$tz = (Get-TimeZone).Id
Ok "时区 $tz"

# ---- 2. Node 与依赖 ----------------------------------------------------------------------------
Head '2. Node 与依赖'
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Bad '找不到 node：先装 Node.js 22+（winget install OpenJS.NodeJS.LTS）'
  $nodeExe = $null
} else {
  $nodeExe = $nodeCmd.Source
  $ver = (& $nodeExe -v)
  $major = [int](($ver -replace '^v', '').Split('.')[0])
  if ($major -ge 22) { Ok "node $ver（$nodeExe）" } else { Bad "node $ver 太旧，需要 >= 22" }
}
if (Test-Path (Join-Path $Root 'node_modules\ws')) { Ok '依赖已安装（node_modules\ws 存在）' } else { Bad '依赖没装：npm ci --omit=dev' }
if (Test-Path (Join-Path $Root 'node_modules\@zip.js\zip.js\dist\zip-native.min.js')) { Ok '客户端压缩库 @zip.js 已安装' } else { Warn '@zip.js 不在 node_modules（素材预缓存会不可用）：npm ci --omit=dev' }
if (Test-Path (Join-Path $Root 'node_modules\eslint')) { Ok 'devDependencies 也在（可以在这台机器跑 node --test）' } else { Warn 'devDependencies 未安装：跑测试需要 npm ci（不带 --omit=dev）' }

# ---- 3. 客户端 vendor --------------------------------------------------------------------------
Head '3. 客户端 vendor（public\vendor，由 tools\vendor.mjs 生成）'
$vendorMissing = @()
foreach ($f in @('pixi.min.js', 'pixi-spine.js', 'preact.module.js', 'hooks.module.js', 'htm.module.js', 'three.module.js', 'zip-native.min.js')) {
  if (-not (Test-Path (Join-Path $Root "public\vendor\$f"))) { $vendorMissing += $f }
}
if ($vendorMissing.Count -eq 0) { Ok 'vendor 完整' }
else { Bad ("缺 public\vendor\{0} → node tools\vendor.mjs" -f ($vendorMissing -join ', public\vendor\')) }

# ---- 4. 数据与素材 -----------------------------------------------------------------------------
Head '4. 数据与素材'
foreach ($f in @('data\chess.json', 'data\assets.json', 'data\bonds.json', 'data\skins.json', 'data\config.json')) {
  if (Test-Path (Join-Path $Root $f)) { Ok $f } else { Bad "缺 $f" }
}
if (Test-Path (Join-Path $Root 'data\skins.json')) { Ok '干员皮肤目录存在（172 名干员 / 271 款）' }
$assetsDir = Join-Path $Root 'public\assets'
if (Test-Path $assetsDir) {
  $files = @(Get-ChildItem -Path $assetsDir -Recurse -File -ErrorAction SilentlyContinue)
  $mb = [math]::Round((($files | Measure-Object -Property Length -Sum).Sum / 1MB), 0)
  if ($files.Count -ge 5000) { Ok "素材 $($files.Count) 个文件 / $mb MB" }
  else { Warn "素材只有 $($files.Count) 个文件（完整约 13000+ / 800 MB）：node tools\setup.mjs --asset-source=mirror" }
  if (Test-Path (Join-Path $assetsDir 'spine\op')) { Ok '干员 Spine 模型目录存在' } else { Warn '缺 public\assets\spine\op（战场会退化成头像菱形）' }
} else {
  Warn '没有 public\assets：游戏能用占位图启动，但画面是占位样式'
}
if (Test-Path (Join-Path $Root 'data\local-assets.json')) { Ok '本地提取素材清单存在（3D 棋盘等可选素材）' }
else { Warn '缺 data\local-assets.json（可选：本地客户端提取的素材）' }

# ---- 5. 运行期可写目录 -------------------------------------------------------------------------
Head '5. 运行期可写目录（公告与 server-settings.json）'
$runtimeDir = Join-Path $Root 'runtime'
$runtimeOk = $false
if (Test-Path $runtimeDir) {
  try {
    $probe = Join-Path $runtimeDir '.preflight-write-test'
    Set-Content -Path $probe -Value 'ok' -ErrorAction Stop
    Remove-Item $probe -Force -ErrorAction SilentlyContinue
    $runtimeOk = $true
    Ok "$runtimeDir 可写"
  } catch { Bad "$runtimeDir 不可写：$($_.Exception.Message)" }
} else {
  Warn "$runtimeDir 不存在：New-Item -ItemType Directory -Path `"$runtimeDir`""
}

# ---- 6. 运维后台密钥 ---------------------------------------------------------------------------
Head '6. 运维后台密钥（docs\ADMIN.md）'
$secretValue = ''
$secretSource = ''
if (Test-Path $EnvFile) {
  $line = Select-String -Path $EnvFile -Pattern 'set "ADMIN_SECRET_FILE=(.+)"' | Select-Object -First 1
  if ($line) { $secretSource = $line.Matches[0].Groups[1].Value.Trim() }
  $line2 = Select-String -Path $EnvFile -Pattern 'set "ADMIN_SECRET=([^"]+)"' | Select-Object -First 1
  if ($line2) { $secretSource = '（service.env.cmd 内的 ADMIN_SECRET）'; $secretValue = $line2.Matches[0].Groups[1].Value }
}
if (-not $secretValue -and $env:ADMIN_SECRET) { $secretValue = $env:ADMIN_SECRET; $secretSource = '$env:ADMIN_SECRET' }
if (-not $secretValue -and $env:ADMIN_SECRET_FILE -and (Test-Path $env:ADMIN_SECRET_FILE)) { $secretSource = $env:ADMIN_SECRET_FILE; $secretValue = (Get-Content $env:ADMIN_SECRET_FILE -Raw).Trim() }
if (-not $secretValue -and $secretSource -and (Test-Path $secretSource)) { $secretValue = (Get-Content $secretSource -Raw).Trim() }
if (-not $secretValue -and (Test-Path $SecretFile)) { $secretSource = $SecretFile; $secretValue = (Get-Content $SecretFile -Raw).Trim() }
if (-not $secretValue) {
  Warn '没读到后台密钥 → 运维后台整体关闭（这是安全的默认）。装服务时会自动生成，见 scripts\install-service-windows.ps1'
} else {
  if ($secretValue.Length -ge 12) { Ok "密钥已配置（$($secretValue.Length) 字符，来源 $secretSource）" }
  elseif ($secretValue.Length -ge 6) { Ok "密钥已配置（$($secretValue.Length) 字符，来源 $secretSource）—— 本机/局域网够用；公网建议 12 个以上" }
  else { Bad "密钥只有 $($secretValue.Length) 字符，至少需要 6" }
}

# ---- 7. 计划任务 / Windows 服务 ----------------------------------------------------------------
Head '7. 后台运行方式'
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
  Ok "计划任务「$TaskName」已安装：$($task.State)（上次运行 $($info.LastRunTime)，结果 $($info.LastTaskResult)）"
  if (Test-Path $EnvFile) { Ok "环境文件 $EnvFile" } else { Warn "缺 $EnvFile（计划任务可能没配好）" }
} else {
  $svc = Get-Service -Name $TaskName -ErrorAction SilentlyContinue
  if ($svc) { Ok "Windows 服务「$TaskName」：$($svc.Status)" }
  else { Warn "没有计划任务「$TaskName」（$Root 现在可能是手动 npm start 起的）。想开机自启：powershell -ExecutionPolicy Bypass -File scripts\install-service-windows.ps1" }
}
$logFile = Join-Path $Root 'logs\server.log'
if (Test-Path $logFile) { Ok "日志文件存在：$logFile（最后写入 $((Get-Item $logFile).LastWriteTime)）" } else { Warn "还没有日志文件 $logFile（计划任务模式才会写）" }

# ---- 8. 端口与防火墙 ---------------------------------------------------------------------------
Head '8. 端口与防火墙'
$listener = $null
try { $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 } catch { }
if ($listener) {
  $proc = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
  Ok "端口 $Port 正在监听（pid $($listener.OwningProcess) $($proc.ProcessName)）"
} else {
  Warn "端口 $Port 没有监听（服务没起，或用了别的端口）"
}
$rule = $null
try { $rule = Get-NetFirewallRule -DisplayName 'Stronghold Protocol' -ErrorAction SilentlyContinue | Select-Object -First 1 } catch { }
if ($rule) {
  $enabled = if ($rule.Enabled -eq 'True') { '已启用' } else { '已禁用' }
  $profiles = $rule.Profile
  Ok "防火墙规则「Stronghold Protocol」存在（$enabled，配置文件 $profiles）"
} else {
  Warn "没有防火墙规则「Stronghold Protocol」：计划任务安装脚本会加（见 docs\DEPLOY.md §1.2）"
}

# ---- 9. HTTP 探活 ------------------------------------------------------------------------------
Head '9. HTTP 探活'
try {
  $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 5
  Ok "/healthz 正常：app=$($h.app) version=$($h.version) uptimeSec=$($h.uptimeSec) rooms=$($h.rooms) sockets=$($h.sockets)"
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/admin" -TimeoutSec 5 -UseBasicParsing
    Ok "/admin 返回 $($r.StatusCode)（后台已启用）"
  } catch {
    $code = $_.Exception.Response.StatusCode.value__
    if ($code -eq 404) { Ok '/admin 返回 404（没配 ADMIN_SECRET，后台关闭——预期行为）' }
    else { Warn "/admin 返回 $code（预期 200 或 404）" }
  }
  # WebSocket 握手：用 .NET ClientWebSocket 真连一次（curl 在 Windows 上行为不一）
  $wsOk = $false
  try {
    $c = New-Object System.Net.WebSockets.ClientWebSocket
    $cts = New-Object System.Threading.CancellationTokenSource
    $cts.CancelAfter(5000)
    $c.ConnectAsync((New-Object Uri "ws://127.0.0.1:$Port/ws"), $cts.Token).Wait(5000) | Out-Null
    if ($c.State -eq [System.Net.WebSockets.WebSocketState]::Open) { $wsOk = $true }
    $c.Dispose()
  } catch { }
  if ($wsOk) { Ok '/ws WebSocket 握手成功' } else { Warn '/ws 握手失败，WebSocket 可能没通（反代缺 Upgrade 头？）' }
} catch {
  Warn "/healthz 无响应：服务没起？（计划任务模式看 logs\server.log，手动模式看控制台）"
}

# ---- 10. 结论 ----------------------------------------------------------------------------------
Head '结论'
if ($script:Fails -eq 0 -and $script:Warns -eq 0) { Write-Host '  全部通过，可以开服。' -ForegroundColor Green; exit 0 }
if ($script:Fails -eq 0) { Write-Host "  通过，$($script:Warns) 项警告（不影响启动，按上面提示处理）。" -ForegroundColor Green; exit 0 }
Write-Host "  $($script:Fails) 项失败、$($script:Warns) 项警告：先解决失败项。" -ForegroundColor Red
Write-Host '  参考：docs\DEPLOY-QUICKSTART.md、docs\ADMIN.md'
exit 1
