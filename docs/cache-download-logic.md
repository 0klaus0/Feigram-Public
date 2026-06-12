# Feigram 缓存与下载逻辑

## 两套任务

- 用户主动下载：用户在聊天消息中点击缓存/下载后进入下载列表。
- 群后台缓存：用户在群组信息页勾选后台自动缓存后，自动缓存该群大于 100MB 的视频，不进入下载列表。

## 用户主动下载

- 入口：`POST /api/media/:account/:peer/:messageId/cache`
- 任务表：内存 `downloadTasks`，落盘到 `download-tasks.json`
- 任务 id：按用户、Telegram 账号、会话、消息 id 生成
- 下载方式：GramJS `client.downloadMedia`
- 临时文件：`*.part`
- 完成后：移动为正式缓存文件，下载列表状态变为 `completed`
- 失败重试：网络、超时、连接类错误最多自动重试 3 次
- 播放：完成后优先从本地缓存文件播放
- 清除列表：只移除列表记录
- 删除缓存：移除记录并删除本地缓存文件

## 群后台缓存

- 入口：群组信息页勾选后台自动缓存后调用 `POST /api/chats/:account/:peer/cache-large-videos`
- 任务表：内存 `silentCacheRecords`，落盘到 `silent-cache-tasks.json`
- 任务 id：按用户、Telegram 账号、会话、消息 id 生成
- 自动缓存范围：只缓存大于 100MB 的视频
- 排重规则：优先按 `用户 + Telegram 账号 + 会话 + 文件名 + 文件大小` 排重
- 临时文件：`*.silent.part`
- 完成后：移动为正式缓存文件，状态变为 `completed`
- 列表展示：管理员后台「缓存信息」页显示标题、进度、速度、状态
- document 视频使用可续传下载，重试时保留 `*.silent.part`

## 群后台缓存开关

- 开启：`enabled=true`
- 暂停：`enabled=false`
- 暂停时：运行中和排队中的群后台缓存任务会变为 `paused`
- 重新开启时：`paused` 和 `error` 任务会重新进入队列
- 如果任务正在退出：会标记为重新排队，旧任务退出后自动回到队列

## 并发数量

- 配置字段：`concurrency`
- 当前范围：最少 1，最多 10
- 前端选项：1、2、3、4、5、10
- 服务端强制保护：所有传入值都会被限制在 1-10
- 调度规则：`silentCacheActive < concurrency` 时继续从队列取任务
- 降低并发：多余运行任务会暂停并重新排队
- 提高并发：会立即尝试从队列补充任务

## 最大缓存速率

- 配置字段：`rateLimitBps`
- `0` 表示不限速
- 非 0 表示所有群后台缓存任务共享一个总速率限制
- 例如：设置 5MB/s、并发 5，不是每个任务 5MB/s，而是 5 个任务合计约 5MB/s
- 调整速率时会重置限速窗口，避免旧进度导致长时间低速

## 限速实现

- 核心函数：`throttleSilentCache(deltaBytes)`
- 所有后台缓存任务共享 `silentRateChain`
- 每次进度回调计算新增字节数 `deltaBytes`
- 根据总限速计算理论耗时，下载过快时 sleep
- 不限速时直接跳过 sleep

## 下载分片

- 后台缓存 document 文件时：直接调用 Telegram `upload.getFile` 顺序分片，从 `*.silent.part` 当前大小继续写入
- 分片大小：Telegram 单次请求最大 512KB
- 续传 offset 会按 4096 字节对齐，避免旧分片尾部导致 `OFFSET_INVALID`
- 遇到 `LIMIT_INVALID` 时，会自动按 512KB、256KB、128KB、64KB、32KB 逐级降级分片后继续请求
- 不限速时：不执行 sleep，按 Telegram 和当前网络实际吞吐下载
- 限速时：仍通过 `throttleSilentCache(deltaBytes)` 做全局总速率控制
- 说明：不再使用 GramJS `iterDownload` 作为后台缓存 document 视频的续传路径，避免大 offset 续传时落入较慢的 generic 下载迭代器

## 运行诊断

- 管理员后台「运行诊断」提供缓存速度诊断
- 测速接口：`POST /api/admin/cache-speed-diagnostics`
- 默认方式：如果已有后台缓存任务运行，直接聚合运行任务的当前速度，不额外读取 Telegram 文件
- 抽样方式：点击「抽样测速」时，选择一个后台缓存任务读取 1MB Telegram 文件但不落盘
- 返回内容：诊断方式、实测速度、样本大小、耗时、分片数量、Telegram DC、当前限速、并发、运行任务、队列数量、实际分片大小和 `LIMIT_INVALID` 次数
- 用途：区分 Telegram 网络/账号/DC 慢、Feigram 调度慢、限速配置异常或写盘缓存异常

## 恢复与巡检

- 应用启动时会读取 `silent-cache-tasks.json`
- 未完成任务恢复为 `queued`
- 后台每 10 分钟巡检一次
- `error`、`paused`、`queued` 或停滞的 `running` 任务会重新排队
- 已经存在正式缓存文件的任务会直接标记为 `completed`
- 遇到 `FILE_REFERENCE_EXPIRED` 时会短间隔重新排队，下一轮重新拉取消息刷新 `fileReference`
- 网络波动或 Telegram 临时错误会重新排队，已下载的 `*.silent.part` 会保留

## 相关代码

- 服务端缓存/下载逻辑：`server/src/telegramService.js`
- 缓存设置接口：`PUT /api/silent-cache/control`
- 缓存列表接口：`GET /api/silent-cache`
- 缓存排序接口：`POST /api/silent-cache/reorder`
- 缓存速度诊断接口：`POST /api/admin/cache-speed-diagnostics`
- 前端缓存信息面板：`client/src/main.jsx`
- 后台缓存样式：`client/src/styles/app.css`
