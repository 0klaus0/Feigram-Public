# 下载后端评估

Feigram 的后台缓存不是普通 HTTP 下载。它需要处理 Telegram MTProto、加密 session、`fileReference` 过期刷新、断点续传、限速、并发、任务持久化和飞牛账户隔离。

## 当前默认方案

Feigram 当前使用内置 GramJS 下载链路：

- 通过当前登录的 Telegram session 直接访问 MTProto。
- document 视频使用 `iterDownload` 分片下载。
- 未完成任务保留 `.silent.part`，重启或升级后继续写入。
- `FILE_REFERENCE_EXPIRED`、网络超时和临时失败会重新排队并刷新消息引用。
- 后台群缓存和用户主动下载分开保存，避免互相污染列表。
- 后台缓存统一受全局并发和限速控制。

这是当前最稳的路径，优先继续修这个链路，而不是在稳定版本里直接替换成外部下载器。

## Gopeed

Gopeed 适合作为通用下载器或 UI/任务管理参考，但不适合直接作为 Feigram 的 Telegram 后台缓存引擎：

- Gopeed 面向 HTTP/HTTPS、BT、Magnet、ed2k 等通用下载协议。
- Gopeed 不直接理解 Telegram MTProto、Telegram session 和 `fileReference` 刷新。
- 如果让 Gopeed 下载 Feigram 暴露的本地媒体 URL，Telegram 下载仍然发生在 Feigram 服务端，Gopeed 只会多包一层 HTTP 下载，不会解决缓存失败、引用过期或限速恢复问题。
- 额外引入 Gopeed 还会带来进程生命周期、RPC 鉴权、缓存目录映射和 FPK 体积问题。

结论：暂不内置 Gopeed 作为 Telegram 缓存后端。后续可参考它的下载队列交互和任务展示方式。

## TG Downloader / tdl

Telegram 专用下载器更接近 Feigram 的需求，但目前不适合直接内置为默认后端：

- 这类工具通常需要独立登录、独立配置和独立 session。
- Feigram 已经加密存储 GramJS session，直接复用到外部工具存在格式转换和安全边界问题。
- 外部进程需要处理账号隔离、并发调度、取消、恢复、错误回传和版本兼容。
- 若使用 AGPL 等强 copyleft 许可项目，需要确认发布方式、源码公开和衍生作品义务。

结论：可以作为后续实验后端评估，但不进入当前稳定版默认链路。

## 后续接入外部下载器的最低要求

如果以后新增 `external` 下载后端，至少要满足：

- 不要求用户重复登录 Telegram。
- 不明文导出 Telegram session。
- 支持按账号、群组、消息维度隔离任务。
- 支持断点续传和重启恢复。
- 支持刷新过期 `fileReference` 或在失败时回调 Feigram 刷新消息。
- 支持全局限速、并发控制和单任务取消。
- 支持任务状态实时回传到缓存信息页。
- 失败不会删除未完成分片。
- 能明确区分后台群缓存和用户主动下载。

在这些条件满足前，Feigram 继续使用内置 GramJS 下载链路。
