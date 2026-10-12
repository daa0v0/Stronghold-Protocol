#!/bin/sh
# scripts/preflight-linux.sh — 上线前的 Linux 主机自检 (docs/DEPLOY-LINUX.md)
#
# 为什么有它：这个项目在 Windows 上开发、在 Linux 上部署，两边最容易出问题的地方（Node 版本、
# 生产依赖没装、public/vendor 没生成、素材缺、runtime 不可写、防火墙没放行、后台密钥没配、
# systemd 单元语法错）都能在这里一次性看出来。
#
# 用法：cd <项目目录> && sh scripts/preflight-linux.sh
#      sudo PORT=3000 sh scripts/preflight-linux.sh      # 带 sudo 能多看几项（防火墙、端口占用者）
#      （写 ./scripts/… 也行，但要求脚本有可执行位；从 Windows 打的 zip 解压出来没有，见下面第 0 节）
# 退出码：0 = 全部通过（可能有警告）；1 = 有 FAIL 项需要处理。
set -u

APP_DIR=${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}
PORT=${PORT:-3000}
HOST_BIND=${HOST_BIND:-}
SERVICE=${SERVICE:-stronghold}
ENV_FILE=${ENV_FILE:-/etc/stronghold/stronghold.env}
SECRET_FILE=${SECRET_FILE:-/etc/stronghold/admin.secret}
MIN_ASSET_FILES=${MIN_ASSET_FILES:-5000}

FAILS=0
WARNS=0
ok()   { printf '  [ OK ]   %s\n' "$*"; }
warn() { WARNS=$((WARNS + 1)); printf '  [警告]   %s\n' "$*"; }
bad()  { FAILS=$((FAILS + 1)); printf '  [失败]   %s\n' "$*"; }
head_() { printf '\n%s\n' "$*"; }

# 环境文件里的 PORT/HOST 优先于默认值
if [ -f "$ENV_FILE" ]; then
  P=$(sed -n 's/^PORT=//p' "$ENV_FILE" | head -n 1)
  H=$(sed -n 's/^HOST=//p' "$ENV_FILE" | head -n 1)
  [ -n "$P" ] && PORT=$P
  [ -n "$H" ] && HOST_BIND=$H
fi

printf '%s\n' "卫戍协议：盟约 · 上线自检"
printf '%s\n' "项目目录：$APP_DIR"
printf '%s\n' "监听端口：$PORT${HOST_BIND:+（HOST=$HOST_BIND）}"
printf '%s\n' "服务单元：$SERVICE.service"

# ---- 0. 调用方式与权限 -------------------------------------------------------------------------
# 为什么放第一节：从 Windows 打的 zip 解压到 Linux 会丢掉可执行位（zip 里没有 Unix 权限），副本于是是 0644，
# `./scripts/x.sh` 报 "Permission denied (os error 13)"；文件系统挂载了 noexec 报的是同一个错。两种情况下
# `sh scripts/x.sh` 都能跑（内核只需读这个文件，不需要执行它），所以这里先说清楚，再看别的。
head_ "0. 调用方式与权限"
SELF_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
if [ -x "$SELF_DIR/preflight-linux.sh" ]; then
  ok "scripts/*.sh 有可执行位"
else
  warn "scripts/*.sh 没有可执行位（从 Windows 打的 zip 解压常见）：sudo chmod +x scripts/*.sh，或者一直用 sh 调用（例如 sudo sh scripts/preflight-linux.sh）"
fi
MOUNT_OPTS=$(findmnt -no OPTIONS --target "$APP_DIR" 2>/dev/null || true)
if [ -z "$MOUNT_OPTS" ]; then
  warn "没有 findmnt（容器里常见），跳过 noexec 挂载检查"
elif printf '%s' "$MOUNT_OPTS" | tr ',' '\n' | grep -qx noexec; then
  warn "文件系统挂载了 noexec：脚本不能直接执行，请用 sh 调用（例如 sudo sh scripts/preflight-linux.sh）"
else
  ok "文件系统未挂载 noexec"
fi

# ---- 1. 系统 -----------------------------------------------------------------------------------
head_ "1. 系统"
# 发行版名字：直接读 /etc/os-release 的 PRETTY_NAME，不 source 它（不必让一个数据文件进 shell，shellcheck 也就不必跟随）
OS_NAME=$(sed -n 's/^PRETTY_NAME="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' /etc/os-release 2>/dev/null | head -n 1)
if [ -z "$OS_NAME" ]; then OS_NAME=$(uname -s); fi
ok "$(uname -s) $(uname -r) $(uname -m) · $OS_NAME"
if [ "$(id -u)" = "0" ]; then ok "以 root 运行（防火墙与端口占用检查可用）"; else warn "非 root：防火墙和端口占用者看不全（建议 sudo 再跑一次）"; fi

