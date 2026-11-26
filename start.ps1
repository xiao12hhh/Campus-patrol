# 石大·智巡 —— 一键启动脚本
#
# 生产模式（默认）：只跑 FastAPI，它同源托管 dist/ 前端，一个端口全搞定
#     .\start.ps1          然后浏览器打开 http://127.0.0.1:8000
# 开发模式（改前端代码时用，Vite 热更新）：
#     .\start.ps1 -Dev     然后浏览器打开 http://127.0.0.1:5173
#
# 双击 start.bat 也能启动（等价于不带参数的本脚本）。

param([switch]$Dev, [switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root
$port = 8000

function Write-Section($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

# ---------------------------------------------------------------- 1) 找 Python
# 系统 python 通常没装 fastapi/uvicorn，所以优先用带依赖的托管虚拟环境。
Write-Section '检查 Python'
$candidates = @(
    (Join-Path $env:USERPROFILE '.workbuddy/binaries/python/envs/default/Scripts/python.exe'),
    (Join-Path $root '.venv/Scripts/python.exe'),
    (Join-Path $root 'venv/Scripts/python.exe')
)
$py = $null
foreach ($c in $candidates) { if (Test-Path $c) { $py = $c; break } }
if (-not $py) {
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd) { $py = $cmd.Source }
}
if (-not $py) {
    Write-Host '没找到 Python。请先安装，或把依赖装到一个 venv 里。' -ForegroundColor Red
    exit 1
}
Write-Host "  使用: $py"

& $py -c 'import fastapi, uvicorn' 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "这个 Python 里没有 fastapi/uvicorn。请执行：  & '$py' -m pip install -r requirements.txt" -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------- 2) 生产模式：确认前端已构建
if (-not $Dev) {
    if (-not (Test-Path (Join-Path $root 'dist/index.html'))) {
        Write-Section 'dist/ 不存在，先构建前端'
        $nodeCands = @(
            (Join-Path $env:USERPROFILE '.workbuddy/binaries/node/versions/22.22.2-3/node.exe'),
            (Join-Path $root 'node.exe')
        )
        $node = $null
        foreach ($c in $nodeCands) { if (Test-Path $c) { $node = $c; break } }
        if (-not $node) { $cmd = Get-Command node -ErrorAction SilentlyContinue; if ($cmd) { $node = $cmd.Source } }
        if (-not $node) {
            Write-Host '没找到 Node.js，无法构建前端。请手动执行 vite build。' -ForegroundColor Red
            exit 1
        }
        & $node (Join-Path $root 'node_modules/vite/bin/vite.js') build
        if ($LASTEXITCODE -ne 0) { Write-Host '前端构建失败。' -ForegroundColor Red; exit 1 }
    }
}

# ---------------------------------------------------------------- 3) 识别同项目服务，代码变更时重启
$expectedVersion = (& $py -c 'from app.services.runtime_version import RUNTIME_VERSION; print(RUNTIME_VERSION)').Trim()
$occupied = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
$reuseBackend = $false
if ($occupied) {
    try {
        # Windows PowerShell 5 may decode JSON without charset as ANSI, corrupting Chinese paths.
        $healthResponse = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/health" -TimeoutSec 5
        $health = [Text.Encoding]::UTF8.GetString($healthResponse.RawContentStream.ToArray()) | ConvertFrom-Json
    }
    catch { throw "端口 $port 被未知服务占用，未停止该服务。" }
    if ($health.service -ne 'cup-campus-twin' -or $health.project_root -ne $root) {
        throw "端口 $port 的服务无法确认为当前项目（也可能是旧启动器启动的服务）。请关闭旧校园巡视后端窗口再运行，未停止未知进程。"
    }
    if ($health.backend_version -eq $expectedVersion) {
        Write-Host '当前项目后端版本一致，复用服务。' -ForegroundColor Green
        $reuseBackend = $true
    } else {
        Write-Section '检测到后端更新，重启当前项目服务'
        foreach ($processId in ($occupied.OwningProcess | Select-Object -Unique)) {
            Stop-Process -Id $processId -Force
        }
        for ($i = 0; $i -lt 20; $i++) {
            if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) { break }
            Start-Sleep -Milliseconds 250
        }
    }
}

# ---------------------------------------------------------------- 4) 启动后端
Write-Section "启动后端 (端口 $port)"
if (-not $reuseBackend) {
    Start-Process -FilePath $py -ArgumentList '-m', 'uvicorn', 'app.main:app', '--host', '0.0.0.0', '--port', "$port" -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $root 'backend.stdout.log') -RedirectStandardError (Join-Path $root 'backend.stderr.log')
}

# 等端口就绪
$ok = $false
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { $ok = $true; break }
}
if (-not $ok) {
    Write-Host "端口 $port 一直没起来，请查看 backend.stderr.log 中的报错。" -ForegroundColor Red
    exit 1
}

$url = "http://127.0.0.1:$port"
if ($Dev) {
    Write-Section '开发模式：启动 Vite'
    $nodeCands = @(
        (Join-Path $env:USERPROFILE '.workbuddy/binaries/node/versions/22.22.2-3/node.exe'),
        (Join-Path $root 'node.exe')
    )
    $node = $null
    foreach ($c in $nodeCands) { if (Test-Path $c) { $node = $c; break } }
    if (-not $node) { $cmd = Get-Command node -ErrorAction SilentlyContinue; if ($cmd) { $node = $cmd.Source } }
    if ($node) {
        Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoExit', '-Command',
            "& '$node' '$root/node_modules/vite/bin/vite.js' --host 0.0.0.0" -WorkingDirectory $root
        for ($i = 0; $i -lt 40; $i++) {
            Start-Sleep -Milliseconds 500
            if (Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue) { break }
        }
        $url = 'http://127.0.0.1:5173'
    } else {
        Write-Host '没找到 Node.js，只启动了后端。' -ForegroundColor Yellow
    }
}

Write-Host "`n启动完成，正在打开 $url" -ForegroundColor Green
if (-not $NoBrowser) { Start-Process $url }
