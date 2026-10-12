# Linux 服务器部署

面向"一台公网 Linux 服务器，开给别人玩"的场景。Windows 小主机见 [DEPLOY.md](DEPLOY.md) §1，最短命令版见 [DEPLOY-QUICKSTART.md](DEPLOY-QUICKSTART.md) 路线 B。

> **同一份代码两边都能跑**：Windows 与 Linux 的代码、素材、测试完全一致，只有服务托管方式（计划任务 vs systemd）、防火墙、反代和自检脚本不同。两块平台的对照表与平台相关行为差异见 [DEPLOY-QUICKSTART.md](DEPLOY-QUICKSTART.md) 的「同一份代码，Windows 和 Linux 都能跑」。Windows 那边的对应脚本是 `scripts/install-service-windows.ps1` 与 `scripts/preflight-windows.ps1`。

**关于本文的验证程度（先说清楚）**

已经在**非 Linux 主机**上做到的：

- 四个 shell 脚本通过 `bash -n` 与 POSIX `sh -n` 语法校验；
- **ShellCheck 0.10 以 `--shell=sh`（dash 语义）在 style 级别检查，零告警**（`scripts/*.sh`）；
- `scripts/preflight-linux.sh` 在真实 shell 里跑通，含"有服务 / 无服务"两条分支与 `/healthz`、`/admin`、`/ws` 探活；
- 安装脚本的两处 `sed` 转换（`deploy/stronghold.service` 与 `deploy/stronghold.env.example`）**逐条断言过产物**：键不重复、路径正确、`ProtectSystem=strict` 与 `EnvironmentFile` 保留；
- systemd 单元的关键不变量（含 `ReadWritePaths` 必须覆盖 `runtime/`、以及**不能**打开 `MemoryDenyWriteExecute`）由 `test/deploy-assets.test.js` 守住；
- Windows 侧对称脚本 `scripts/preflight-windows.ps1` 已在真实的 Windows PowerShell 5.1 与 PowerShell 7 下解析并运行通过。

**仍未做到的**：在真实的 Linux 主机（systemd + 发行版包管理器）上完整安装并启动一次服务。所以第 10 步的 `preflight-linux.sh` 不是可选项——它就是把"我没能替你验证的部分"在你的机器上跑一遍；有任何一项失败，把输出发给我即可。

---

## 0. 资源与前提

| 项目 | 要求 |
|---|---|
| 系统 | 任何带 systemd 的发行版（Ubuntu 22.04+ / Debian 12+ / Rocky/Alma 9+ / Alpine 3.19+ 均可） |
| Node.js | **>= 22**（`node -v` 自查；v24 也行） |
| 内存 | 单人/小队 **≥ 1 GB**；20 人房建议 **≥ 4 GB** |
| 磁盘 | 代码与依赖约 150 MB + 素材约 **1 GB**（含皮肤） |
| 端口 | 一个：默认 **3000**（HTTP 与 WebSocket 同端口）。放在反代后面时，对外只需 80/443 |
| 出口流量 | 首次开服客户端要拉素材。按每人 **~1 MB**（首屏）+ 20 人房 **~0.8 Mbps/人** 估算 |

**战斗在哪算**：默认 `SP_COMBAT=client`，各玩家浏览器算自己的战斗——服务器几乎不吃 CPU。改成 `server` 会让服务器模拟并推流，20 人房非常吃 CPU，除非你有特别理由，保持默认。

---

## 1. 装 Node.js 22

**Ubuntu / Debian**

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v      # 应输出 v22.x 或 v24.x
```

**Rocky / Alma / Fedora**

```bash
sudo dnf module reset nodejs -y
sudo dnf module enable nodejs:22 -y
sudo dnf install -y nodejs
node -v
```

**Alpine**

```bash
sudo apk add --no-cache nodejs npm
node -v      # 若低于 22，用下面的 nvm 方式
```

**任意发行版（nvm，不需要 root）**

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
. "$HOME/.nvm/nvm.sh"
nvm install 22 && nvm use 22
```

