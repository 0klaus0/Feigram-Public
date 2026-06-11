const about = {
  title: "关于 Feigram",
  publisherName: "g-star1024",
  supportEmail: "",
  releaseUrl: "https://github.com/g-star1024/Feigram-Public",
  privacyPolicyUrl: "https://github.com/g-star1024/Feigram-Public/blob/main/docs/privacy-policy.md",
  termsUrl: "https://github.com/g-star1024/Feigram-Public/blob/main/docs/terms-of-service.md",
  body: [
    "Feigram Public 是第三方开发的非官方 Telegram 客户端，仅适用于飞牛 OS / fnOS。",
    "Feigram 不隶属于 Telegram、Telegram Messenger Inc. 或飞牛官方。",
    "公开部署前请配置 HTTPS，并在发布仓库中同步隐私政策、服务条款和支持邮箱。"
  ].join("\n")
};

const announcements = [
  {
    id: "release-2.0.11",
    title: "Feigram 2.0.11 更新",
    version: "2.0.11",
    level: "success",
    createdAt: "2026-06-12T05:00:00.000Z",
    body: [
      "缓存信息的最大缓存速率确认支持不限速，选择不限速时后台缓存不再执行全局节流。",
      "后台缓存并发数量新增 10，服务端会强制限制在 1-10。",
      "限速模式下并发任务继续共享总速率限制；不限速模式下使用 Telegram 默认下载策略。",
      "新增缓存与下载逻辑文档，便于后续继续调整限速、并发、分片和重试策略。"
    ].join("\n")
  },
  {
    id: "release-2.0.10",
    title: "Feigram 2.0.10 更新",
    version: "2.0.10",
    level: "success",
    createdAt: "2026-06-12T04:00:00.000Z",
    body: [
      "修复后台缓存暂停后重新开启，前几个运行任务仍显示已暂停且不继续缓存的问题。",
      "重新开启后台缓存、调整限速或调整并发时，会重置限速窗口，避免旧下载进度导致恢复后长时间补等待。",
      "正在退出的旧暂停任务会标记为重新排队，退出后自动回到队列继续缓存。",
      "优化动态下载分片策略，2MB/s、5 并发这类场景会使用更大的分片提高吞吐。"
    ].join("\n")
  },
  {
    id: "release-2.0.9",
    title: "Feigram 2.0.9 更新",
    version: "2.0.9",
    level: "success",
    createdAt: "2026-06-12T03:00:00.000Z",
    body: [
      "修复后台缓存高并发高限速时实际速度只有几十 KB/s 的问题。",
      "限速模式下 Telegram 下载分片不再固定为 32KB，会根据最大缓存速率和并发数量动态调整。",
      "低速限速仍使用较小分片控制瞬时峰值；5MB/s、5 并发这类场景会使用更大的分片提高吞吐。",
      "总速率限制仍然全局共享，不会因为并发数量提高而放大上限。"
    ].join("\n")
  },
  {
    id: "release-2.0.8",
    title: "Feigram 2.0.8 更新",
    version: "2.0.8",
    level: "success",
    createdAt: "2026-06-12T02:00:00.000Z",
    body: [
      "修复后台缓存恢复时偶发提示找不到会话的问题。",
      "后台缓存任务现在会直接通过 Telegram peer id 解析群组/频道，不再只依赖当前会话列表缓存。",
      "会话列表和 Telegram 文件夹同步拉取上限提高到 500，减少大号会话展示不全的情况。",
      "会话确实不可访问时，会提示可能已退出群组、会话已删除或 Telegram 暂时无法解析。"
    ].join("\n")
  },
  {
    id: "release-2.0.7",
    title: "Feigram 2.0.7 更新",
    version: "2.0.7",
    level: "success",
    createdAt: "2026-06-12T01:00:00.000Z",
    body: [
      "缓存信息新增后台缓存并发数量设置。",
      "管理员可在 1-5 个并发任务之间选择，最少 1 个，最多 5 个。",
      "并发任务继续共享最大缓存速率限制，避免把限速按任务数放大。",
      "调整并发数量后会立即重排当前后台缓存任务。"
    ].join("\n")
  },
  {
    id: "release-2.0.6",
    title: "Feigram 2.0.6 更新",
    version: "2.0.6",
    level: "success",
    createdAt: "2026-06-12T00:00:00.000Z",
    body: [
      "进一步增强群缓存限速策略。",
      "限速开启时，后台缓存强制单任务运行，避免多个任务并发叠加突破上限。",
      "限速开启时改用 Telegram 底层下载接口，并指定 32KB 小分片，降低单个大分片造成的瞬时冲高。",
      "切换为限速模式时，会主动暂停多余运行任务并重新排队。"
    ].join("\n")
  },
  {
    id: "release-2.0.5",
    title: "Feigram 2.0.5 更新",
    version: "2.0.5",
    level: "success",
    createdAt: "2026-06-11T23:30:00.000Z",
    body: [
      "修复群缓存最大速率限制不准确的问题。",
      "限速策略改为全局总速率限制，所有后台缓存任务共享同一个速率上限。",
      "移除单次节流最多 5 秒的限制，避免大分片下载时突破设置的限速。",
      "切换限速值时会重置限速窗口，新设置会立即作用于正在运行的后台缓存任务。"
    ].join("\n")
  },
  {
    id: "release-2.0.4",
    title: "Feigram 2.0.4 更新",
    version: "2.0.4",
    level: "success",
    createdAt: "2026-06-11T23:00:00.000Z",
    body: [
      "清理旧版本遗留的已取消群缓存记录，已取消任务不会再出现在缓存信息列表。",
      "优化首次打开加载顺序，账号和会话优先加载，公告、下载、缓存信息和文件夹延后加载。",
      "管理员后台重构为账号管理、服务端设置、缓存信息、隐私设置和诊断。",
      "账号管理合并飞牛账号管理和 Telegram 账号管理。",
      "服务端设置合并 API、缓存下载和播放器设置。",
      "隐私设置合并通知、隐私和分组设置。"
    ].join("\n")
  },
  {
    id: "release-2.0.3",
    title: "Feigram 2.0.3 更新",
    version: "2.0.3",
    level: "success",
    createdAt: "2026-06-11T22:00:00.000Z",
    body: [
      "群缓存取消后会直接移出缓存列表，不再保留已取消记录。",
      "群缓存新增按视频标题和大小排重，避免同一视频反复进入队列。",
      "群缓存列表支持拖动排序，排序结果会保存到服务端并影响后续缓存顺序。",
      "后台每 10 分钟巡检群缓存状态，失败、停滞或排队任务会自动重新拉起，直到缓存完成。",
      "下载列表和群缓存都增加网络波动自动重试，缓解 Request was unsuccessful 5 time(s) 这类 Telegram 网络请求失败。"
    ].join("\n")
  },
  {
    id: "release-2.0.2",
    title: "Feigram 2.0.2 更新",
    version: "2.0.2",
    level: "success",
    createdAt: "2026-06-11T21:00:00.000Z",
    body: [
      "优化群视频后台缓存状态恢复，刷新页面或重新打开窗口后会继续显示任务状态。",
      "群缓存新增一键开启/暂停，暂停时不再继续拉起队列任务，重新开启后会恢复未完成任务。",
      "群缓存新增最大缓存速率限制，可在管理员后台按需选择。",
      "群缓存任务标题后新增 X，可单独取消某个后台缓存任务。",
      "改进 Telegram 消息链接定位策略，目标消息未返回时会提示内容可能已被删除。",
      "支持已同步会话中的 t.me/c 私有群组/频道链接在客户端内定位。"
    ].join("\n")
  },
  {
    id: "release-2.0.1",
    title: "Feigram 2.0.1 更新",
    version: "2.0.1",
    level: "success",
    createdAt: "2026-06-11T20:00:00.000Z",
    body: [
      "修复聊天消息里的 Telegram 链接跳转后无法定位到目标消息的问题。",
      "修复从跳转群聊返回时无法恢复原聊天阅读位置的问题。",
      "管理员后台新增“群缓存”列表，可查看群组后台自动缓存视频的标题、进度、速度和状态。",
      "群视频后台缓存进度会落盘并通过实时事件更新，重启或升级后继续展示和恢复。",
      "修复诊断页读取日志时 handle.close is not a function 的问题。"
    ].join("\n")
  },
  {
    id: "release-2.0.0",
    title: "Feigram 2.0 fnOS Client Edition",
    version: "2.0.0",
    level: "success",
    createdAt: "2026-06-11T18:00:00.000Z",
    body: [
      "Feigram 2.0 开始按 fnOS Client Edition 方向整合，保留现有稳定功能。",
      "新增系统诊断页，可查看版本、缓存大小、任务数量、数据目录和日志尾部。",
      "新增应用内更新检测，可跳转到 GitHub 发布页。",
      "用户主动下载任务和群组后台静默缓存任务支持落盘，重启或升级后自动恢复。",
      "群组后台缓存限制最多 5 个并发，避免大群一次性拉起过多任务。",
      "群组信息资源列表支持滚动加载更多。"
    ].join("\n")
  },
  {
    id: "release-1.5.9",
    title: "Feigram 1.5.9 更新",
    version: "1.5.9",
    level: "success",
    createdAt: "2026-06-11T15:30:00.000Z",
    body: [
      "下载中心改用任务创建时间排序，下载进度刷新不会再让列表上下跳动。",
      "群组信息新增图片、视频、文件资源入口，可按类型浏览并直接打开资源。",
      "群组信息新增后台自动缓存开关，可静默缓存本群大于 100MB 的视频，不进入用户下载列表。",
      "视频消息新增封面预览和时长展示，优先使用 Telegram 自带缩略图，缓存后可用 ffmpeg 生成封面。",
      "去掉视频窗口上的播放器模式提示，减少聊天界面干扰。"
    ].join("\n")
  },
  {
    id: "release-1.5.8",
    title: "Feigram 1.5.8 更新",
    version: "1.5.8",
    level: "success",
    createdAt: "2026-06-11T12:00:00.000Z",
    body: [
      "修复管理员后台和群组信息侧栏被内容撑开的布局问题。",
      "下载中心移除右键菜单，所有操作改为任务卡片内的小按钮。",
      "下载标题、进度、速度和时间改为稳定展示，减少标题抖动。",
      "同一视频下载记录统一去重，成功记录不会重复堆叠。",
      "默认播放策略改为原始视频在线播放优先，HLS 转码保留为实验兜底模式。",
      "优化图片和视频消息尺寸规则，媒体组展示更接近 Telegram 官方客户端。"
    ].join("\n")
  },
  {
    id: "release-1.5.7",
    title: "Feigram 1.5.7 更新",
    version: "1.5.7",
    level: "success",
    createdAt: "2026-06-10T11:00:00.000Z",
    body: [
      "修复下载失败后被播放器重试反复拉起的问题。",
      "下载缓存改用 GramJS 官方 downloadMedia 流程，降低 InputFileLocation 兼容问题。",
      "下载完成的视频可在下载列表中直接点击播放。",
      "管理员后台新增播放器模式设置：内置 HLS、浏览器原始、本地播放器。",
      "公告和管理员后台弹窗统一限制高度，内容区支持滚动。",
      "群组信息中的图片、视频和文件支持快捷访问。"
    ].join("\n")
  },
  {
    id: "release-1.5.6",
    title: "Feigram 1.5.6 更新",
    version: "1.5.6",
    level: "success",
    createdAt: "2026-06-10T10:00:00.000Z",
    body: [
      "修复视频缓存下载 Cannot cast Message to any kind of InputFileLocation 的问题。",
      "下载中心区分清除列表记录和删除缓存文件。",
      "聊天消息和视频预览按窗口宽度展开，未播放和播放后的窗口尺寸保持一致。",
      "新增群组信息侧栏，点击聊天头部可查看基础信息、媒体统计和最近文件。",
      "FPK 内置 ffmpeg，服务端可将视频转成 H.264/AAC HLS 后供客户端播放。"
    ].join("\n")
  },
  {
    id: "release-1.5.5",
    title: "Feigram 1.5.5 更新",
    version: "1.5.5",
    level: "success",
    createdAt: "2026-06-10T08:00:00.000Z",
    body: [
      "新增下载功能区，缓存视频会进入统一下载列表。",
      "下载任务支持进度、速度展示，并可开始、取消、删除。",
      "视频缓存按钮移动到播放器右上角，状态与下载任务联动。",
      "缓存任务使用临时分片文件，取消后再次开始会从已写入位置继续。",
      "继续保留 Range 边加载边播放能力；浏览器无法解码的视频可缓存后使用本地播放器。"
    ].join("\n")
  },
  {
    id: "release-1.5.4",
    title: "Feigram 1.5.4 更新",
    version: "1.5.4",
    level: "success",
    createdAt: "2026-06-10T00:00:00.000Z",
    body: [
      "文件夹改为类似官方客户端的左侧竖向分组栏。",
      "聊天搜索支持回车搜索和一键清除。",
      "群聊消息可展示发言人头像与 ID，并可在后台关闭。",
      "同一组图片、视频消息会合并为媒体组网格展示。",
      "视频下载改为客户端内缓存，缓存完成后优先使用本地缓存播放。"
    ].join("\n")
  }
];

function readAbout() {
  return about;
}

function readAnnouncements() {
  return announcements.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

module.exports = {
  readAbout,
  readAnnouncements
};
