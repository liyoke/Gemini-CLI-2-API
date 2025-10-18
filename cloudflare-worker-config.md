# Cloudflare Worker API 代理配置

## 功能概述

这个 Cloudflare Worker 支持多个 API 端点的代理转发，包括：

1. **Gemini Cloud Code API** - `https://cloudcode-pa.googleapis.com`
2. **Google Cloud Platform API** - `https://www.googleapis.com` (支持 cloud-platform scope)
3. **自动OAuth Token刷新** - 检测token过期并自动刷新
4. **请求重试机制** - 401错误时自动重试
5. **Token存储管理** - 支持KV存储或环境变量
6. **错误处理** - 完善的错误恢复机制

## 路由配置

### Gemini Cloud Code 路由
- `/v1internal:generateContent` → `https://cloudcode-pa.googleapis.com/v1internal:generateContent`
- `/v1internal:streamGenerateContent` → `https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent`
- `/v1internal/*` → `https://cloudcode-pa.googleapis.com/v1internal/*`

### Google Cloud Platform 路由
- `/gcp/*` → `https://www.googleapis.com/*`
- `/googleapis/*` → `https://www.googleapis.com/*`
- `/oauth2/v4/*` → `https://www.googleapis.com/oauth2/v4/*`
- `/auth/*` → `https://www.googleapis.com/auth/*`

### 默认路由
- 所有其他路径 → `https://cloudcode-pa.googleapis.com`

## 使用示例

### 调用 Gemini Cloud Code API
```bash
# 原始地址
https://cloudcode-pa.googleapis.com/v1internal:generateContent

# 通过 Worker 代理
https://your-worker.your-subdomain.workers.dev/v1internal:generateContent
```

### 调用 Google Cloud Platform API
```bash
# 原始地址
https://www.googleapis.com/oauth2/v4/token

# 通过 Worker 代理
https://your-worker.your-subdomain.workers.dev/oauth2/v4/token

# 或使用 /gcp 前缀
https://your-worker.your-subdomain.workers.dev/gcp/oauth2/v4/token
```

### 调用其他 Google APIs
```bash
# 原始地址
https://www.googleapis.com/auth/cloud-platform

# 通过 Worker 代理
https://your-worker.your-subdomain.workers.dev/auth/cloud-platform
```

## 部署配置

### 1. 环境变量配置

在Cloudflare Dashboard中设置以下环境变量：

#### 必需的环境变量

```bash
# OAuth客户端配置
OAUTH_CLIENT_ID=681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com
OAUTH_CLIENT_SECRET=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

# 或者直接提供token（可选，用于初始设置）
GEMINI_ACCESS_TOKEN=ya29.access_token_here
GEMINI_REFRESH_TOKEN=refresh_token_here
GEMINI_TOKEN_EXPIRY=1234567890
```

#### KV存储配置（推荐）

1. 在Cloudflare Dashboard中创建KV命名空间
2. 绑定到Worker，变量名为 `TOKEN_STORE`
3. KV存储会自动管理token的生命周期

### 2. wrangler.toml 配置

```toml
name = "gemini-proxy-worker"
main = "cloudflare-worker-enhanced.js"
compatibility_date = "2023-10-30"

[env.production.vars]
OAUTH_CLIENT_ID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com"
OAUTH_CLIENT_SECRET = "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"

# KV存储绑定
[[env.production.kv_namespaces]]
binding = "TOKEN_STORE"
id = "your-kv-namespace-id"
preview_id = "your-preview-kv-namespace-id"
```

### 3. 定时任务配置（可选）

添加定时任务来定期验证token：

```toml
[[env.production.triggers]]
crons = ["0 */6 * * *"]  # 每6小时执行一次
```

## 初始Token设置

### 方法1：使用环境变量（快速开始）

1. 获取OAuth token：
   ```bash
   # 使用gcloud或OAuth Playground获取token
   ```

2. 在Cloudflare Dashboard中设置环境变量：
   - `GEMINI_ACCESS_TOKEN`: access token
   - `GEMINI_REFRESH_TOKEN`: refresh token
   - `GEMINI_TOKEN_EXPIRY`: token过期时间戳（毫秒）

### 方法2：使用API初始化（推荐）

1. 部署Worker后，发送初始化请求：
   ```bash
   curl -X POST "https://your-worker.workers.dev/init-token" \
     -H "Content-Type: application/json" \
     -d '{
       "access_token": "your_access_token",
       "refresh_token": "your_refresh_token",
       "expires_in": 3600
     }'
   ```

### 方法3：手动设置KV存储

1. 在Cloudflare Dashboard中找到KV命名空间
2. 添加键值对：
   - Key: `gemini_oauth_token`
   - Value: JSON格式的token数据

## 使用方法

### API调用

```bash
curl -X POST "https://your-worker.workers.dev/v1internal:generateContent" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer any_value" \
  -d '{
    "model": "gemini-2.5-flash",
    "contents": [{"role": "user", "parts": [{"text": "Hello"}]}]
  }'
```

注意：Authorization头的值会被忽略，因为Worker会自动管理token。

### 监控和调试

1. 查看Worker日志：
   ```bash
   wrangler tail
   ```

2. 检查token状态：
   ```bash
   curl "https://your-worker.workers.dev/token-status"
   ```

## 故障排除

### 常见问题

1. **Token刷新失败**
   - 检查refresh_token是否有效
   - 确认OAuth客户端配置正确
   - 查看Worker日志获取详细错误信息

2. **KV存储问题**
   - 确认KV命名空间绑定正确
   - 检查KV存储权限设置

3. **网络问题**
   - Worker会自动重试网络错误
   - 检查目标API的可访问性

### 日志分析

关键日志信息：

- `Token is still valid` - Token无需刷新
- `Token expired or missing, refreshing...` - 正在刷新token
- `Token refreshed successfully` - Token刷新成功
- `Received 401, attempting token refresh and retry...` - 自动重试中
- `Retrying request` - 网络重试中

## 安全注意事项

1. **环境变量安全**
   - 不要在代码中硬编码敏感信息
   - 使用Cloudflare的环境变量功能
   - 定期轮换client secret

2. **Token管理**
   - 使用HTTPS进行所有通信
   - 定期检查token使用情况
   - 实现适当的访问控制

3. **KV存储安全**
   - 限制KV存储的访问权限
   - 定期清理过期的token数据

## 性能优化

1. **缓存策略**
   - Token会在KV中缓存，减少刷新频率
   - 5分钟缓冲期避免频繁刷新

2. **重试机制**
   - 指数退避策略避免请求风暴
   - 最大重试次数限制防止无限循环

3. **监控告警**
   - 设置token刷新失败告警
   - 监控API响应时间和成功率

## 扩展功能

可以进一步扩展的功能：

1. **多租户支持**
2. **Token使用统计**
3. **更细粒度的访问控制**
4. **API使用配额管理**