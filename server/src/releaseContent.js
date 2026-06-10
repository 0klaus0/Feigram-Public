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
    id: "release-1.5.3",
    title: "Feigram 1.5.3 更新",
    version: "1.5.3",
    level: "success",
    createdAt: "2026-06-10T00:00:00.000Z",
    body: [
      "更新公开仓库、隐私政策和服务条款跳转地址。",
      "改进 Telegram 文件夹同步，由后端按官方 filter 计算会话归属。",
      "优化视频播放尺寸和 Range 流式播放，减少等待完整下载。",
      "新增通知、隐私和分组相关管理员设置。"
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