# ---- 2. Node 与依赖 ----------------------------------------------------------------------------
head_ "2. Node 与依赖"
NODE_BIN=$(command -v node 2>/dev/null || true)
if [ -z "$NODE_BIN" ]; then
  bad "找不到 node：装 Node.js 22+（docs/DEPLOY-LINUX.md 第 1 步）"
else
  NODE_VERSION=$("$NODE_BIN" -v)
  NODE_MAJOR=$(printf '%s' "$NODE_VERSION" | sed 's/^v//; s/\..*//')
  if [ "$NODE_MAJOR" -ge 22 ] 2>/dev/null; then ok "node $NODE_VERSION（$NODE_BIN）"; else bad "node $NODE_VERSION 太旧，需要 >= 22"; fi
fi
if [ -d "$APP_DIR/node_modules/ws" ]; then ok "依赖已安装（node_modules/ws 存在）"; else bad "依赖没装：npm ci --omit=dev"; fi
if [ -f "$APP_DIR/node_modules/@zip.js/zip.js/dist/zip-native.min.js" ]; then ok "客户端压缩库 @zip.js 已安装"; else warn "@zip.js 不在 node_modules（素材预缓存 worker 会不可用）：npm ci --omit=dev"; fi
if [ -d "$APP_DIR/node_modules/eslint" ]; then ok "devDependencies 也在（可以在这台机器跑 node --test）"; else warn "devDependencies 未安装——服务器上这是正常的（update-linux.sh 用 --omit=dev 装生产依赖）；只有想在这台机器跑 node --test 才需要 npm ci"; fi

# ---- 3. 客户端 vendor --------------------------------------------------------------------------
head_ "3. 客户端 vendor（public/vendor，由 tools/vendor.mjs 生成）"
for f in pixi.min.js pixi-spine.js preact.module.js hooks.module.js htm.module.js three.module.js zip-native.min.js; do
  [ -s "$APP_DIR/public/vendor/$f" ] || bad "缺 public/vendor/$f → node tools/vendor.mjs"
done
[ -s "$APP_DIR/public/vendor/zip-native.min.js" ] || warn "缺 zip-native.min.js 时素材预缓存不能用（其余功能正常）"
[ "$FAILS" = "0" ] && ok "vendor 完整"

# ---- 4. 数据与素材 -----------------------------------------------------------------------------
head_ "4. 数据与素材"
for f in data/chess.json data/assets.json data/bonds.json data/skins.json data/config.json; do
  if [ -s "$APP_DIR/$f" ]; then ok "$f"; else bad "缺 $f"; fi
done
if [ -s "$APP_DIR/data/skins.json" ]; then
  SKIN_CHARS=$(grep -o '"chars"' "$APP_DIR/data/skins.json" | wc -l | tr -d ' ')
  if [ "$SKIN_CHARS" -ge 1 ]; then ok "干员皮肤目录存在（172 名干员 / 271 款）"; else warn "data/skins.json 内容异常"; fi
fi
if [ -d "$APP_DIR/public/assets" ]; then
  ASSET_FILES=$(find "$APP_DIR/public/assets" -type f 2>/dev/null | wc -l | tr -d ' ')
  ASSET_MB=$(du -sm "$APP_DIR/public/assets" 2>/dev/null | cut -f1)
  if [ "${ASSET_FILES:-0}" -ge "$MIN_ASSET_FILES" ]; then
    ok "素材 $ASSET_FILES 个文件 / ${ASSET_MB:-?} MB"
  else
    warn "素材只有 $ASSET_FILES 个文件（完整约 13000+ / 800 MB）：node tools/setup.mjs --asset-source=mirror"
  fi
  if [ -d "$APP_DIR/public/assets/spine/op" ]; then ok "干员 Spine 模型目录存在"; else warn "缺 public/assets/spine/op（战场会退化成头像菱形）"; fi
else
  warn "没有 public/assets：游戏能用占位图启动，但画面是占位样式"
fi
if [ -s "$APP_DIR/data/local-assets.json" ]; then ok "本地提取素材清单存在（3D 棋盘等可选素材）"; else warn "缺 data/local-assets.json（可选：本地客户端提取的素材）"; fi

# ---- 5. 运行期可写目录 -------------------------------------------------------------------------
head_ "5. 运行期可写目录（公告与 server-settings.json）"
RUNTIME_DIR=$APP_DIR/runtime
if [ -d "$RUNTIME_DIR" ]; then
  if touch "$RUNTIME_DIR/.preflight-write-test" 2>/dev/null; then
    rm -f "$RUNTIME_DIR/.preflight-write-test"
    ok "$RUNTIME_DIR 可写"
    if [ "$(id -u)" = "0" ]; then
      RUNTIME_OWNER=$(stat -c '%U:%G' "$RUNTIME_DIR" 2>/dev/null || echo '?')
      ok "属主 $RUNTIME_OWNER（systemd 里 User= 必须能写它）"
    fi
  else
    bad "$RUNTIME_DIR 不可写：chown -R stronghold:stronghold $RUNTIME_DIR"
  fi
