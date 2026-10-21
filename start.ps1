# 石大·智巡 —— 一键启动脚本
#
# 生产模式（默认）：只跑 FastAPI，它同源托管 dist/ 前端，一个端口全搞定
#     .\start.ps1          然后浏览器打开 http://127.0.0.1:8000
# 开发模式（改前端代码时用，Vite 热更新）：
#     .\start.ps1 -Dev     然后浏览器打开 http://127.0.0.1:5173
#
# 双击 start.bat 也能启动（等价于不带参数的本脚本）。

param([switch]$Dev)

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

# ---------------------------------------------------------------- 3) 端口已在监听就直接用
$occupied = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($occupied) {
    Write-Host "`n端口 $port 已有服务在跑（PID $($occupied.OwningProcess)），直接打开浏览器。" -ForegroundColor Yellow
    Start-Process "http://127.0.0.1:$port"
    exit 0
}

# ---------------------------------------------------------------- 4) 启动后端
Write-Section "启动后端 (端口 $port)"
Start-Process powershell -ArgumentList '-NoExit', '-Command',
    "& '$py' -m uvicorn app.main:app --host 0.0.0.0 --port $port" -WorkingDirectory $root

# 等端口就绪
$ok = $false
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { $ok = $true; break }
}
if (-not $ok) {
    Write-Host "端口 $port 一直没起来，请看刚弹出的那个窗口里的报错。" -ForegroundColor Red
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
        Start-Process powershell -ArgumentList '-NoExit', '-Command',
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
Start-Process $url