> 用 nvm 装的 Node 在 `~/.nvm/...`，systemd 单元里必须写**绝对路径**，且 `ProtectHome=yes` 会让服务读不到家目录——那种情况下把 `deploy/stronghold.service` 里的 `ProtectHome=yes` 去掉，或改用系统级安装。

---

## 2. 取代码、装依赖、准备素材

```bash
sudo mkdir -p /opt/stronghold && sudo chown "$USER" /opt/stronghold

# 从 git（推荐：以后 scripts/update-linux.sh 能一键升级）
git clone <本项目的仓库地址> /opt/stronghold

# 或者用 rsync 从你的开发机传（不含 node_modules / .git）
# rsync -a --delete --exclude node_modules --exclude .git ./ user@server:/opt/stronghold/

cd /opt/stronghold
npm ci --omit=dev        # 生产依赖（服务器上不需要 eslint/typescript/puppeteer）
node tools/vendor.mjs    # 生成 public/vendor（含素材预缓存用的 zip-native.min.js）
```

### 素材（约 1 GB）

三种取法，任选：

```bash
# A) 服务器直接下载（约 270 MB，可中断续传；国内建议开镜像）
node tools/setup.mjs --asset-source=mirror

# B) 从你的开发机/整合包 rsync 过去（最快，省一次下载）
#    需要这几样，且它们都不在 git 里：
#      public/assets/     public/fonts/     data/assets.json     data/local-assets.json
# rsync -a public/assets/ user@server:/opt/stronghold/public/assets/
# rsync -a public/fonts/  user@server:/opt/stronghold/public/fonts/
# rsync -a data/assets.json data/local-assets.json user@server:/opt/stronghold/data/

# C) 只要一部分：先跑起来，缺的图会用占位图
```

**注意**：本包里的 `public/assets` 已含 **20 人版所需的全部素材 + 271 款皮肤（172 款带 Spine 模型）**。用方式 B 时别漏 `public/assets/spine/op/**` 里皮肤那些子目录，否则皮肤在战场上会退回原皮。

`data/local-assets.json` 与 `public/assets/local/` 是**从本机游戏客户端提取的官方素材**（3D 棋盘等），公开镜像里**没有**——只能在有客户端的机器上提取，或从发布整合包复制。缺它游戏照常跑（2D 棋盘 + 替代样式）。

### 先手动跑一次

```bash
node server/index.js
# 另开一个终端：
curl -s http://127.0.0.1:3000/healthz
# 应该看到 {"ok":true,...,"app":"0.2.4",...}
```

`Ctrl+C` 停掉，接着装成服务。

---

## 3. 装成 systemd 服务

一键脚本（建用户、生成密钥、写环境文件、装单元、启动，幂等）：

```bash
sudo sh scripts/install-service-linux.sh
```

> **为什么用 `sh scripts/…` 而不是 `./scripts/…`**：从 Windows 打的 zip 解压出来的副本**没有可执行位**（zip 不存 Unix 权限），`./scripts/…` 会报 `Permission denied (os error 13)`；挂载了 `noexec` 的文件系统报同一个错。`sh scripts/…` 两种情况都能跑。想要 `./` 那种写法就先 `sudo chmod +x scripts/*.sh`（`git clone` 出来的副本本来就带可执行位；§9 有诊断命令）。

或者手动三步：

```bash
# 3.1 运行用户与可写目录
sudo useradd --system --home-dir /opt/stronghold --shell /usr/sbin/nologin stronghold
sudo mkdir -p /opt/stronghold/runtime /etc/stronghold
sudo chown -R stronghold:stronghold /opt/stronghold/runtime
sudo chmod 750 /opt/stronghold/runtime

# 3.2 密钥与环境文件
openssl rand -hex 32 | sudo tee /etc/stronghold/admin.secret >/dev/null
sudo chown root:stronghold /etc/stronghold/admin.secret && sudo chmod 640 /etc/stronghold/admin.secret
sudo cp deploy/stronghold.env.example /etc/stronghold/stronghold.env
sudo chown root:stronghold /etc/stronghold/stronghold.env && sudo chmod 640 /etc/stronghold/stronghold.env
sudo nano /etc/stronghold/stronghold.env      # 至少确认 PORT / HOST / ADMIN_SECRET_FILE

# 3.3 systemd 单元（把里面的路径与 Node 路径按实际改）
sudo cp deploy/stronghold.service /etc/systemd/system/stronghold.service
sudo nano /etc/systemd/system/stronghold.service   # WorkingDirectory / ExecStart / User
sudo systemctl daemon-reload
sudo systemctl enable --now stronghold
```

