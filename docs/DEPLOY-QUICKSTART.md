# 部署教程（从零到开服）

三条路线，按你的场景挑一条走完即可。每条都能在 10 分钟内跑起来。

| 你的场景 | 走哪条 | 详细文档 |
|---|---|---|
| 自己电脑 + 同局域网的朋友 | [路线 A：Windows 开箱即用](#路线-awindows-局域网) | [DEPLOY.md](DEPLOY.md) §1 |
| 一台 Linux 云服务器，公网/域名访问 | [路线 B：Linux 服务器](#路线-blinux-服务器公网) | [DEPLOY-LINUX.md](DEPLOY-LINUX.md) |
| 想用容器/编排 | [路线 C：Docker](#路线-cdocker) | [DEPLOY.md](DEPLOY.md) §3 |

无论哪条，装完请做一遍 [开服检查清单](#开服检查清单)。

---

## 同一份代码，Windows 和 Linux 都能跑

**代码、素材、玩法、测试完全一样**，只有"怎么把它挂成常驻服务"和"防火墙/反代怎么配"按平台不同。两边都需要 **Node.js ≥ 22**。

| 事项 | Windows | Linux |
|---|---|---|
| 常驻服务 | 计划任务「StrongholdProtocol」（SYSTEM，开机自启）<br>`powershell -ExecutionPolicy Bypass -File scripts\install-service-windows.ps1` | systemd `stronghold.service`（含加固）<br>`sudo sh scripts/install-service-linux.sh` |
| 服务配置 | `scripts\service.env.cmd`（NODE_EXE / PORT / HOST / SP_COMBAT / ADMIN_SECRET_FILE） | `/etc/stronghold/stronghold.env` |
| **上线自检** | `powershell -ExecutionPolicy Bypass -File scripts\preflight-windows.ps1` | `sudo sh scripts/preflight-linux.sh` |
| 防火墙 | 安装脚本自动加 `netsh advfirewall` 规则 | `ufw allow 3000/tcp` / `firewall-cmd` |
| 反向代理 | 可选（Caddy for Windows / IIS / nginx） | `deploy/nginx-stronghold.conf`、Caddyfile 示例 |
| 日志 | `logs\server.log`（计划任务模式）或控制台 | `journalctl -u stronghold -f` |
| 后台密钥 | `runtime\admin.secret` + `service.env.cmd` 里的 `ADMIN_SECRET_FILE`（首次启动会问你要不要设，见 [ADMIN.md](ADMIN.md) §2） | `/etc/stronghold/admin.secret` + `ADMIN_SECRET_FILE` |
| 一键更新 | `scripts\install-service-windows.ps1 -Restart` | `sudo sh scripts/update-linux.sh` |
| 开发/手动跑 | `npm start`（两边一样） | `npm start`（两边一样） |

### 平台相关的真实差异（照实写，不是"完全一样"）

1. **自动带宽保护只在 Linux 生效。** `server/bandwidthEmergency.js` 靠读 `/proc/net/dev` 采样出口流量，非 Linux 平台 `supported=false`，所以**自动触发**不会发生。**手动「维护模式」两个平台都能用**——它不依赖采样（后台里的开关，见 [ADMIN.md](ADMIN.md)）。
2. **负载均值在 Windows 上是 `n/a`**：`os.loadavg()` 在 Windows 恒返回 0，后台概览显示 `n/a` 而不是假的 0（代码里已区分）。
3. **文件系统大小写**：Linux 区分大小写，Windows 不区分。素材 URL 在代码里都是固定小写常量；从 Windows 往 Linux 拷文件时别改大小写。
4. **行尾**：`.gitattributes` 已规定（`*.sh` LF、`*.bat/*.cmd/*.ps1` CRLF）。跨平台搬文件用 `git` 或 `rsync`，不要用会重写行尾的工具，否则 Linux 上会报 `bad interpreter: /bin/sh^M`。
5. **权限**：Linux 上用 systemd 跑时 `runtime/` 必须对服务用户可写（`install-service-linux.sh` 会设好）；Windows 上计划任务以 SYSTEM 运行，一般不会遇到权限问题。

---

## 这个包是什么

《明日方舟》「卫戍协议：盟约」的**玩家自制复刻**，浏览器即玩。这一个版本 = 上游 **v0.2.4** + LongQianChen 的 **20 人容量分支** + **干员皮肤**（271 款）。

- **服务端**：一个 Node.js 进程（`server/index.js`），只管经济、回合、房间；战斗在各玩家的浏览器里算。
- **客户端**：同一进程提供的静态页面（`public/`），浏览器打开就能玩。
- **运维后台**：`/admin`，默认关闭，配了密钥才开，见 [ADMIN.md](ADMIN.md)。
- 端口默认 **3000**；**不是**先开 3000 再开别的，就一个端口（HTTP + WebSocket 同端口）。

**先记住两句**：

1. 玩家连的是 `http://<服务器地址>:3000`，不是 `localhost`。
2. 打不开九成是防火墙（Windows 弹窗 / Linux ufw / 云厂商安全组）。

---

## 路线 A：Windows 局域网

适合：家里一台机器开服，朋友都在同一个 Wi-Fi。

1. 装 **Node.js 22 或 24**（LTS）：<https://nodejs.org/zh-cn/download>，一路下一步。
2. 在这个目录里开 PowerShell：

   ```powershell
   npm ci --omit=dev      # 装运行依赖
   node tools/vendor.mjs  # 生成 public/vendor（客户端库）
   node tools/setup.mjs   # 下载素材（约 270 MB，可中断续传）
   npm start              # 开服，控制台会打印局域网地址
   ```

3. 浏览器打开 `http://localhost:3000`，输入代号，进大厅。
4. 记下控制台打印的 `LAN: http://192.168.x.x:3000`，把它发给朋友。
5. 第一次会弹 Windows 防火墙，勾**专用网络**并允许。

> 不想装 Node、想让朋友也能开服？用发布整合包：解压后双击 `启动游戏.bat`（包内自带便携版 Node，素材也在里面）。

---

## 路线 B：Linux 服务器（公网）

适合：一台云服务器，域名/公网 IP 给别人玩。**完整版见 [DEPLOY-LINUX.md](DEPLOY-LINUX.md)**，这里是最短路径（Ubuntu/Debian，root 或 sudo）：

```bash
# 1) Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2) 取代码并装依赖
sudo mkdir -p /opt/stronghold && sudo chown "$USER" /opt/stronghold
git clone <本项目的地址> /opt/stronghold     # 或用 rsync/scp 把这份目录传上去
cd /opt/stronghold
npm ci --omit=dev && node tools/vendor.mjs

# 3) 素材：服务器上下载（约 270 MB，建议开镜像）
node tools/setup.mjs --asset-source=mirror
#    更快的办法：把 Windows 机器上的 public/assets、public/fonts、
#    data/assets.json、data/local-assets.json 用 rsync 传上来（省一次 270 MB 下载）

# 4) 装成 systemd 服务（自动建用户、生成 ADMIN_SECRET、装上并启动）
sudo sh scripts/install-service-linux.sh

# 5) 自检：把能查的都查一遍（Node、依赖、vendor、素材、密钥、单元、端口、防火墙、HTTP/WS）
sudo sh scripts/preflight-linux.sh

# 6) 反向代理 + HTTPS（推荐）
sudo cp deploy/nginx-stronghold.conf /etc/nginx/sites-available/stronghold.conf
#    改掉里面的 server_name 和运维 IP，然后：
sudo ln -s /etc/nginx/sites-available/stronghold.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d game.example.com
```

开服后：

- 玩家地址：`https://game.example.com`
- 运维后台：`https://game.example.com/admin`，密钥在 `/etc/stronghold/admin.secret`
- 日志：`journalctl -u stronghold -f`

> **云厂商安全组**别忘了放行 80/443（只用 3000 的话放行 3000）。腾讯云/阿里云默认都不放。

---

## 路线 C：Docker

```bash
# 构建时不下载素材（推荐：镜像小，素材挂载进去）
docker build -t stronghold .
docker run -d --name stronghold \
  -p 3000:3000 \
  -e ADMIN_SECRET="$(openssl rand -hex 32)" \
  -v "$PWD/public/assets:/app/public/assets:ro" \
  -v "$PWD/runtime:/app/runtime" \
  --restart unless-stopped \
  stronghold

# 想连素材一起打进镜像（构建时要联网，约 250 MB）
docker build -t stronghold --build-arg FETCH_ASSETS=1 .
```

要点：

- `public/assets` 用**只读**卷挂进去；`runtime` 必须**可写**（公告与 server-settings 落这里）。
- `ADMIN_SECRET` 用 `-e` 传，或 `-e ADMIN_SECRET_FILE=/run/secrets/...`（Docker secrets 的路径）。
- 容器里 `HOST` 必须是 `0.0.0.0`（Dockerfile 已设）。

---

## 开服检查清单

按顺序点一遍，出问题能立刻定位：

1. **服务端活着**：`curl -s http://127.0.0.1:3000/healthz` → 返回 JSON，里面有 `"app":"0.2.4"`。
2. **页面能开**：浏览器访问服务器地址 → 出现标题页，能输入代号。
3. **能进大厅**：输代号后看到「模拟方式」和「干员调配」。
4. **能建房**：选「同盟模拟」，建房时**人数选 20**，把 4 位房间密钥发给朋友。
5. **皮肤在**：点「干员调配」→ 选一个干员 → 面板里出现**皮肤**区块，能选中、能标记「已装备」。想确认**战场模型**也换了，选一个带模型的干员（隐现 / 澄闪 / 维娜…）：区块顶部写「{n} 款可选 · **{k} 款含战斗模型**」。带「**仅头像**」角标的皮肤只有头像，棋盘和作战仍用原干员模型（全头像的干员如浊心斯卡蒂 / 陈 / 煌，`k` 就是 0）——素材集里没有它们的模型，详见 [SKINS.md](SKINS.md) §8。
6. **朋友能进**：朋友用你发的地址打开（不是 `localhost`），输密钥进同一个房间。
7. **后台（可选）**：`/admin` → 用密钥登录 → 能看到在线连接、房间、实时日志。

---

## 20 人房间怎么开

1. 房主建房时把**人数**选到 20（可选 4 / 8 / 10 / 16 / 20，默认 8）。
2. 位置可以随便坐；开局前房主还能改人数（要先把高于目标人数的座位腾空）。
3. 开局后卡池按**固定组**分：6 人起 3/4/5 人一组（20 人 = 5 组 × 4 人），每组一个独立卡池，客户端用 **A–E 彩色角标**标出你和谁一组。
4. 策略轮选和机变是**每组各自并行**的，组间不互相等；每人自己的计时（策略 50 秒，机变本组首轮 30 秒、后续 16 秒）。
5. 联防轮数上限 = 固定组数（20 人最多 5 轮），每轮可以投票「跳过后续全部联防」（门槛是过半数真人）。
6. 空位不参与人数计算：4 个人进 20 人房，就是按 4 人开局。

**性能提醒**（来自该分支作者的记录）：20 人同房的真实网络与设备开销**没有做过真机压测**；已知的验证是 2 个真实 WebSocket + 18 个 AI。如果你要开 20 人公网房，建议：

- 用 `SP_VERIFY=off`（默认）别开 `all`；
- 服务器上行带宽按 **每人 ~0.8 Mbps** 估；反代那层务必别缓冲大响应（nginx 配置里已处理）；
- 先在后台看 CPU/内存/连接数，再逐步加人。

---

## 出问题先做这两件事

```bash
node tools/doctor.mjs              # 跨平台体检：Node 版本、依赖、素材、端口、防火墙、局域网地址
sudo sh scripts/preflight-linux.sh # Linux 专用上线自检（含 systemd 单元、密钥权限、HTTP/WS 探活）
```

> Linux 上脚本用 `sh scripts/…` 调用：**从 Windows 打的 zip 解压出来没有可执行位**，`./scripts/…` 会报 `Permission denied (os error 13)`。想用 `./` 就先 `sudo chmod +x scripts/*.sh`。

排错表格见 [DEPLOY.md](DEPLOY.md) §5（通用）与 [DEPLOY-LINUX.md](DEPLOY-LINUX.md) §9（Linux 特有）。

---

## 想改东西的话

| 想改什么 | 改哪里 |
|---|---|
| 端口、绑定地址、AI 上限、素材限速 | `/etc/stronghold/stronghold.env`（或环境变量），见 [DEPLOY-LINUX.md](DEPLOY-LINUX.md) §5 |
| 服务器公告（游戏内弹窗） | `node tools/announcements.mjs …`，见 [ANNOUNCEMENTS.md](ANNOUNCEMENTS.md) |
| AI 上限 / 预缓存准入 / 素材限速 | `node tools/server-settings.mjs …`（运行期写入，不用重启） |
| 玩家容量、卡池分组规则 | `shared/playerCapacity.js` + [PLAYER_CAPACITY.md](PLAYER_CAPACITY.md) |
| 皮肤目录 | `data/skins.json` + `data/assets.json`，见 [SKINS.md](SKINS.md) |
| 运维后台 | `server/admin.js` + `public/admin/`，见 [ADMIN.md](ADMIN.md) |