else
  warn "$RUNTIME_DIR 不存在：创建它并让服务用户可写（mkdir -p $RUNTIME_DIR）"
fi
if [ -d "$APP_DIR/public/assets" ] && [ ! -w "$APP_DIR/public/assets" ]; then
  ok "public/assets 只读（正常：素材只在安装时写）"
fi

# ---- 6. 管理员密钥 -----------------------------------------------------------------------------
head_ "6. 运维后台密钥（docs/ADMIN.md）"
SECRET_VALUE=${ADMIN_SECRET:-}
if [ -z "$SECRET_VALUE" ] && [ -n "${ADMIN_SECRET_FILE:-}" ] && [ -r "${ADMIN_SECRET_FILE}" ]; then
  SECRET_VALUE=$(cat "${ADMIN_SECRET_FILE}" 2>/dev/null || true)
fi
if [ -z "$SECRET_VALUE" ] && [ -r "$SECRET_FILE" ]; then
  SECRET_VALUE=$(cat "$SECRET_FILE" 2>/dev/null || true)
fi
if [ -z "$SECRET_VALUE" ]; then
  warn "没读到 ADMIN_SECRET / ADMIN_SECRET_FILE / $SECRET_FILE → 运维后台整体关闭（这是安全的默认）"
else
  LEN=$(printf '%s' "$SECRET_VALUE" | tr -d '\n' | wc -c | tr -d ' ')
  if [ "$LEN" -ge 12 ]; then ok "密钥已配置（$LEN 字符）"
  elif [ "$LEN" -ge 6 ]; then ok "密钥已配置（$LEN 字符）—— 本机/局域网够用；公网建议 12 个以上"
  else bad "密钥只有 $LEN 字符，至少需要 6"; fi
fi
if [ -f "$SECRET_FILE" ]; then
  MODE=$(stat -c '%a' "$SECRET_FILE" 2>/dev/null || echo '?')
  case "$MODE" in
    640|600|400) ok "$SECRET_FILE 权限 $MODE（不 world-readable）" ;;
    *) warn "$SECRET_FILE 权限 $MODE，建议 640：chmod 640 $SECRET_FILE" ;;
  esac
fi

# ---- 7. systemd 单元 ---------------------------------------------------------------------------
head_ "7. systemd 单元"
UNIT="/etc/systemd/system/${SERVICE}.service"
if [ -f "$UNIT" ]; then
  ok "$UNIT 存在"
  MISSING=""
  for key in WorkingDirectory ExecStart User Restart; do
    grep -q "^${key}=" "$UNIT" || MISSING="$MISSING $key"
  done
  if [ -z "$MISSING" ]; then ok "必备字段齐全（WorkingDirectory/ExecStart/User/Restart）"; else bad "单元缺少字段：$MISSING"; fi
  if command -v systemd-analyze >/dev/null 2>&1; then
    if systemd-analyze verify "$UNIT" >/dev/null 2>&1; then ok "systemd-analyze verify 通过"; else warn "systemd-analyze verify 有意见：systemd-analyze verify $UNIT"; fi
  else
    warn "没有 systemd-analyze，跳过单元校验"
  fi
  EXEC=$(sed -n 's/^ExecStart=//p' "$UNIT" | head -n 1 | awk '{print $1}')
  if [ -n "$EXEC" ] && [ -x "$EXEC" ]; then ok "ExecStart 的 $EXEC 可执行"; else bad "ExecStart 指向的 $EXEC 不可执行（Node 路径不对？）"; fi
  WD=$(sed -n 's/^WorkingDirectory=//p' "$UNIT" | head -n 1)
  if [ -d "$WD" ]; then ok "WorkingDirectory=$WD 存在"; else bad "WorkingDirectory=$WD 不存在"; fi
  if command -v systemctl >/dev/null 2>&1; then
    if systemctl is-active --quiet "$SERVICE"; then ok "服务运行中"; else warn "服务未运行：systemctl start $SERVICE"; fi
    if systemctl is-enabled --quiet "$SERVICE" 2>/dev/null; then ok "已设为开机自启"; else warn "未设开机自启：systemctl enable $SERVICE"; fi
  fi
else
  warn "没装 systemd 单元（$UNIT）。想用 systemd 托管：sudo sh scripts/install-service-linux.sh"
fi

