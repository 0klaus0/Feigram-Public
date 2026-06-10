const about = {
  title: "关于 Feigram",
  publisherName: "g-star1024",
  supportEmail: "",
  releaseUrl: "https://github.com/g-star1024/Feigram",
  privacyPolicyUrl: "docs/privacy-policy.md",
  termsUrl: "docs/terms-of-service.md",
  body: [
    "Feigram Public 是第三方开发的非官方 Telegram 客户端，仅适用于飞牛 OS / fnOS。",
    "Feigram 不隶属于 Telegram、Telegram Messenger Inc. 或飞牛官方。",
    "公开部署前请配置 HTTPS，并在发布仓库中同步隐私政策、服务条款和支持邮箱。"
  ].join("\n")
};

const announcements = [
  {
    id: "release-1.5.1",
    title: "Feigram 1.5.1 更新",
    version: "1.5.1",
    level: "success",
    createdAt: "2026-06-10T00:00:00.000Z",
    body: [
      "修复 Telegram 文件夹同步。",
      "公告和关于 Feigram 改为随 GitHub 仓库发布，应用端只展示。",
      "优化媒体缓存策略：图片默认缓存，超过 100MB 的视频才缓存，其他文件不缓存。",
      "视频改为点击后加载，优先播放当前视频。"
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
