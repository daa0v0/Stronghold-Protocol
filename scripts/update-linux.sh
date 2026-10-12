#!/bin/sh
# scripts/update-linux.sh — 更新一台已部署的 Linux 服务器 (docs/DEPLOY-LINUX.md)
#
# 顺序：拉代码 → 按 lock 重装生产依赖 → 重新生成 public/vendor → 重启服务 → 探活。
# 注意：`npm ci --omit=dev` 会把 devDependencies（eslint/typescript/puppeteer）清掉，这正是服务器上想要的。
#      想在服务器上跑 `node --test` 的话，改成本脚本末尾提示的 `npm ci`（带 dev）。
# 用法：cd /opt/stronghold && sudo sh scripts/update-linux.sh
set -eu

APP_DIR=${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}
SERVICE=${SERVICE:-stronghold}
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-30}

say() { printf '%s\n' "$*"; }
fail() { printf '错误：%s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || fail "需要 root：sudo $0"
command -v node >/dev/null 2>&1 || fail "找不到 node"

cd "$APP_DIR" || fail "进不去 $APP_DIR"
say "更新目录        : $APP_DIR"

# ---- 1. 代码 -----------------------------------------------------------------------------------
if [ -d .git ]; then
  BRANCH=$(git rev-parse --abbrev-ref HEAD)
  say "git             : $BRANCH，拉到最新（--ff-only，绝不覆盖本地改动）"
  git fetch --prune
  git merge --ff-only "origin/$BRANCH" || fail "快进合并失败：本地有改动或历史分叉，请先手动处理"
  say "当前提交        : $(git rev-parse --short HEAD) $(git log -1 --pretty=%s)"
else
  say "git             : 不是 git 仓库，跳过（你自己用 rsync/scp 同步代码）"
fi

# ---- 2. 依赖 -----------------------------------------------------------------------------------
say "依赖            : npm ci --omit=dev"
npm ci --omit=dev --no-audit --no-fund --ignore-scripts
say "vendor          : node tools/vendor.mjs"
node tools/vendor.mjs

# ---- 3. 素材自查（不自动下载：几百 MB，且可能需要镜像/代理）------------------------------------
if [ -f data/assets.json ] && [ -d public/assets ]; then
  MANIFEST_FILES=$(grep -o '"/assets/[^"]*"' data/assets.json | wc -l | tr -d ' ')
  say "素材清单条目    : $MANIFEST_FILES（缺失的图会在游戏里用占位图，不影响启动）"
  say "                  需要补素材：node tools/setup.mjs --asset-source=mirror"
else
  say "素材            : 缺 data/assets.json 或 public/assets —— 游戏会以占位图运行"
fi

# ---- 4. 重启 -----------------------------------------------------------------------------------
if systemctl list-unit-files 2>/dev/null | grep -q "^${SERVICE}\.service"; then
  say "重启服务        : systemctl restart $SERVICE"
  systemctl restart "$SERVICE"
else
  say "systemd         : 没找到 $SERVICE.service，跳过重启（请手动重启你的进程）"
fi

# ---- 5. 探活 -----------------------------------------------------------------------------------
PORT_FROM_ENV=""
if [ -f "/etc/stronghold/stronghold.env" ]; then
  PORT_FROM_ENV=$(sed -n 's/^PORT=//p' /etc/stronghold/stronghold.env)
fi
PORT=${PORT:-${PORT_FROM_ENV:-3000}}
say "探活            : http://127.0.0.1:${PORT}/healthz（最多等 ${HEALTH_TIMEOUT}s）"
i=0
while [ "$i" -lt "$HEALTH_TIMEOUT" ]; do
  if command -v curl >/dev/null 2>&1; then
    BODY=$(curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/healthz" 2>/dev/null || true)
  else
    BODY=$(node -e "fetch('http://127.0.0.1:'+process.argv[1]+'/healthz').then(r=>r.text()).then(t=>{console.log(t)}).catch(()=>{})" "$PORT" 2>/dev/null || true)
  fi
  if [ -n "$BODY" ]; then
    say "健康检查        : $BODY"
    say ""
    say "更新完成。（服务器公告与 server-settings.json 在 runtime/，更新不会动它们；"
    say "  想在这台机器上跑测试的话：npm ci && node --test）"
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done

say "健康检查        : 超时未通过" >&2
say "看日志          : journalctl -u $SERVICE -n 80 --no-pager" >&2
exit 1
