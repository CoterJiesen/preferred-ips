# Preferred IP Provider Worker

为 v2board 等面板提供"优选域名/IP 列表"接口，自带管理页。与混淆版 CFnew 完全解耦（CFnew 只当代理，不动它）。

## 功能

- **`GET /api/ips?key=xxx`** — 合并输出 内置优选域名(20+) + 手动维护 + wetest 拉取 + GitHub 拉取，JSON `{success,count,data:[{ip,port,name}]}`
- **`GET /`** — 管理页（登录后维护拉取地址 / 手动增删IP / 刷新）
- **`POST /api/admin`** — 管理动作（增删、设源、刷新），需 key
- 安全：所有接口需 `AUTH_KEY`（部署时 `wrangler secret put AUTH_KEY`），可用 `?key=` 或 `Authorization: Bearer` 传递
- 拉取缓存 15 分钟（KV），接口不可用时 v2board 自动回退原节点

## 部署

```bash
npm i -g wrangler
wrangler login

# 1. 创建 KV 命名空间，把返回的 id 填进 wrangler.toml
wrangler kv:namespace create PREFERRED_IPS

# 2. 设置登录密钥
wrangler secret put AUTH_KEY

# 3. 部署
wrangler deploy
```

## 验证

```bash
# 接口（应返回内置优选域名等，count>0）
curl "https://preferred-ips.你的子域.workers.dev/api/ips?key=你的KEY"

# 管理页
打开 https://preferred-ips.你的子域.workers.dev/ 用 AUTH_KEY 登录
```

## v2board 接入

```bash
php artisan v2board:preferred-ip --url='https://preferred-ips.你的子域.workers.dev/api/ips?key=你的KEY'
php artisan v2board:preferred-ip --show   # 确认 URL 生效
```

然后给要展开的 v2board 节点 tags 加 `优选`，订阅时自动追加该节点的优选IP克隆节点。

## 文件

- `worker.js` — 单文件 Worker（接口 + 管理页 + 拉取/解析逻辑）
- `wrangler.toml` — 部署配置（KV 绑定）