常用命令：

```bash
systemctl status stronghold
journalctl -u stronghold -f            # 实时日志
journalctl -u stronghold -n 100 --no-pager
sudo systemctl restart stronghold
```

**单元里的加固项**（`deploy/stronghold.service`）都验证过不影响本项目运行，但有两条必须知道：

- `ProtectSystem=strict` + `ReadWritePaths=/opt/stronghold/runtime /opt/stronghold/.cache`：整个文件系统只读，只有这两个目录可写。**如果你的 `SP_SERVER_SETTINGS_DIR` 或公告目录改到别处，必须把那个路径也加进 `ReadWritePaths`**，否则服务启动后写设置/公告会失败。
- **不要**打开 `MemoryDenyWriteExecute=yes`：V8 的 JIT 需要可写可执行内存，开了 Node 直接起不来。

---

## 4. 反向代理与 HTTPS

公网开服**强烈建议**放一层反代：终止 TLS、隐藏 Node 端口、限制后台来源 IP。

### nginx

```bash
sudo cp deploy/nginx-stronghold.conf /etc/nginx/sites-available/stronghold.conf
sudo cp deploy/proxy_params_stronghold.conf /etc/nginx/proxy_params_stronghold.conf
sudo nano /etc/nginx/sites-available/stronghold.conf   # 改 server_name 和 /admin 的 allow 列表
sudo ln -s /etc/nginx/sites-available/stronghold.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d game.example.com               # 自动申请并续期证书
```

配置里三个关键点（**别删**）：

1. `location /ws` 必须有 `Upgrade`/`Connection` 头 + `proxy_read_timeout 3600s`。少了任何一个，玩家会周期性掉线或一局打到一半断。
2. `/assets/` 与 `/media/` 设 `proxy_buffering off` + 长超时，否则大素材会卡在 nginx 缓冲里。
3. `gzip off`：服务端已经自己压缩并发 `Cache-Control`，nginx 再压一遍是白烧 CPU。

`HOST=127.0.0.1`（在 `stronghold.env` 里）：只让反代能连它，外网碰不到 3000 端口。

### Caddy（更省事，自动 HTTPS）

```caddyfile
game.example.com {
    @admin path /admin* /api/admin/*
    @offsite not remote_ip 203.0.113.7 10.0.0.0/8 127.0.0.1

    handle @admin {
        respond @offsite "403 Forbidden" 403
        reverse_proxy 127.0.0.1:3000
    }
    handle {
        # Caddy v2 自动处理 WebSocket 升级，不需要额外配置
        reverse_proxy 127.0.0.1:3000
    }
}
```

---

## 5. 配置项（`/etc/stronghold/stronghold.env`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `HOST` | `::` | 绑定地址。**放在反代后面就设 `127.0.0.1`**（更安全） |
| `TRUST_PROXY` | `auto` | 取真实客户端 IP：`auto` 只信 loopback/内网的转发头；`1` 永远信；`0` 从不信 |
| `ADMIN_SECRET` | 空 | 运维后台密钥（≥6 字符，少于 12 会提醒；公网建议 12+）。空 = 后台关闭，见 [ADMIN.md](ADMIN.md) |
| `ADMIN_SECRET_FILE` | 空 | 从文件读密钥（推荐，进程环境里看不到） |
| `SP_COMBAT` | `client` | `client` = 玩家浏览器算战斗（默认，服务器几乎不耗 CPU）；`server` = 服务器算并推流（20 人房很吃 CPU） |
| `SP_VERIFY` | `off` | 复算客户端上报的战斗结果：`off` / `sample`（约 1/8 抽查）/ `all`（全部，最耗 CPU） |
| `SP_MAX_AI_PER_ROOM` | 不限 | 每个房间的 AI 上限，`unlimited` 或留空 = 只受容量限制 |
| `SP_REQUIRE_ASSET_CACHE` | `optional` | `required` = 玩家必须预缓存素材才准入（弱网大房有用），见 [ASSET_CACHE.md](ASSET_CACHE.md) |
| `SP_ASSET_CACHE_TOTAL_BPS` / `SP_ASSET_CACHE_CLIENT_BPS` | 不限 | 素材在线限速（字节/秒，`unlimited`） |
| `SP_SERVER_SETTINGS_DIR` | `<项目>/runtime` | 运行期设置与公告目录（**systemd 的 ReadWritePaths 要包含它**） |
| `DEBUG` | 空 | `1` = 打开 debug 日志 |

