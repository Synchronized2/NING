# NING 微信小程序 3.4.3

一个连接兼容模型服务的微信小程序客户端。用户自行配置服务 URL、API Key 和模型；模型列表、对话、生图和 TTS 均可通过微信云函数中转，无需部署云托管服务。

## 功能

- 多套模型服务档案；每个档案可让对话与生图共用连接，也可分别保存两组 URL、Key 和模型列表
- `GET /models` 拉取模型列表，并分类对话和生图模型
- `POST /chat/completions` 多轮对话，直连模式支持 SSE，云开发模式兼容普通 JSON
- 多会话历史、搜索、重命名、删除、继续对话和自动标题
- 编辑问题后重发、重新生成、停止、复制和错误重试
- 图片上传与视觉问答；云开发模式会先上传到云存储再安全转发
- `POST /images/generations` 生图，支持尺寸、质量、风格和提示词模板；直连最长等待 10 分钟，云中转受微信云函数 60 秒上限限制
- 支持 `b64_json` 与 HTTPS 图片结果，云中转会将结果写入云存储
- 对话模型可通过 `generate_image` 工具自动触发生图
- Token、图片和自定义单价费用统计，数据仅保存在本机
- Edge TTS 手动朗读与自动朗读，可动态拉取全部在线人声并设置语速、音量和音调
- 原生 Canvas/WebGL Live2D 互动形象，支持眨眼、呼吸、视线跟随、触摸动作、思考/回答状态和 TTS 口型
- 互动形象开启时自动按句朗读，最多三路并发合成并按顺序播放；人物右上方等待时显示问题，朗读时切换为当前回答，完整问答仍保存在会话历史中
- 互动模式可切换全身/半身、文字输入和麦克风对话；WebRTC VAD 本地判断说话结束，WAV 上传识别后沿用现有模型对话
- API 错误脱敏；云函数具备 HTTPS 限制、DNS 固定、重定向限制和 SSRF 防护

## 从 2.0 升级

已有 URL、API Key、模型和单会话记录会自动迁移到 2.2 数据结构。升级不会主动删除旧版本地数据。

2.2 更新了 `openaiProxy` 并增加了依赖。必须在微信开发者工具中重新执行：

1. 右键 `cloudfunctions/openaiProxy`。
2. 选择“上传并部署：云端安装依赖”。
3. 将云函数超时设置为平台允许的 `60` 秒，内存建议至少 512 MB。该函数负责模型列表、对话、视觉问答、生图和 Edge TTS。

如果只上传小程序代码而未重新部署云函数，视觉问答、生图和 Edge TTS 可能仍使用旧逻辑或不可用。云中转生图无法突破微信云函数 60 秒平台上限；超过该时限的节点应关闭中转并使用直连模式。

## 使用

1. 使用微信开发者工具导入本目录，并开通或选择云开发环境。
2. 上传并部署 `openaiProxy` 云函数，选择“云端安装依赖”。不需要部署云托管服务。
3. 打开首页右上角设置，填写 HTTPS 服务 URL 和 API Key；如果对话和生图来自不同供应商，开启“使用不同服务”并分别填写。
4. 获取对应服务的模型列表，选择或填写对话和生图模型。
5. 如需费用估算，填写当前服务实际单价；未填写时只统计 Token 和次数。
6. 在 Edge TTS 区域点击“刷新全部 Edge TTS 人声”，选择人声并保存。

服务 URL 可以填写域名、`/v1`，也可以填写到 `/chat/completions`、`/models` 或 `/images/generations`；客户端会自动还原基础路径。

## 域名与流式限制

默认云开发模式下，模型列表、对话、生图和 Edge TTS 都通过 `wx.cloud.callFunction` 访问 `openaiProxy`。模型 API、返回图片和 Edge TTS 域名都不需要加入小程序合法域名，但生图必须在云函数 60 秒执行上限内完成。

直连模式受微信平台限制：

- 模型服务加入 `request` 合法域名。
- 远程图片需要加入 `downloadFile` 合法域名。
- 互动语音需要将 `https://tools.yeyupiaoling.cn` 加入 `uploadFile` 合法域名，并允许麦克风权限；仅录音结束后的 WAV 上传该第三方 ASR 服务。

云函数调用不是流式通道，因此云开发模式按完整回答返回。需要逐 Token SSE 时使用直连模式；直连模式已通过 `enableChunked` 实时处理上游 SSE。

## 数据与隐私

- API Key 和服务档案保存在微信本地 Storage，不写入云数据库的档案数据。
- 对话和生图请求只在当前调用期间将 Key 临时传给云函数，不写入云数据库。
- 最多保存 20 个服务档案、50 个会话，每个会话最多 80 条界面消息。
- 视觉问答图片会写入云存储，最多 10 MB；建议在云控制台配置生命周期自动清理。
- 生图结果最大 20 MB，并写入当前用户隔离路径。
- TTS 临时音频播放结束后由客户端删除。
- 互动语音录音只在点击麦克风后开始；WebRTC VAD 在本地处理 PCM，录音结束后临时 WAV 发往 `tools.yeyupiaoling.cn` 做识别，识别或取消后删除本地文件。该接口为第三方非官方服务，可能变更或不可用。
- Edge TTS 使用 Microsoft Edge Read Aloud 的非官方公共接口，不需要 Key，但协议或可用性可能变化，不应作为强 SLA 服务。
- 用量与费用为本地统计；费用仅按用户填写单价估算，实际账单以上游服务为准。

## 项目结构

- `miniprogram/pages/index`：对话、生图、多模态输入和朗读
- `miniprogram/pages/history`：多会话管理
- `miniprogram/pages/settings`：服务档案、模型、价格和 TTS 设置
- `miniprogram/components/live2d-avatar`：小程序原生 WebGL 渲染、互动与生命周期管理
- `miniprogram/assets/live2d/hiyori`：桃濑日和 PRO 模型、移动端纹理及原始授权说明
- `miniprogram/vendor/live2d`：Live2D Cubism Core 运行库
- `miniprogram/utils/openai.js`：兼容模型协议、媒体上传、SSE 与 Edge TTS 客户端调用
- `miniprogram/utils/voice.js`：WebRTC VAD、PCM 语句收集、WAV 封装与第三方语音识别
- `miniprogram/utils/storage.js`：2.0 数据迁移、多会话、服务档案和用量
- `cloudfunctions/openaiProxy`：模型、对话、生图、媒体处理与 Edge TTS 安全中转
- `cloudrun/image-service`：已停用的异步生图方案，仅保留为历史参考，不参与小程序运行
- `tests`：协议、页面绑定、安全和存储迁移测试

Live2D 人物全部在本地渲染，不上传用户数据，也不依赖云函数或模型服务。人物素材和 Cubism Core 适用各自授权，详见 `THIRD_PARTY_NOTICES.md`。

模型二进制原件保存在 `assets/live2d`，小程序通过 `model-data.js` 模块加载，不使用文件系统读取包内 `.moc3`。更换模型原件后执行 `node scripts/build-live2d-model.js` 重新生成模块；生成文件必须随小程序一起上传。

## 测试

```powershell
npm test
```

视觉回归脚本需要 Playwright，参数为本机 Playwright 模块路径：

```powershell
node scripts/verify-live2d.js <playwright-module-path>
```