# ---- 8. 端口与防火墙 ---------------------------------------------------------------------------
head_ "8. 端口与防火墙"
LISTENING=""
if command -v ss >/dev/null 2>&1; then
  LISTENING=$(ss -ltn 2>/dev/null | awk -v p=":${PORT}" '$4 ~ p {print $4; exit}')
elif command -v netstat >/dev/null 2>&1; then
  LISTENING=$(netstat -ltn 2>/dev/null | awk -v p=":${PORT}" '$4 ~ p {print $4; exit}')
fi
if [ -n "$LISTENING" ]; then
  ok "端口 $PORT 正在监听（$LISTENING）"
  if [ "$(id -u)" = "0" ] && command -v ss >/dev/null 2>&1; then
    OWNER=$(ss -ltnp 2>/dev/null | awk -v p=":${PORT}" '$4 ~ p {print $6; exit}')
    [ -n "$OWNER" ] && ok "监听者：$OWNER"
  fi
elif command -v curl >/dev/null 2>&1 && curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
  # ss/netstat 没给出结果（容器里没装 iproute2/net-tools，或在非 Linux 的 shell 里跑），但端口确实通
  ok "端口 $PORT 可达（HTTP 探活通过；本机没有 ss/netstat 的可用输出）"
else
  warn "端口 $PORT 没有监听（服务没起，或用了别的端口）"
fi
if command -v ufw >/dev/null 2>&1; then
  if ufw status 2>/dev/null | grep -q "^Status: active"; then
    if ufw status 2>/dev/null | grep -qE "(^| )${PORT}(/tcp)?( |$)"; then ok "ufw 已放行 $PORT"; else warn "ufw 开着但没放行 $PORT：sudo ufw allow ${PORT}/tcp"; fi
  else
    ok "ufw 未启用"
  fi
elif command -v firewall-cmd >/dev/null 2>&1; then
  if firewall-cmd --state >/dev/null 2>&1; then
    if firewall-cmd --list-ports 2>/dev/null | grep -q "${PORT}/tcp"; then ok "firewalld 已放行 $PORT"; else warn "firewalld 开着但没放行：sudo firewall-cmd --add-port=${PORT}/tcp --permanent && sudo firewall-cmd --reload"; fi
  else
    ok "firewalld 未运行"
  fi
else
  warn "没装 ufw / firewalld：确认云厂商安全组是否放行了 $PORT（腾讯云/阿里云默认不放行）"
fi

# ---- 9. HTTP 探活 ------------------------------------------------------------------------------
head_ "9. HTTP 探活"
if command -v curl >/dev/null 2>&1; then
  HEALTH=$(curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/healthz" 2>/dev/null || true)
  if [ -n "$HEALTH" ]; then
    ok "/healthz 正常：$(printf '%s' "$HEALTH" | cut -c1-160)"
    CODE_ADMIN=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${PORT}/admin" 2>/dev/null || echo '?')
    CODE_ADMIN=$(printf '%s' "$CODE_ADMIN" | tr -cd '0-9')
    case "$CODE_ADMIN" in
      200) ok "/admin 返回 200（后台已启用）" ;;
      404) ok "/admin 返回 404（没配 ADMIN_SECRET，后台关闭——预期行为）" ;;
      *)   warn "/admin 返回 ${CODE_ADMIN:-无响应}（预期 200 或 404）" ;;
    esac
    # 握手成功时 curl 拿到 101 就停在那里，直到 --max-time 超时并以非零退出，所以输出可能带兜底字符：只取数字。
    CODE_WS=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "http://127.0.0.1:${PORT}/ws" 2>/dev/null || echo '?')
    CODE_WS=$(printf '%s' "$CODE_WS" | tr -cd '0-9')
    case "$CODE_WS" in
      101) ok "/ws 返回 101：WebSocket 握手成功" ;;
      400|426) ok "/ws 返回 $CODE_WS：路由通（缺 hello/协议头时的正常回应）" ;;
      *) warn "/ws 返回 ${CODE_WS:-无响应}，WebSocket 可能没通" ;;
    esac
  else
    warn "/healthz 无响应：服务没起？journalctl -u $SERVICE -n 50 --no-pager"
  fi
else
  warn "没有 curl，跳过 HTTP 探活"
fi

# ---- 10. 结论 ---------------------------------------------------------------------------------
head_ "结论"
if [ "$FAILS" = "0" ] && [ "$WARNS" = "0" ]; then
  printf '%s\n' "  全部通过，可以开服。"
  exit 0
fi
if [ "$FAILS" = "0" ]; then
  printf '%s\n' "  通过，$WARNS 项警告（不影响启动，按上面提示处理）。"
  exit 0
fi
printf '%s\n' "  $FAILS 项失败、$WARNS 项警告：先解决失败项。"
printf '%s\n' "  参考：docs/DEPLOY-LINUX.md §7 排错"
exit 1
