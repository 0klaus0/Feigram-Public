const about = {
  title: "关于 Fngram",
  publisherName: "0klaus0",
  supportEmail: "",
  releaseUrl: "https://github.com/0klaus0/Feigram-Public",
  privacyPolicyUrl: "https://github.com/0klaus0/Feigram-Public/blob/main/docs/privacy-policy.md",
  termsUrl: "https://github.com/0klaus0/Feigram-Public/blob/main/docs/terms-of-service.md",
  body: [
    "Fngram 是基于 Feigram-Public 二次开发的非官方 Telegram 客户端，仅适用于飞牛 OS / fnOS。",
    "Fngram 不隶属于 Telegram、Telegram Messenger Inc. 或飞牛官方。",
    "感谢原项目 Feigram-Public (g-star1024) 提供的优秀基础。",
    "公开部署前请配置 HTTPS，并在发布仓库中同步隐私政策、服务条款和支持邮箱。"
  ].join("\n")
};

const announcements = [
  {
    id: "release-2.0.27",
    title: "Fngram 2.0.27 更新",
    version: "2.0.27",
    level: "success",
    createdAt: "2026-07-28T21:30:00.000Z",
    body: [
      "直播查看器改为半屏底部弹窗，更贴近原生 Telegram 风格。",
      "修复直播加入链接跳转失败：改用 Telegram Web 打开，不再触发无效的应用跳转。",
      "清理旧版本公告，只保留 Fngram 相关更新内容。",
      "新增应用内更新检测与一键下载功能：后台可检查新版本并直接下载 FPK 安装包。"
    ].join("\n")
  },
  {
    id: "release-2.0.26",
    title: "Fngram 2.0.26 更新",
    version: "2.0.26",
    level: "success",
    createdAt: "2026-07-28T20:00:00.000Z",
    body: [
      "全面品牌统一：构建产物名称由 feigrampub 改为 fngram，GitHub Actions 产物名同步更新。",
      "修复服务条款中残留的旧名称引用。",
      "前端代码内部组件命名统一为 Fngram。"
    ].join("\n")
  },
  {
    id: "release-2.0.25",
    title: "Fngram 2.0.25 更新",
    version: "2.0.25",
    level: "success",
    createdAt: "2026-07-28T12:00:00.000Z",
    body: [
      "新增内置直播查看器：点击直播图标可打开直播详情弹窗，实时显示参与人数、参与者列表（视频/语音分组）。",
      "APP 正式更名为 Fngram，基于 Feigram-Public 二次开发，感谢原项目 g-star1024/Feigram-Public。",
      "修复群组直播标识检测逻辑：适配 GramJS v2.26.22 的 callActive 标志位。",
      "优化聊天列表加载与归档过滤，界面布局更贴近原生 Telegram 风格。"
    ].join("\n")
  }
];

function readAbout() {
  return about;
}

function compareVersion(a, b) {
  const left = String(a || "").split(".").map((part) => Number(part) || 0);
  const right = String(b || "").split(".").map((part) => Number(part) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (right[index] || 0) - (left[index] || 0);
    if (diff) return diff;
  }
  return 0;
}

function readAnnouncements() {
  return announcements.slice().sort((a, b) => compareVersion(a.version, b.version) || String(b.createdAt).localeCompare(String(a.createdAt)));
}

module.exports = {
  readAbout,
  readAnnouncements
};
