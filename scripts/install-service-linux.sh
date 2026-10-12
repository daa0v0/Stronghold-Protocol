#!/bin/sh
# scripts/install-service-linux.sh — 把本项目装成 systemd 服务 (docs/DEPLOY-LINUX.md)
#
# 幂等：可以重复执行（已存在的用户/密钥/env 不会被覆盖）。
# 用法：
#   sudo APP_DIR=/opt/stronghold sh scripts/install-service-linux.sh
#   （写 ./scripts/… 也行，但要求脚本有可执行位；从 Windows 打的 zip 解压出来没有）
#
# 它做四件事：找 Node → 建运行用户与可写目录 → 生成/保留 ADMIN_SECRET → 安装并启动 systemd 单元。
# 它不下载素材、不装 Node：那两步见 docs/DEPLOY-LINUX.md 第 1、2 步（要联网、可能要几分钟）。
set -eu

APP_DIR=${APP_DIR:-/opt/stronghold}
APP_USER=${APP_USER:-stronghold}
ENV_DIR=${ENV_DIR:-/etc/stronghold}
SERVICE=${SERVICE:-stronghold}
UNIT="/etc/systemd/system/${SERVICE}.service"
PORT=${PORT:-3000}
HOST_BIND=${HOST_BIND:-::}

say() { printf '%s\n' "$*"; }
fail() { printf '错误：%s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || fail "需要 root：sudo $0"

# ---- 1. Node -----------------------------------------------------------------------------------
NODE_BIN=${NODE_BIN:-$(command -v node 2>/dev/null || true)}
[ -n "$NODE_BIN" ] || fail "找不到 node。先装 Node.js 22+（docs/DEPLOY-LINUX.md 第 1 步）"
case "$NODE_BIN" in /*) ;; *) NODE_BIN=$(command -v "$NODE_BIN") ;; esac
NODE_VERSION=$("$NODE_BIN" -v)
NODE_MAJOR=$(printf '%s' "$NODE_VERSION" | sed 's/^v//; s/\..*//')
[ "$NODE_MAJOR" -ge 22 ] 2>/dev/null || fail "需要 Node.js >= 22，当前 $NODE_VERSION"
say "Node            : $NODE_VERSION ($NODE_BIN)"

# ---- 2. 目录 -----------------------------------------------------------------------------------
[ -d "$APP_DIR" ] || fail "$APP_DIR 不存在。先把项目放到那里（docs/DEPLOY-LINUX.md 第 2 步）"
[ -f "$APP_DIR/server/index.js" ] || fail "$APP_DIR 看起来不是本项目（缺 server/index.js）"
[ -d "$APP_DIR/node_modules/ws" ] || fail "依赖没装：cd $APP_DIR && npm ci --omit=dev && node tools/vendor.mjs"

# ---- 3. 用户 -----------------------------------------------------------------------------------
if id "$APP_USER" >/dev/null 2>&1; then
  say "用户            : $APP_USER（已存在）"
else
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER" 2>/dev/null \
    || useradd -r -d "$APP_DIR" -s /sbin/nologin "$APP_USER" \
    || fail "创建用户 $APP_USER 失败"
  say "用户            : $APP_USER（已创建）"
fi
mkdir -p "$APP_DIR/runtime" "$ENV_DIR"
chown -R "$APP_USER:$APP_USER" "$APP_DIR/runtime"
chmod 750 "$APP_DIR/runtime"
chown root:"$APP_USER" "$ENV_DIR"
chmod 750 "$ENV_DIR"

# ---- 4. 管理员密钥 -----------------------------------------------------------------------------
if [ -s "$ENV_DIR/admin.secret" ]; then
  say "ADMIN_SECRET    : $ENV_DIR/admin.secret（已存在，保留）"
else
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32 > "$ENV_DIR/admin.secret"
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$ENV_DIR/admin.secret"
    printf '\n' >> "$ENV_DIR/admin.secret"
  fi
  chown root:"$APP_USER" "$ENV_DIR/admin.secret"
  chmod 640 "$ENV_DIR/admin.secret"
  say "ADMIN_SECRET    : $ENV_DIR/admin.secret（已生成，32 字节随机）"
fi

# ---- 5. 环境文件 -------------------------------------------------------------------------------
if [ -s "$ENV_DIR/stronghold.env" ]; then
  say "环境文件        : $ENV_DIR/stronghold.env（已存在，保留）"
else
  sed -e "s#^PORT=.*#PORT=${PORT}#" -e "s#^HOST=.*#HOST=${HOST_BIND}#" \
      "$APP_DIR/deploy/stronghold.env.example" > "$ENV_DIR/stronghold.env"
  chown root:"$APP_USER" "$ENV_DIR/stronghold.env"
  chmod 640 "$ENV_DIR/stronghold.env"
  say "环境文件        : $ENV_DIR/stronghold.env（已从示例生成）"
fi

# ---- 6. systemd 单元 ---------------------------------------------------------------------------
sed -e "s#^User=.*#User=${APP_USER}#" \
    -e "s#^Group=.*#Group=${APP_USER}#" \
    -e "s#^WorkingDirectory=.*#WorkingDirectory=${APP_DIR}#" \
    -e "s#^ExecStart=.*#ExecStart=${NODE_BIN} server/index.js#" \
    -e "s#^ReadWritePaths=.*#ReadWritePaths=${APP_DIR}/runtime ${APP_DIR}/.cache#" \
    -e "s#^Documentation=.*#Documentation=file://${APP_DIR}/docs/DEPLOY-LINUX.md#" \
    "$APP_DIR/deploy/stronghold.service" > "$UNIT"
chmod 644 "$UNIT"
say "systemd 单元    : $UNIT"

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1 || true
systemctl restart "$SERVICE"
sleep 2
if systemctl is-active --quiet "$SERVICE"; then
  say "服务状态        : 运行中"
else
  say "服务状态        : 未运行 —— 看日志：journalctl -u $SERVICE -n 50 --no-pager"
fi

# ---- 7. 结论与下一步 ---------------------------------------------------------------------------
BOUND=$(sed -n 's/^HOST=//p' "$ENV_DIR/stronghold.env")
P=$(sed -n 's/^PORT=//p' "$ENV_DIR/stronghold.env")
say ""
say "下一步："
say "  1) 自检    : sudo sh $APP_DIR/scripts/preflight-linux.sh"
say "  2) 本机探活: curl -s http://127.0.0.1:${P}/healthz"
say "  3) 后台密钥: sudo cat $ENV_DIR/admin.secret   （浏览器打开 /admin 登录用）"
if [ "$BOUND" = "127.0.0.1" ]; then
  say "  4) 绑定地址: HOST=127.0.0.1 —— 只有反向代理能访问，符合预期"
else
  say "  4) 绑定地址: HOST=$BOUND —— 直接对外。若前面放了 nginx/Caddy，建议改成 127.0.0.1"
  say "     并放行防火墙: sudo ufw allow ${P}/tcp"
fi
say "  5) 日志    : journalctl -u $SERVICE -f"
