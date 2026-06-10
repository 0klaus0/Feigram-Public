# Feigram Public

Feigram Public 是第三方开发的非官方 Telegram 客户端公开发布版，仅面向飞牛 OS / fnOS 设备。Feigram 不隶属于 Telegram、Telegram Messenger Inc. 或飞牛官方。

## 功能

- 每个飞牛账户独立登录、独立 Telegram session、独立缓存目录
- 管理员后台创建、禁用飞牛账户和重置密码
- Telegram session 加密存储
- 登录限流和 Telegram 验证码请求限流
- Telegram 会话列表、聊天文件夹、消息查看、文本发送
- 图片预览、视频预览、文件下载、缓存目录和自动清理
- Telegram 链接在客户端内跳转，并支持返回上层位置
- 公告栏、关于 Feigram、隐私政策、服务条款和支持邮箱展示
- 公告和关于 Feigram 内容随 GitHub 仓库发布，应用端只负责展示
- 内置默认 Telegram API 配置，管理员后台可覆盖

## 首次使用

1. 在飞牛 OS 安装 FPK。
2. 打开 Feigram，创建第一个管理员飞牛账户。
3. 进入管理员后台添加 Telegram 账号。
4. 如需使用自己的 Telegram API 配置，可在管理员后台的“覆盖 API 设置”中填写。
5. 公开部署前请配置 HTTPS，并在 `server/src/releaseContent.js` 和 `docs/` 中维护公告、关于 Feigram、隐私政策、服务条款和支持邮箱。

## 重要声明

Feigram 是第三方客户端，使用 Telegram 公开协议能力连接 Telegram 服务。你需要遵守 Telegram 的服务条款、本项目发布平台规则，以及所在地法律法规。

详见：

- [发布说明](docs/release-notes.md)
- [隐私政策](docs/privacy-policy.md)
- [服务条款](docs/terms-of-service.md)