改运行期设置（不用重启、不用改 env）：

```bash
node tools/server-settings.mjs --help
node tools/server-settings.mjs ai 4            # 每房最多 4 个 AI
node tools/server-settings.mjs precache required
```

---

## 6. 防火墙与云安全组

```bash
# Ubuntu/Debian（ufw）
sudo ufw allow 80,443/tcp
# 不放反代、直接用 3000 时：
sudo ufw allow 3000/tcp

# Rocky/Alma（firewalld）
sudo firewall-cmd --permanent --add-service=http --add-service=https
sudo firewall-cmd --reload
```

**别忘了云厂商安全组**（腾讯云/阿里云/AWS 默认一律不放行）：在控制台放行 80/443（或 3000）。

只打算自己 + 少数人玩、不想暴露公网？用 Tailscale/ZeroTier 组网，或 `cloudflared tunnel --url http://127.0.0.1:3000` 开临时隧道——见 [DEPLOY.md](DEPLOY.md) §2。

---

## 7. 磁盘与备份

**要备份的只有两样**（都在 `runtime/`，且都不在 git 里）：

| 路径 | 内容 | 丢了会怎样 |
|---|---|---|
| `runtime/announcements/` | 服务器公告正文与图片 | 公告消失（玩家存档在各自浏览器 localStorage 里，不在服务器） |
| `runtime/server-settings.json` | AI 上限 / 预缓存准入 / 素材限速 | 回到默认值 |

```bash
sudo tar czf stronghold-runtime-$(date +%F).tgz -C /opt/stronghold runtime
```

代码与素材**不需要备份**（可重新 clone/下载）；`public/assets` 建议在文件系统层面设成只读（`chmod -R a-w` 或挂载为 ro），服务端运行期不写它。

---

## 8. 升级与回滚

```bash
cd /opt/stronghold
sudo sh scripts/update-linux.sh     # git 快进 + npm ci --omit=dev + vendor + 重启 + 探活
```

脚本做的事与注意事项：

- `git merge --ff-only`：**本地有改动就拒绝**，不会覆盖你的修改。
- `npm ci --omit=dev` 会**删掉 devDependencies**（eslint/typescript/puppeteer）。想在服务器上跑 `node --test` 就改跑 `npm ci`。
- `runtime/` 不受影响（公告与设置保留）。
- 探活失败会以非零退出并提示看 `journalctl`。

**回滚**：

```bash
cd /opt/stronghold
git log --oneline -10          # 找到上一个提交
git checkout <sha>
npm ci --omit=dev && node tools/vendor.mjs
sudo systemctl restart stronghold
```

---

## 9. 排错（Linux 特有）

先跑 `sudo sh scripts/preflight-linux.sh`，它会直接指出下面大部分问题。

