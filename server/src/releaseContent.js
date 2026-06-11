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
