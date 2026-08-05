const about = {
  title: "关于 Fngram",
  publisherName: "0klaus0",
  supportEmail: "",
  releaseUrl: "https://github.com/0klaus0/fngram",
  privacyPolicyUrl: "https://github.com/0klaus0/fngram/blob/main/docs/privacy-policy.md",
  termsUrl: "https://github.com/0klaus0/fngram/blob/main/docs/terms-of-service.md",
  body: [
    "Fngram 是基于 Feigram-Public 二次开发的非官方 Telegram 客户端，仅适用于飞牛 OS / fnOS。",
    "Fngram 不隶属于 Telegram、Telegram Messenger Inc. 或飞牛官方。",
    "感谢原项目 Feigram-Public (g-star1024) 提供的优秀基础。",
    "公开部署前请配置 HTTPS，并在发布仓库中同步隐私政策、服务条款和支持邮箱。"
  ].join("\n")
};

const announcements = [
  {
    id: "release-2.0.61",
    title: "Fngram 2.0.61 更新",
    version: "2.0.61",
    level: "success",
    createdAt: "2026-08-05T01:30:00.000Z",
    body: [
      "修復 CI 構建：prepare-native-runtime.sh 中 apt-get install ffmpeg 不帶 sudo，在 GitHub Actions runner 上權限不足（exit code 100）導致構建失敗。",
      "改為先檢查 ffmpeg 是否已安裝（workflow 前置步驟已用 sudo 安裝），已安裝則跳過；未安裝時加 sudo 並容錯。"
    ].join("\n")
  },
  {
    id: "release-2.0.60",
    title: "Fngram 2.0.60 更新",
    version: "2.0.60",
    level: "success",
    createdAt: "2026-08-05T00:00:00.000Z",
    body: [
      "修復構建失敗：server/package.json 中 @gramjs/telegram@^3.0.0 在 npm 不存在（404），導致 CI 構建一直失敗。恢復為正確的 telegram@^2.26.22 包。",
      "修復前後端不匹配：前端播放器從 mpegts.js 恢復為 hls.js，與後端 HLS 輸出（stream.m3u8）匹配。"
    ].join("\n")
  },
  {
    id: "release-2.0.55",
    title: "Fngram 2.0.55 更新",
    version: "2.0.55",
    level: "success",
    createdAt: "2026-07-31T16:30:00.000Z",
    body: [
      "徹底解決直播流無法播放：經 v2.0.50~v2.0.54 五輪驗證，確認 HLS 在裸 H.264 管道輸入下不可行——HLS 需要關鍵幀對齊才能切分，而 Telegram chunk 拼接的裸 H.264 在關鍵幀上天然不穩定。",
      "改用 MPEG-TS 輸出：MPEG-TS 是連續流，無切分需求，對時間戳更寬容。配合 wallclock 時間戳（-use_wallclock_as_timestamps 1），徹底繞開裸流無 PTS 和關鍵幀不穩定的問題。",
      "前端播放器改用 mpegts.js：成熟的开源库，API 与 hls.js 類似，支持實時低延遲播放。"
    ].join("\n")
  },
  {
    id: "release-2.0.54",
    title: "Fngram 2.0.54 更新",
    version: "2.0.54",
    level: "success",
    createdAt: "2026-07-31T15:45:00.000Z",
    body: [
      "修復直播流 HLS 仍無法播放：v2.0.53 開始重編碼後 ffmpeg 輸出 frame=3 即停滯，HLS 分片始終不生成。",
      "根因：-keyint_min 50 被 -preset veryfast 覆蓋為 26，關鍵幀間隔不穩定導致 HLS muxer 無法切分；同時 Telegram chunk 拼接時 POC 不連續可能讓解碼器停止輸出。",
      "改用 -x264opts 傳遞參數避免 preset 覆蓋（keyint=25:keyint_min=25），並每秒強制 IDR（-force_key_frames），確保 1 秒內即可切分出第一個分片。",
      "增加輸入容錯（-fflags +discardcorrupt -err_detect ignore_err），讓解碼器跳過異常封包繼續工作。",
      "加大 GetFile limit 至 512KB（原 128KB），讓每個 chunk 包含更多幀，減少請求次數。",
      "延長 playlist 檢測至 chunk #30，並在 stderr 中保留 HLS 分片創建與進度輸出，方便診斷。"
    ].join("\n")
  },
  {
    id: "release-2.0.53",
    title: "Fngram 2.0.53 更新",
    version: "2.0.53",
    level: "success",
    createdAt: "2026-07-30T23:30:00.000Z",
    body: [
      "徹底修復直播流 HLS 無法播放：經 v2.0.50~v2.0.52 三輪驗證，確認 copy 模式在裸 H.264 管道輸入下不可行——此 FFmpeg 版本的 h264 raw demuxer 不為封包生成 PTS/DTS，mpegts/hls muxer 報「Timestamps are unset」並中止。",
      "改為 libx264 重編碼（preset veryfast + tune zerolatency）：由編碼器自行生成正確單調的 PTS/DTS，繞開 demuxer 時間戳缺失問題。720p25 在現代 NAS CPU 上約 10-20% 佔用，可接受。",
      "設置關鍵幀間隔 2 秒（-g 50 -keyint_min 50 -sc_threshold 0）對齊 HLS 分片邊界，保證分片穩定。"
    ].join("\n")
  },
  {
    id: "release-2.0.52",
    title: "Fngram 2.0.52 更新",
    version: "2.0.52",
    level: "success",
    createdAt: "2026-07-30T22:30:00.000Z",
    body: [
      "修復直播流 HLS 仍無法播放：v2.0.51 雖用 -framerate 25 修正了時間戳，但 ffmpeg 默認 analyzeduration=5s + probesize=5MB，而 pipe 輸入數據每 3 秒才到達 1 秒視頻，湊夠 5 秒 analyzable 數據需 ~30 秒。",
      "探測期間數據被消耗，30 秒探測完成時前端已超時停止（stdin EOF），ffmpeg 輸出 0 幀「Output file is empty」後退出。",
      "縮小 probing 開銷：analyzeduration 1s + probesize 50KB，讓 ffmpeg 在第一個 chunk(~3s)後即完成探測開始輸出分片。raw h264 只需讀 SPS/PPS 即可確定格式，無需大量分析。"
    ].join("\n")
  },
  {
    id: "release-2.0.51",
    title: "Fngram 2.0.51 更新",
    version: "2.0.51",
    level: "success",
    createdAt: "2026-07-30T21:00:00.000Z",
    body: [
      "修復直播流 HLS 仍無法播放：v2.0.50 的牆鐘時間戳因分片突發到達 + 輪詢間隔造成 DTS 跳變與錯誤幀率（日誌 2.17 tbr），ffmpeg 無法正常輸出分片。",
      "改用 -framerate 25 輸入選項：讓 h264 raw demuxer 按視頻實際幀率為每幀生成單調遞增的 PTS/DTS，HLS 分片時長與播放時間恢復正常。"
    ].join("\n")
  },
  {
    id: "release-2.0.50",
    title: "Fngram 2.0.50 更新",
    version: "2.0.50",
    level: "success",
    createdAt: "2026-07-30T20:00:00.000Z",
    body: [
      "修復直播流無法播放問題：裸 H.264 管道輸入沒有容器，封包不帶 PTS/DTS，直接 copy 進 HLS muxer 會報「first pts and dts value must be set」並在第一幀失敗。",
      "為 ffmpeg 輸入側加入 -use_wallclock_as_timestamps 1：用牆鐘時間為每個到達的封包打時間戳，配合已有的 -fflags +genpts 補齊缺失的 PTS，無需重編碼即可正常輸出 HLS。"
    ].join("\n")
  },
  {
    id: "release-2.0.49",
    title: "Fngram 2.0.49 更新",
    version: "2.0.49",
    level: "success",
    createdAt: "2026-07-30T19:00:00.000Z",
    body: [
      "修復直播流無法播放問題：移除 tail 中間件，改為直接寫入 ffmpeg stdin，避免 ARM 設備上的緩衝延遲。",
      "增加 ffmpeg 診斷日誌：前 30 行 stderr 全部記錄，方便排查播放問題。",
      "增加 HLS playlist 生成檢測日誌：記錄 stream.m3u8 何時創建。"
    ].join("\n")
  },
  {
    id: "release-2.0.48",
    title: "Fngram 2.0.48 更新",
    version: "2.0.48",
    level: "success",
    createdAt: "2026-07-30T18:00:00.000Z",
    body: [
      "修復 flood wait 後時間戳補償問題：等待期間流逝的時間會自動加到時間戳上，避免落後。",
      "增大 TIME_TOO_SMALL 快進幅度：從 5 秒增加到 10 秒，更快追趕直播流。",
      "增加 chunk 下載間隔到 3 秒：減少請求頻率，降低 flood wait 發生概率。",
      "FLOOD_WAIT 冷卻期間也補償時間戳，避免冷卻後時間戳嚴重落後。"
    ].join("\n")
  },
  {
    id: "release-2.0.47",
    title: "Fngram 2.0.47 更新",
    version: "2.0.47",
    level: "success",
    createdAt: "2026-07-30T16:00:00.000Z",
    body: [
      "縮短啟動等待時間：從 10 秒減少到 5 秒，減少初始時間戳落後。",
      "chunk 下載間隔改為 2 秒：減少請求頻率，給網絡更多恢復時間。",
      "下載超時縮短至 8 秒：更快檢測連接問題，更快恢復。",
      "TIME_TOO_BIG 時自動快進時間戳 +2 秒：避免等待 500ms 導致時間戳持續落後。",
      "連接斷開後自動補償時間戳：等待 8 秒期間流逝的時間直接加到時間戳上，避免嚴重落後。",
      "增加詳細循環日誌：每次下載請求和結果都記錄，方便診斷問題。",
      "僵死檢測從 45 秒縮短到 30 秒：更快發現並停止卡住的 relay。"
    ].join("\n")
  },
  {
    id: "release-2.0.46",
    title: "Fngram 2.0.46 更新",
    version: "2.0.46",
    level: "success",
    createdAt: "2026-07-30T15:00:00.000Z",
    body: [
      "給所有 GramJS API 調用添加超時保護：getStreamChannels 10 秒、joinGroupCall 15 秒，防止連接斷開時無限卡住。",
      "簡化連接斷開處理：不再調用 getStreamChannels 重新同步（可能卡住），改為等待 8 秒後直接繼續嘗試下載。",
      "簡化 TIME_TOO_SMALL 處理：不再調用 getStreamChannels，改為時間戳快速前進 5 秒自動追趕。",
      "新增僵死檢測：running 狀態下 45 秒沒有成功下載 chunk，自動停止 relay 並釋放資源。",
      "修復 v2.0.45 連接斷開後 relay 僵死的問題。"
    ].join("\n")
  },
  {
    id: "release-2.0.45",
    title: "Fngram 2.0.45 更新",
    version: "2.0.45",
    level: "success",
    createdAt: "2026-07-30T06:00:00.000Z",
    body: [
      "添加 15 秒下載超時保護：防止連接斷開時下載請求卡住。",
      "新增連接斷開處理：檢測到連接斷開後等待 5 秒重連，重新同步時間戳後繼續下載。",
      "修復靜默失敗問題：之前只有第一次失敗才記錄日誌，現改為每 5 次記錄一次。",
      "優化錯誤分類：連接斷開、超時與普通錯誤分開處理，避免誤判為直播結束。"
    ].join("\n")
  },
  {
    id: "release-2.0.44",
    title: "Fngram 2.0.44 更新",
    version: "2.0.44",
    level: "success",
    createdAt: "2026-07-29T23:00:00.000Z",
    body: [
      "HLS 分片時長從 2 秒改為 1 秒：與 Telegram chunk 時長一致，1 個 chunk 即可生成 1 個 HLS 分片。",
      "chunk 下載間隔從 3 秒改為 1 秒：保證實時下載，避免時間戳落後導致 Time too small。",
      "idle timeout 從 60 秒增加到 120 秒：給觀眾更多等待時間。",
      "HLS 窗口大小從 6 改為 10：保留 10 秒的播放緩衝。"
    ].join("\n")
  },
  {
    id: "release-2.0.43",
    title: "Fngram 2.0.43 更新",
    version: "2.0.43",
    level: "success",
    createdAt: "2026-07-29T22:00:00.000Z",
    body: [
      "修復 ffmpeg 無法解析直播流數據問題：Telegram 直播流分片是 ftyp+free+mdat 結構（無 moov atom），ffmpeg 的 MP4 解復用器無法解析。",
      "新增 H.264 Annex B 提取：從 MP4 mdat box 中提取 AVCC 格式 NAL units，轉換為 Annex B 格式（00 00 00 01 起始碼）。",
      "ffmpeg 輸入格式從 -f mp4 改為 -f h264（原始 H.264 位流，不需要 moov atom）。",
      "視頻改為 -c:v copy 直通（不重編碼），大幅降低 ARM 設備 CPU 需求。",
      "禁用音頻處理（-an）：直播流分片只有視頻軌道。"
    ].join("\n")
  },
  {
    id: "release-2.0.42",
    title: "Fngram 2.0.42 更新",
    version: "2.0.42",
    level: "success",
    createdAt: "2026-07-29T20:00:00.000Z",
    body: [
      "修復 GramJS retries 參數：retries=0 被 GramJS 當成 falsy 回退到默認 5 次，現改為 retries=1（最多 2 次嘗試）。",
      "chunk 下載間隔從 1 秒增加到 3 秒，大幅降低 Telegram API 請求頻率。",
      "JoinGroupCall 後冷卻時間從 3 秒增加到 10 秒，避免立即調用導致 flood wait。",
      "新增 rate limit 冷卻機制：連續 3 次 flood wait 後自動暫停 60 秒，防止賬號被進一步限流。",
      "注意：若賬號已被 Telegram 重度限流，可能需要等待數小時後才能恢復正常。"
    ].join("\n")
  },
  {
    id: "release-2.0.39",
    title: "Fngram 2.0.39 更新",
    version: "2.0.39",
    level: "success",
    createdAt: "2026-07-29T08:30:00.000Z",
    body: [
      "修正直播流流程順序：先 JoinGroupCall 加入通話，再 GetGroupCallStreamChannels 獲取頻道（根據 TGTV 參考實現和 gram.js 文檔，加入通話是獲取頻道的前置條件）。",
      "移除所有重試邏輯：GetGroupCallStreamChannels 改為單次調用，避免觸發 Telegram Flood Wait 限流。",
      "新增 FLOOD_WAIT 指數退避處理：遇到限流時自動退避，最多 5 次後停止。",
      "簡化整體代碼邏輯，移除冗餘的 streamDcId 刷新和重複頻道獲取。"
    ].join("\n")
  },
  {
    id: "release-2.0.38",
    title: "Fngram 2.0.38 更新",
    version: "2.0.38",
    level: "success",
    createdAt: "2026-07-29T06:00:00.000Z",
    body: [
      "調整直播流獲取流程順序：先獲取流頻道信息（GetGroupCallStreamChannels），再加入通話（JoinGroupCall），最後下載分片。",
      "修復 JoinGroupCall 導致 GetGroupCallStreamChannels 失敗的問題：v2.0.32 中頻道獲取正常，加入 JoinGroupCall 後反而失敗，現已調整順序。",
      "新增降級方案：頻道信息獲取失敗時使用預設參數（videoChannel=1）繼續嘗試下載，不再直接報錯。",
      "加入通話後再次嘗試獲取頻道信息，雙重保障。"
    ].join("\n")
  },
  {
    id: "release-2.0.37",
    title: "Fngram 2.0.37 更新",
    version: "2.0.37",
    level: "success",
    createdAt: "2026-07-29T04:30:00.000Z",
    body: [
      "修復 GetGroupCallStreamChannels 在流媒體 DC 上失敗的問題：",
      "加入通話後等待 1.5 秒讓服務器同步參與者狀態，再獲取流頻道信息。",
      "GetGroupCallStreamChannels 增加 3 次重試機制，每次間隔 2 秒。",
      "首次獲取失敗後，重新調用 GetGroupCall 刷新 streamDcId 並重試。",
      "改進錯誤日誌，記錄每次重試的詳細信息。"
    ].join("\n")
  },
  {
    id: "release-2.0.36",
    title: "Fngram 2.0.36 更新",
    version: "2.0.36",
    level: "success",
    createdAt: "2026-07-29T03:00:00.000Z",
    body: [
      "修復 GROUPCALL_SSRC_DUPLICATE_MUCH 錯誤：JoinGroupCall 現在生成唯一 SSRC 和完整 WebRTC params。",
      "修復 JoinGroupCall 的 DC 路由：在用戶主 DC 調用 JoinGroupCall，而非 stream_dc_id 指定的 DC。",
      "正確提取參與者 source ID 用於 LeaveGroupCall。",
      "生成隨機 ufrag、fingerprint 和 SSRC，模擬 WebRTC 客戶端 SDP offer。"
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
