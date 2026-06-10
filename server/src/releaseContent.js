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