| 现象 | 原因与处理 |
|---|---|
| `Permission denied (os error 13)` 跑脚本时 | 脚本没有可执行位（**从 Windows 打的 zip 解压出来的副本就是 0644**），或者文件系统挂了 `noexec`。诊断：`ls -l scripts/preflight-linux.sh`（有没有 `x`）、`findmnt -no OPTIONS --target /opt/stronghold`（有没有 `noexec`）。处理：`sudo chmod +x scripts/*.sh`，或者**任何情况下都能用** `sudo sh scripts/<名字>.sh`。`git clone` 出来的副本不受影响（git 记录了 100755） |
| `EADDRINUSE` | 端口被占：`ss -ltnp \| grep 3000`。要么停掉那个进程，要么改 `PORT` |
| `EACCES` 且端口 < 1024 | 非 root 不能绑低端口。用 3000 + 反代（推荐），或给单元加 `AmbientCapabilities=CAP_NET_BIND_SERVICE` |
| 服务启动了但 `status` 立刻 failed | `journalctl -u stronghold -n 50`。常见：`ExecStart` 里 node 路径不对、`WorkingDirectory` 不存在、`User=` 无权读目录 |
| 服务在跑但写公告/设置报错 | `ProtectSystem=strict` 挡的：把 `SP_SERVER_SETTINGS_DIR` 与公告目录加进单元的 `ReadWritePaths` |
| 页面能开但一直"连接中" | `/ws` 没通。反代缺 `Upgrade`/`Connection` 头，或 `proxy_read_timeout` 太短；`preflight` 第 9 节会报 `/ws` 的返回码 |
| 玩几分钟集体掉线 | 同上，典型的 WebSocket 被反代掐断（默认 60s 超时） |
| 素材 404、画面占位 | `public/assets` 没传全 / 权限不对：`sudo -u stronghold test -r /opt/stronghold/public/assets/spine/op` 自查；`preflight` 第 4 节会报文件数 |
| 皮肤在战场上不换模型 | `public/assets/spine/op/<干员>/<皮肤>/` 那批目录没传上来（少了会退回原皮，但头像仍会换） |
| 内存涨到被 OOM Kill | 20 人房 + `SP_COMBAT=server` 会非常吃内存。改回 `client`；或加 swap、限制人数 |
| 日志时间不对 | 服务器时区：`timedatectl set-timezone Asia/Shanghai` |
| 20 人房卡顿/延迟高 | 见 [DEPLOY-QUICKSTART.md](DEPLOY-QUICKSTART.md) §20 人房间怎么开 的性能提醒；先看后台的 CPU/连接数，再逐步加人 |

---

## 10. 上线自检（必做）

```bash
cd /opt/stronghold
sudo sh scripts/preflight-linux.sh
```

十项：系统信息 → Node 与依赖 → `public/vendor` → 数据与素材 → `runtime` 可写 → 后台密钥（长度与文件权限）→ systemd 单元（含 `systemd-analyze verify`）→ 端口与防火墙 → HTTP 探活（`/healthz`、`/admin`、`/ws` 握手）→ 结论。退出码 0 = 通过（可能有警告），1 = 有失败项。

---

## 11. Docker 路线

`Dockerfile` 已就绪（多阶段、非 root 运行、带 `HEALTHCHECK`）：

```bash
docker build -t stronghold .                      # 不含素材
docker run -d --name stronghold -p 3000:3000 \
  -e ADMIN_SECRET="$(openssl rand -hex 32)" \
  -v "$PWD/public/assets:/app/public/assets:ro" \
  -v "$PWD/runtime:/app/runtime" \
  --restart unless-stopped stronghold

docker logs -f stronghold
curl -s http://127.0.0.1:3000/healthz
```

或 `--build-arg FETCH_ASSETS=1` 把素材打进镜像（构建时联网约 250 MB）。

容器里要记住：`HOST=0.0.0.0`（Dockerfile 已设）、`runtime` 必须是**可写**卷、`public/assets` 用只读卷。

---

## 12. 相关文档

- [DEPLOY-QUICKSTART.md](DEPLOY-QUICKSTART.md) — 三条路线的最短路径 + 开服检查清单
- [DEPLOY.md](DEPLOY.md) — Windows 小主机、内网穿透、Docker、素材提取、通用排错
- [ADMIN.md](ADMIN.md) — 运维后台（启用、端点、维护模式、安全建议）
- [ANNOUNCEMENTS.md](ANNOUNCEMENTS.md) — 服务器公告与紧急通知的 CLI
- [ASSET_CACHE.md](ASSET_CACHE.md) — 素材预缓存（弱网/大房间）
- [PLAYER_CAPACITY.md](PLAYER_CAPACITY.md) — 4/8/10/16/20 人、卡池分组、联防轮数
- [SKINS.md](SKINS.md) — 干员皮肤（本版本新增）
