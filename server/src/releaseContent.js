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
    id: "release-2.0.40",
    title: "Fngram 2.0.40 更新",
    version: "2.0.40",
    level: "success",
    createdAt: "2026-07-29T12:00:00.000Z",
    body: [
      "直播流轉發重大修復：改為文件寫入 + tail -F 管道方式，解決 ffmpeg MP4 解復用器無法從管道讀取 fMP4 數據的問題。",
      "ffmpeg 啟動時從文件讀取完整的 init segment（ftyp + moov），後續通過 tail -F 持續跟蹤文件增長。",
      "新增 Telegram chunk 頭部解析調試日誌，方便排查數據格式問題。",
      "修復 ffmpeg stdin EPIPE 崩潰問題（已在上版生效，此版進一步加固）。"
    ].join("\n")
  },
  {
    id: "release-2.0.35",
    title: "Fngram 2.0.35 更新",
    version: "2.0.35",
    level: "success",
    createdAt: "2026-07-29T00:00:00.000Z",
    body: [
      "修復 GROUPCALL_JOIN_MISSING 錯誤：下載直播流分片前，先以聽眾身份（muted + videoStopped）加入群組通話。",
      "Telegram API 要求必須先 JoinGroupCall 才能通過 upload.GetFile 下載直播流分片，否則返回 JOIN_MISSING 錯誤。",
      "直播轉發停止時自動調用 LeaveGroupCall 離開通話，清理資源。",
      "使用 InputPeerSelf 作為 joinAs 參數，確保以當前帳號身份加入。"
    ].join("\n")
  },
  {
    id: "release-2.0.34",
    title: "Fngram 2.0.34 更新",
    version: "2.0.34",
    level: "success",
    createdAt: "2026-07-28T21:30:00.000Z",
    body: [
      "修復直播流分片下載參數（對齊官方客戶端實現）：",
      "scale 固定為 0（1秒分片）、precise 改為 false、limit 從 1MB 改為 128KB、videoQuality 從 1 改為 2（最高質量）。",
      "修復時間戳計算：初始時間戳對齊到 1 秒邊界並減去 2 秒緩衝，避免 TIME_TOO_BIG 錯誤。",
      "新增詳細錯誤處理：區分 TIME_TOO_BIG（等待重試）、TIME_TOO_SMALL（重新同步）、GROUPCALL_INVALID（直播結束）等情況。"
    ].join("\n")
  },
  {
    id: "release-2.0.33",
    title: "Fngram 2.0.33 更新",
    version: "2.0.33",
    level: "success",
    createdAt: "2026-07-28T20:30:00.000Z",
    body: [
      "修復直播流 DC 路由問題：GetGroupCallStreamChannels 和 upload.GetFile API 現在正確使用 stream_dc_id 指定的 DC 進行調用。",
      "改進錯誤提示：當群組通話未進入流模式（streamDcId=0）時，顯示明確的錯誤信息而非通用的「無法獲取頻道信息」。",
      "Telegram 僅在參與者超過一定數量或使用 RTMP 直播模式時才會啟用流模式，小型群組通話仍需使用連結複製方式觀看。"
    ].join("\n")
  },
  {
    id: "release-2.0.31",
    title: "Fngram 2.0.31 更新",
    version: "2.0.31",
    level: "success",
    createdAt: "2026-07-28T22:00:00.000Z",
    body: [
      "新增應用內直播觀看功能：基於 MTProto 直播流分片下載 + ffmpeg HLS 轉發，支持在 Fngram 內直接播放群組直播。",
      "點擊直播圖標後可選擇「觀看直播」，系統會自動從 Telegram 獲取視頻數據並轉為 HLS 流播放。",
      "直播查看器改進：新增 ffmpeg 可用性檢查、啟動超時檢測、錯誤信息回傳，失敗時顯示具體原因。",
      "保留直播邀請連結複製功能作為備用方案。"
    ].join("\n")
  },
  {
    id: "release-2.0.30",
    title: "Fngram 2.0.30 更新",
    version: "2.0.30",
    level: "success",
    createdAt: "2026-07-28T21:00:00.000Z",
    body: [
      "修復更新檢測 403 錯誤：添加 Accept 頭和 HTML 後備方案。",
      "優化直播邀請連結獲取邏輯。",
      "GitHub Actions 構建工作流修復：ARM64 工作流添加 tag push 觸發器。"
    ].join("\n")
  },
  {
    id: "release-2.0.28",
    title: "Fngram 2.0.28 更新",
    version: "2.0.28",
    level: "success",
    createdAt: "2026-07-28T20:00:00.000Z",
    body: [
      "直播查看器改為半屏底部彈窗，更貼近原生 Telegram 風格。",
      "修復直播加入連結跳轉失敗：改用 Telegram Web 打開，不再觸發無效的應用跳轉。",
      "清理舊版本公告，只保留 Fngram 相關更新內容。",
      "新增應用內更新檢測與一鍵下載功能：後台可檢查新版本並直接下載 FPK 安裝包。"
    ].join("\n")
  },
  {
    id: "release-2.0.26",
    title: "Fngram 2.0.26 更新",
    version: "2.0.26",
    level: "success",
    createdAt: "2026-07-28T12:00:00.000Z",
    body: [
      "全面品牌統一：構建產物名稱由 feigrampub 改為 fngram，GitHub Actions 產物名同步更新。",
      "修復服務條款中殘留的舊名稱引用。",
      "前端代碼內部組件命名統一為 Fngram。"
    ].join("\n")
  },
  {
    id: "release-2.0.25",
    title: "Fngram 2.0.25 更新",
    version: "2.0.25",
    level: "success",
    createdAt: "2026-07-28T10:00:00.000Z",
    body: [
      "新增內置直播查看器：點擊直播圖標可打開直播詳情彈窗，實時顯示參與人數、參與者列表（視頻/語音分組）。",
      "APP 正式更名為 Fngram，基於 Feigram-Public 二次開發，感謝原項目 g-star1024/Feigram-Public。",
      "修復群組直播標識檢測邏輯：適配 GramJS v2.26.22 的 callActive 標誌位。",
      "優化聊天列表加載與歸檔過濾，界面佈局更貼近原生 Telegram 風格。"
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
