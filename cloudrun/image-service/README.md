# openaiq-image 云托管服务

该服务只处理可能超过微信云函数 60 秒上限的生图任务。模型列表、正常对话、视觉问答和 Edge TTS 仍由 `openaiProxy` 云函数处理。

## 部署要求

1. 在当前小程序关联的微信云托管（`wxrun`）环境创建服务，服务名必须为 `openaiq-image`。它可以和承载云函数、数据库的传统云开发环境使用不同的环境 ID。
2. 使用本目录创建云托管版本，监听端口设置为 `80`。
3. 在云开发控制台进入“环境配置 / API Key 管理”，为当前环境创建服务端 API Key。
4. 配置环境变量 `CLOUDBASE_APIKEY`，值为上一步创建的服务端 API Key。容器型云托管不会自动注入腾讯云密钥，Node SDK 使用该环境级凭证访问云数据库和云存储。
5. 配置环境变量 `TASK_ENCRYPTION_KEY`，值为至少 32 个字符的随机密钥。不得把这两个值提交到代码仓库。
6. 将最小实例数设置为 `1`，建议规格至少 1 核 CPU、1 GB 内存；否则缩容到零后，排队任务要等下一次实例启动才能继续。
7. 任务集合默认为 `openaiq_image_tasks`，服务首次启动会尝试创建。将该集合的客户端安全规则设置为不可直接读写，所有访问均通过云托管接口并按 `X-WX-OPENID` 隔离。
8. 创建版本后分配 100% 流量，再用小程序发起生图测试。

使用 JSON 模式配置环境变量时，格式如下：

```json
{
  "CLOUDBASE_APIKEY": "在当前环境创建的服务端 API Key",
  "TASK_ENCRYPTION_KEY": "至少 32 个字符的随机字符串"
}
```

可选环境变量：

- `CLOUDBASE_ENV_ID`：云环境 ID，默认使用本项目的 `cloudbase-d2gg15kzjf02a74ab`；部署到其他环境时必须覆盖。
- `IMAGE_TASK_COLLECTION`：任务集合名称，默认 `openaiq_image_tasks`。
- `IMAGE_WORKER_CONCURRENCY`：单实例并发生图数，默认 `2`，范围 `1-4`。

## 接口

- `POST /image/tasks`：校验并加密任务参数，立即返回 `202` 和 `taskId`。
- `GET /image/tasks/:taskId`：返回当前用户自己的任务状态。
- `DELETE /image/tasks/:taskId`：取消排队或执行中的任务。
- `GET /health`：容器健康检查。

任务状态依次为 `queued`、`running`、`succeeded`；失败和取消分别为 `failed`、`canceled`。上游生图请求最长等待 600 秒，小程序通过短轮询查询结果，因此不受同步云函数 60 秒限制。

API Key 仅在任务执行期间以 AES-256-GCM 密文暂存，任务成功、失败、取消或过期后立即从任务记录清除。过期任务记录会自动清理，生成图片仍保留在用户隔离的云存储目录中。
