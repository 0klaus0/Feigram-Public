/**
 * liveStreamRelay.js — Telegram 群組直播流 HLS 轉發模組
 *
 * 正確流程（基於 TGTV / tgroupcall-dl 參考實現）：
 * 1. 檢查 ffmpeg 是否可用
 * 2. phone.JoinGroupCall — 以聽眾身份加入通話（必須在獲取頻道之前）
 * 3. phone.GetGroupCallStreamChannels — 獲取直播頻道信息（單次調用，不重試）
 * 4. upload.GetFile + InputGroupCallStream — 循環下載 1 秒視頻分片
 * 5. 剝離 Telegram 自定義頭（魔數 0xA12E810D），提取純 MP4 媒體數據
 * 6. 將純媒體數據餵給 ffmpeg，轉碼為 HLS（.m3u8 + .ts）
 *
 * 關鍵：download.GetFile 返回的數據有 Telegram 自定義頭，必須剝離後才能餵給 ffmpeg
 * 參考：tgcalls/VideoStreamingPart.cpp — consumeVideoStreamInfo() 解析頭部
 *       tgroupcall-dl/chunk.go — UnmarshalBinary() 反序列化
 */

const { execFile, execFileSync, spawn } = require("child_process");
const { promisify } = require("util");
const fs = require("fs-extra");
const path = require("path");
const { Api } = require("telegram");
const bigInt = require("big-integer");
const { dataDir } = require("./store");

const execFileAsync = promisify(execFile);

const HLS_BASE_DIR = path.join(dataDir, "live-hls");
const SEGMENT_DURATION = 1; // 秒（HLS 分片時長，與 chunk 時長一致，1 個 chunk 即可生成 1 個分片）
const WINDOW_SIZE = 10; // 保留 10 個分片（10 秒窗口）
const MAX_CONCURRENT_RELAYS = 3;
const RELAY_IDLE_TIMEOUT = 120_000; // 無觀眾 120 秒後停止
const CHUNK_POLL_INTERVAL = 3000; // ms（3 秒間隔，減少請求頻率，降低 flood wait 概率）
const CHUNK_DOWNLOAD_TIMEOUT = 8000; // ms（8 秒超時，更快失敗恢復）
const RATE_LIMIT_COOLDOWN = 60_000; // 連續 flood wait 後冷卻 60 秒
const STARTUP_TIMEOUT = 30_000; // 啟動超時 30 秒
const DISCONNECT_WAIT_MS = 8000; // 連接斷開後等待 GramJS 重連的時間

// 直播流分片下載常量（來自 TGTV 參考實現 / 官方客戶端）
const SEGMENT_DURATION_MS = 1000; // 1 秒分片
const SEGMENT_BUFFER_MS = 2000; // 時間戳緩衝 2 秒
const GET_FILE_LIMIT = 512 * 1024; // 512KB（原 128KB 在 720p 下不足 1 秒，加大以減少請求次數並讓每個 chunk 包含更多幀）
const STREAM_SCALE = 0; // scale=0 對應 1 秒分片
const VIDEO_QUALITY_FULL = 2; // 最高質量

// Telegram 直播流 chunk 魔數
const TELEGRAM_CHUNK_MAGIC = 0xA12E810D;

// 活躍的轉發會話
const activeRelays = new Map();
let ffmpegChecked = false;
let ffmpegAvailable = false;

/**
 * 檢查 ffmpeg 是否可用
 */
async function checkFfmpeg() {
  if (ffmpegChecked) return ffmpegAvailable;
  ffmpegChecked = true;
  try {
    await execFileAsync("ffmpeg", ["-version"]);
    ffmpegAvailable = true;
    console.log("[liveStreamRelay] ffmpeg is available");
  } catch (err) {
    ffmpegAvailable = false;
    console.error("[liveStreamRelay] ffmpeg NOT found:", err.message);
  }
  return ffmpegAvailable;
}

/**
 * 確保 HLS 輸出目錄存在
 */
async function ensureHlsDir(sessionId) {
  const dir = path.join(HLS_BASE_DIR, sessionId);
  await fs.ensureDir(dir);
  const existing = await fs.readdir(dir).catch(() => []);
  for (const f of existing) {
    await fs.remove(path.join(dir, f)).catch(() => {});
  }
  return dir;
}

/**
 * 讀取 Telegram 序列化字符串
 * 格式：
 * - 首字节 < 254: 1 字節長度 + 字符串 + 填充至 4 字節對齊
 * - 首字节 == 254: 接下來 3 字節為長度 + 字符串 + 填充至 4 字節對齊
 * @returns {[string, number]} [字符串值, 新的偏移量]
 */
function readSerializedString(buffer, offset) {
  if (offset >= buffer.length) return ["", offset];

  const firstByte = buffer[offset];
  let length, headerLen;

  if (firstByte < 254) {
    length = firstByte;
    headerLen = 1;
  } else {
    // 3 bytes for length (little-endian)
    length = buffer[offset + 1] | (buffer[offset + 2] << 8) | (buffer[offset + 3] << 16);
    headerLen = 4;
  }

  const strStart = offset + headerLen;
  const str = buffer.slice(strStart, strStart + length).toString("utf-8");

  // 計算填充至 4 字節對齊
  const totalWithoutPadding = headerLen + length;
  const padding = (4 - (totalWithoutPadding % 4)) % 4;
  const newOffset = strStart + length + padding;

  return [str, newOffset];
}

/**
 * 解析並剝離 Telegram 自定義直播流頭，提取純 MP4 媒體數據
 *
 * 頭部格式（參考 tgcalls/VideoStreamingPart.cpp, tgroupcall-dl/chunk.go）：
 * [4 bytes: signature 0xA12E810D (LE)]
 * [serialized string: container, e.g. "mp4"]
 * [4 bytes: mask (uint32)]
 * [4 bytes: event count (uint32)]
 * [for each event:
 *   [4 bytes: offset (uint32)]
 *   [serialized string: endpoint]
 *   [4 bytes: rotation (uint32)]
 *   [4 bytes: extra (uint32)]
 * ]
 * [remaining: media data split by event offsets]
 *
 * @param {Buffer} rawBuffer - upload.GetFile 返回的原始數據
 * @returns {Buffer} 剝離頭部後的純 MP4 媒體數據
 */
let headerDebugDone = false; // 只打印一次調試信息

function stripTelegramHeader(rawBuffer) {
  if (rawBuffer.length < 4) return rawBuffer;

  // 檢查魔數
  const signature = rawBuffer.readUInt32LE(0);
  if (signature !== TELEGRAM_CHUNK_MAGIC) {
    // 不是 Telegram chunk — 打印前 32 字節用於調試
    if (!headerDebugDone) {
      headerDebugDone = true;
      const hex = rawBuffer.slice(0, Math.min(64, rawBuffer.length)).toString("hex");
      console.log("[liveStreamRelay] stripTelegramHeader: NO MAGIC, first 64 bytes hex:", hex);
      console.log("[liveStreamRelay] stripTelegramHeader: expected magic=0x" + TELEGRAM_CHUNK_MAGIC.toString(16) + ", got=0x" + signature.toString(16));
    }
    return rawBuffer;
  }

  let offset = 4;

  // 讀取 container 字符串（如 "mp4"）
  const [container, offsetAfterContainer] = readSerializedString(rawBuffer, offset);
  offset = offsetAfterContainer;

  // 讀取 mask
  if (offset + 4 > rawBuffer.length) return rawBuffer.slice(offset);
  const mask = rawBuffer.readUInt32LE(offset);
  offset += 4;

  // 讀取 event count
  if (offset + 4 > rawBuffer.length) return rawBuffer.slice(offset);
  const eventCount = rawBuffer.readUInt32LE(offset);
  offset += 4;

  // 讀取每個 event 的元數據
  const events = [];
  for (let i = 0; i < eventCount; i++) {
    if (offset + 4 > rawBuffer.length) break;
    const eventOffset = rawBuffer.readUInt32LE(offset);
    offset += 4;

    const [endpoint, offsetAfterEndpoint] = readSerializedString(rawBuffer, offset);
    offset = offsetAfterEndpoint;

    if (offset + 8 > rawBuffer.length) break;
    const rotation = rawBuffer.readUInt32LE(offset);
    offset += 4;
    const extra = rawBuffer.readUInt32LE(offset);
    offset += 4;

    events.push({ offset: eventOffset, endpoint, rotation, extra });
  }

  // 剩餘數據就是媒體數據
  const mediaData = rawBuffer.slice(offset);

  if (!headerDebugDone) {
    headerDebugDone = true;
    console.log(`[liveStreamRelay] stripTelegramHeader: magic=0x${signature.toString(16)}, container="${container}", mask=${mask}, eventCount=${eventCount}, headerSize=${offset}, rawSize=${rawBuffer.length}`);
    events.forEach((ev, i) => {
      console.log(`[liveStreamRelay]   event[${i}]: offset=${ev.offset}, endpoint="${ev.endpoint}", rotation=${ev.rotation}, extra=${ev.extra}`);
    });
    if (events.length > 0) {
      const finalStart = events[0].offset;
      const finalEnd = events.length > 1 ? events[1].offset : mediaData.length;
      console.log(`[liveStreamRelay]   mediaData total=${mediaData.length}, slice [${finalStart}:${finalEnd}] = ${finalEnd - finalStart} bytes`);
      // 打印剝離後數據的前 32 字節
      const stripped = mediaData.slice(finalStart, finalStart + Math.min(64, finalEnd - finalStart));
      console.log(`[liveStreamRelay]   stripped data first 64 bytes hex: ${stripped.toString("hex")}`);
      // 檢查是否以 MP4 ftyp box 開頭
      const ftypMagic = stripped.slice(0, 4).toString("ascii");
      console.log(`[liveStreamRelay]   stripped data first 4 ascii: "${ftypMagic}" (expected "ftyp" for fMP4)`);
    }
  }

  if (events.length === 0) {
    return mediaData;
  }

  // 通常只有一個 event，返回從其 offset 到末尾的數據
  if (events.length === 1) {
    return mediaData.slice(events[0].offset);
  }

  // 多個 event：取第一個 event 的數據（從其 offset 到下一個 event 的 offset）
  const start = events[0].offset;
  const end = events.length > 1 ? events[1].offset : mediaData.length;
  return mediaData.slice(start, end);
}

/**
 * 從 MP4 容器中提取 H.264 Annex B 格式位流
 *
 * Telegram 直播流分片的 MP4 結構：ftyp + free + mdat（無 moov atom）
 * mdat 中的數據為 AVCC 格式（4字節大端長度前綴 + NAL unit）
 * 轉換為 Annex B 格式（00 00 00 01 起始碼 + NAL unit）供 ffmpeg 直接解碼
 *
 * 關鍵修復：
 * - 全局緩存 SPS/PPS NAL 單元
 * - 在每個 IDR 幀（NAL type=5）前自動插入 SPS/PPS
 * - 解決後續 chunk 缺少 SPS/PPS 導致解碼器只能解碼前幾幀的問題
 *
 * @param {Buffer} mp4Data - 剝離 Telegram 頭後的 MP4 數據
 * @returns {Buffer} H.264 Annex B 位流
 */
let h264DebugDone = false;
let cachedSps = null;
let cachedPps = null;

function extractH264AnnexB(mp4Data) {
  let offset = 0;
  const chunks = [];

  while (offset + 8 <= mp4Data.length) {
    let boxSize = mp4Data.readUInt32BE(offset);
    const boxType = mp4Data.slice(offset + 4, offset + 8).toString("ascii");

    if (boxSize === 0) {
      boxSize = mp4Data.length - offset;
    }
    if (boxSize === 1) {
      if (offset + 16 > mp4Data.length) break;
      boxSize = mp4Data.readUInt32BE(offset + 12);
    }

    if (boxSize < 8 || offset + boxSize > mp4Data.length) break;

    if (boxType === "mdat") {
      const mdatData = mp4Data.slice(offset + 8, offset + boxSize);

      let pos = 0;
      let nalCount = 0;
      while (pos + 4 <= mdatData.length) {
        const nalLength = mdatData.readUInt32BE(pos);
        pos += 4;

        if (nalLength <= 0 || nalLength > mdatData.length - pos) break;

        const nalData = mdatData.slice(pos, pos + nalLength);
        const nalType = nalData[0] & 0x1f;

        // 快取 SPS/PPS（逐片處理時每個 ffmpeg 進程都需要）
        if (nalType === 7) cachedSps = Buffer.from(nalData);
        else if (nalType === 8) cachedPps = Buffer.from(nalData);

        chunks.push(Buffer.from([0x00, 0x00, 0x00, 0x01]));
        chunks.push(nalData);

        if (!h264DebugDone && nalCount < 8) {
          const nalNames = { 1: "non-IDR", 5: "IDR", 6: "SEI", 7: "SPS", 8: "PPS" };
          console.log(`[liveStreamRelay]   NAL[${nalCount}]: type=${nalType} (${nalNames[nalType] || "unknown"}), size=${nalLength}`);
          nalCount++;
        }

        pos += nalLength;
      }
    }

    offset += boxSize;
  }

  if (chunks.length === 0) {
    console.log("[liveStreamRelay] extractH264AnnexB: no mdat found, returning raw data");
    return mp4Data;
  }

  const result = Buffer.concat(chunks);
  if (!h264DebugDone) {
    h264DebugDone = true;
    console.log(`[liveStreamRelay] extractH264AnnexB: extracted ${result.length} bytes H.264 from ${mp4Data.length} bytes MP4, sps=${cachedSps?.length || 0}, pps=${cachedPps?.length || 0}`);
  }
  return result;
}

/**
 * 為每個 chunk 的 H.264 數據前注入快取的 SPS/PPS
 * 逐片處理時每個 ffmpeg 進程都是獨立的，需要 SPS/PPS 才能解碼
 */
function prepareChunkForFfmpeg(h264Data) {
  if (cachedSps && cachedPps) {
    return Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x01]), cachedSps,
      Buffer.from([0x00, 0x00, 0x00, 0x01]), cachedPps,
      h264Data
    ]);
  }
  return h264Data;
}

/**
 * 通用超時包裝器：防止 GramJS 調用在連接斷開時無限卡住
 * @param {Promise} promise - 要包裝的 Promise
 * @param {number} timeoutMs - 超時時間（毫秒）
 * @param {string} errorMsg - 超時錯誤信息
 * @returns {Promise}
 */
function withTimeout(promise, timeoutMs, errorMsg) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(errorMsg)), timeoutMs);
    })
  ]);
}

/**
 * 獲取直播流頻道信息（GramJS retries=1，外加 10 秒超時防止卡住）
 * 必須在 JoinGroupCall 之後調用，否則返回 GROUPCALL_JOIN_MISSING
 * @param {number} streamDcId - 流媒體所在的 DC ID（來自 GetGroupCall 的 stream_dc_id）
 * @returns {Promise<{channel, lastTimestampMs, allChannels}|null>}
 */
async function getStreamChannels(client, inputCall, streamDcId) {
  try {
    const result = await withTimeout(
      client.invoke(
        new Api.phone.GetGroupCallStreamChannels({ call: inputCall }),
        streamDcId || undefined,
        1 // retries=1：GramJS 默認 5 次，改為 1 次重試（最多 2 次嘗試）
      ),
      10000, // 10 秒超時
      "GET_CHANNELS_TIMEOUT"
    );
    if (!result?.channels?.length) {
      console.log("[liveStreamRelay] GetGroupCallStreamChannels returned no channels");
      return null;
    }

    console.log(`[liveStreamRelay] Found ${result.channels.length} stream channel(s):`);
    result.channels.forEach((ch, i) => {
      console.log(`  Channel ${i}: channel=${ch.channel}, scale=${ch.scale}, lastTimestampMs=${ch.lastTimestampMs}`);
    });

    // 選擇視頻頻道：優先 channel=1（視頻），否則取第一個
    const videoCh = result.channels.find((c) => c.channel === 1) || result.channels[0];
    return {
      channel: videoCh.channel,
      lastTimestampMs: Number(videoCh.lastTimestampMs || 0),
      allChannels: result.channels.map((c) => ({
        channel: c.channel,
        scale: c.scale || 0,
        lastTimestampMs: Number(c.lastTimestampMs || 0)
      }))
    };
  } catch (err) {
    const errMsg = err.message || String(err);
    if (/GET_CHANNELS_TIMEOUT/i.test(errMsg)) {
      console.log("[liveStreamRelay] getStreamChannels timed out (connection likely dropped)");
      return null;
    }
    console.error("[liveStreamRelay] getStreamChannels error:", errMsg);
    // 解析 flood wait 時間
    const floodMatch = errMsg.match(/FLOOD_WAIT_(\d+)/);
    if (floodMatch) {
      return { _floodWait: parseInt(floodMatch[1], 10) * 1000 };
    }
    return null;
  }
}

/**
 * 調整初始時間戳：對齊到 1 秒邊界並減去 2 秒緩衝
 * 來自 Telegram 官方客戶端 StreamingMediaContext.cpp 的 AdjustBootstrapTimestamp
 */
function adjustBootstrapTimestamp(timestampMs) {
  if (timestampMs <= 0) return 0;
  const adjusted = Math.floor(timestampMs / SEGMENT_DURATION_MS) * SEGMENT_DURATION_MS - SEGMENT_BUFFER_MS;
  return adjusted > 0 ? adjusted : 0;
}

/**
 * 下載單個直播流分片
 * 包裝在超時機制中，防止連接斷開時卡住
 * @param {number} streamDcId - 流媒體所在的 DC ID
 * @param {number} videoChannel - 視頻頻道 ID（來自 GetGroupCallStreamChannels）
 * @returns {Promise<{data: Buffer|null, error: string|null}>}
 */
async function downloadStreamChunk(client, inputCall, timeMs, videoChannel, streamDcId) {
  const location = new Api.InputGroupCallStream({
    call: inputCall,
    timeMs: bigInt(timeMs),
    scale: STREAM_SCALE,
    ...(videoChannel != null ? { videoChannel, videoQuality: VIDEO_QUALITY_FULL } : {})
  });

  try {
    // 添加超時保護，防止連接斷開時卡住
    const downloadPromise = client.invoke(
      new Api.upload.GetFile({
        location,
        offset: bigInt(0),
        limit: GET_FILE_LIMIT,
        precise: false
      }),
      streamDcId || undefined,
      1 // retries=1：限制最多 2 次嘗試
    );

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("DOWNLOAD_TIMEOUT")), CHUNK_DOWNLOAD_TIMEOUT);
    });

    const result = await Promise.race([downloadPromise, timeoutPromise]);

    if (result?.bytes?.length > 0) {
      return { data: Buffer.from(result.bytes), error: null };
    }
    return { data: null, error: "empty" };
  } catch (err) {
    const errMsg = err.message || String(err);
    if (/TIME_TOO_BIG|timed? ?out/i.test(errMsg)) {
      return { data: null, error: "TIME_TOO_BIG" };
    }
    if (/TIME_TOO_SMALL|TIME_INVALID/i.test(errMsg)) {
      return { data: null, error: "TIME_TOO_SMALL" };
    }
    if (/GROUPCALL_JOIN_MISSING/i.test(errMsg)) {
      return { data: null, error: "GROUPCALL_JOIN_MISSING" };
    }
    if (/GROUPCALL_INVALID/i.test(errMsg)) {
      return { data: null, error: "GROUPCALL_INVALID" };
    }
    const floodMatch = errMsg.match(/FLOOD_WAIT_(\d+)/);
    if (floodMatch) {
      return { data: null, error: "FLOOD_WAIT", floodWaitMs: parseInt(floodMatch[1], 10) * 1000 };
    }
    // 連接斷開或超時
    if (/not connected|connection closed|disconnected|DOWNLOAD_TIMEOUT/i.test(errMsg)) {
      console.log(`[liveStreamRelay] Connection issue (timeMs=${timeMs}): ${errMsg}`);
      return { data: null, error: "DISCONNECTED" };
    }
    console.error(`[liveStreamRelay] downloadStreamChunk error (timeMs=${timeMs}):`, errMsg);
    return { data: null, error: errMsg };
  }
}

/**
 * 逐片處理：將單個 chunk 的 H.264 數據轉為一個 .ts 分片
 *
 * v2.0.65 全新架構：
 * ─────────────────────────────────────────────
 *  核心改變：不再用單一 ffmpeg 進程處理連續流，改為每個 chunk
 *  獨立調用 ffmpeg 轉出一個 .ts 分片。
 *
 *  為什麼這樣更可靠？
 *  1. 每 chunk 只有 1 秒視頻（~25 幀），即使 ultrafast 也能瞬間完成
 *  2. 每片獨立解碼，不存在跨片 POC 不連續問題
 *  3. 每片自帶 SPS/PPS（由 prepareChunkForFfmpeg 注入），解碼器不會迷路
 *  4. 一片失敗不影響後續片，容錯性極強
 *  5. 重編碼自動生成正確時間戳和參數集
 * ─────────────────────────────────────────────
 *
 * @param {Buffer} h264Data - H.264 Annex B 位流
 * @param {number} segmentIndex - 分片序號
 * @param {string} outputDir - 輸出目錄
 * @returns {Promise<{success: boolean, segmentFile: string|null, duration: number}>}
 */
function processChunkToSegment(h264Data, segmentIndex, outputDir) {
  return new Promise((resolve) => {
    const segmentFile = path.join(outputDir, `segment_${String(segmentIndex).padStart(3, "0")}.ts`);
    const startTime = Date.now();

    const args = [
      "-y",
      "-fflags", "+genpts+igndts+discardcorrupt",
      "-err_detect", "ignore_err",
      "-f", "h264",
      "-r", "25",
      "-i", "pipe:0",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-tune", "zerolatency",
      "-profile:v", "baseline",
      "-level", "3.0",
      "-pix_fmt", "yuv420p",
      "-r", "25",
      "-g", "25",
      "-keyint_min", "25",
      "-sc_threshold", "0",
      "-b:v", "1500k",
      "-maxrate", "2000k",
      "-bufsize", "3000k",
      "-an",
      "-f", "mpegts",
      "-mpegts_flags", "+resend_headers",
      segmentFile
    ];

    const ffmpeg = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });

    let stderr = "";
    ffmpeg.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    ffmpeg.stdin.on("error", (err) => {
      if (err.code !== "EPIPE") {
        console.error(`[liveStreamRelay] chunk ffmpeg stdin error:`, err.message);
      }
    });

    ffmpeg.on("exit", (code, signal) => {
      const elapsed = Date.now() - startTime;
      if (code === 0) {
        const size = fs.existsSync(segmentFile) ? fs.statSync(segmentFile).size : 0;
        if (size > 0) {
          console.log(`[liveStreamRelay] Segment #${segmentIndex} created: ${size} bytes, ${elapsed}ms`);
          resolve({ success: true, segmentFile, duration: 1.0 });
        } else {
          console.log(`[liveStreamRelay] Segment #${segmentIndex} ffmpeg exit=0 but empty output, ${elapsed}ms`);
          resolve({ success: false, segmentFile: null, duration: 0 });
        }
      } else {
        const tail = stderr.slice(-300).replace(/\n/g, " ");
        console.log(`[liveStreamRelay] Segment #${segmentIndex} ffmpeg failed: code=${code}, ${elapsed}ms, stderr: ${tail}`);
        resolve({ success: false, segmentFile: null, duration: 0 });
      }
    });

    // 寫入數據並關閉 stdin（讓 ffmpeg 知道輸入結束）
    try {
      ffmpeg.stdin.write(h264Data);
      ffmpeg.stdin.end();
    } catch (err) {
      // EPIPE is expected if ffmpeg exited early
      if (err.code !== "EPIPE") {
        console.error(`[liveStreamRelay] chunk ffmpeg write error:`, err.message);
      }
    }
  });
}

/**
 * 更新 HLS 播放列表（.m3u8）
 * 手動生成播放列表，保留最近 windowSize 個分片
 *
 * @param {string} outputDir - 輸出目錄
 * @param {number} totalSegments - 已生成的分片總數
 * @param {number} windowSize - 播放列表窗口大小
 */
function updateHlsPlaylist(outputDir, totalSegments, windowSize = 10) {
  const playlistPath = path.join(outputDir, "stream.m3u8");
  const startIdx = Math.max(0, totalSegments - windowSize);

  let playlist = "#EXTM3U\n";
  playlist += "#EXT-X-VERSION:3\n";
  playlist += "#EXT-X-TARGETDURATION:2\n";
  playlist += `#EXT-X-MEDIA-SEQUENCE:${startIdx}\n`;

  for (let i = startIdx; i < totalSegments; i++) {
    const segFile = `segment_${String(i).padStart(3, "0")}.ts`;
    const segPath = path.join(outputDir, segFile);
    if (fs.existsSync(segPath)) {
      playlist += "#EXTINF:1.0,\n";
      playlist += segFile + "\n";
    }
  }

  // 直播流不加 #EXT-X-ENDLIST

  // 原子寫入：先寫臨時文件再重命名，防止播放器讀到半成品
  const tmpPath = playlistPath + ".tmp";
  fs.writeFileSync(tmpPath, playlist);
  fs.renameSync(tmpPath, playlistPath);
}

/**
 * 清理舊的分片文件（超出窗口大小）
 */
function cleanupOldSegments(outputDir, currentSegmentIndex, windowSize) {
  const keepFromIdx = Math.max(0, currentSegmentIndex - windowSize);
  try {
    const files = fs.readdirSync(outputDir);
    for (const f of files) {
      const match = f.match(/^segment_(\d+)\.ts$/);
      if (match) {
        const idx = parseInt(match[1], 10);
        if (idx < keepFromIdx) {
          fs.removeSync(path.join(outputDir, f));
        }
      }
    }
  } catch {}
}

/**
 * 獲取直播流的 InputGroupCall 對象
 */
function makeInputCall(callInfo) {
  return new Api.InputGroupCall({
    id: bigInt(callInfo.id),
    accessHash: bigInt(callInfo.accessHash)
  });
}

/**
 * 生成隨機的 SSRC（32-bit 無符號整數，避開 0）
 */
function generateSSRC() {
  return Math.floor(Math.random() * 0xFFFFFFFE) + 1;
}

/**
 * 構造 JoinGroupCall 所需的 JSON params（模擬 WebRTC SDP offer）
 * 必須包含唯一的 ufrag 和 SSRC，否則 Telegram 返回 GROUPCALL_SSRC_DUPLICATE_MUCH
 */
function buildJoinParams() {
  const ssrc = generateSSRC();
  const ufrag = Math.random().toString(36).substring(2, 12);
  const fingerprint = Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 16).toString(16).toUpperCase()
  ).join(":");

  const params = {
    fingerprints: [
      {
        hash: "sha-256",
        setup: "active",
        fingerprint
      }
    ],
    ufrag,
    ssrc,
    "ssrc-groups": [],
    ice: "udp",
    policies: [],
    nonce: ""
  };

  return JSON.stringify(params);
}

/**
 * 以聽眾身份加入群組通話（帶 15 秒超時保護）
 * Telegram 要求先 JoinGroupCall 才能調用 GetGroupCallStreamChannels 和下載分片
 * 注意：JoinGroupCall 在用戶主 DC 上調用（不傳 DC 參數）
 * @returns {Promise<{joined: boolean, selfSource: bigInt|null, error: string|null}>}
 */
async function joinGroupCall(client, inputCall) {
  try {
    const result = await withTimeout(
      client.invoke(
        new Api.phone.JoinGroupCall({
          call: inputCall,
          joinAs: new Api.InputPeerSelf(),
          muted: true,
          videoStopped: true,
          params: new Api.DataJSON({
            data: buildJoinParams()
          })
        }),
        undefined,
        1 // retries=1：限制最多 2 次嘗試
      ),
      15000, // 15 秒超時
      "JOIN_CALL_TIMEOUT"
    );

    // 從 Updates 中提取自己的 source ID（用於後續 LeaveGroupCall）
    let selfSource = null;
    if (result?.updates) {
      for (const update of result.updates) {
        if (update?.className === "UpdateGroupCallParticipants" && update?.participants) {
          for (const p of update.participants) {
            if (p?.source != null) {
              selfSource = p.source;
              break;
            }
          }
        }
      }
    }

    console.log(`[liveStreamRelay] Joined group call as listener (source=${selfSource?.toString() || "unknown"})`);
    return { joined: true, selfSource, error: null };
  } catch (err) {
    const errMsg = err.message || String(err);
    if (/JOIN_CALL_TIMEOUT/i.test(errMsg)) {
      console.error("[liveStreamRelay] joinGroupCall timed out");
      return { joined: false, selfSource: null, error: "加入通話超時，網絡連接不穩定" };
    }
    if (/already.*join|JOIN_ALREADY/i.test(errMsg)) {
      console.log("[liveStreamRelay] Already joined group call, continuing...");
      return { joined: true, selfSource: null, error: null };
    }
    console.error("[liveStreamRelay] joinGroupCall error:", errMsg);
    return { joined: false, selfSource: null, error: errMsg };
  }
}

/**
 * 離開群組通話
 */
async function leaveGroupCall(client, inputCall, selfSource) {
  if (selfSource == null) return;
  try {
    await client.invoke(
      new Api.phone.LeaveGroupCall({
        call: inputCall,
        source: selfSource
      })
    );
    console.log("[liveStreamRelay] Left group call");
  } catch (err) {
    console.log("[liveStreamRelay] leaveGroupCall (non-critical):", err.message || String(err));
  }
}

/**
 * 啟動直播流轉發會話
 *
 * 正確流程：
 * 1. JoinGroupCall — 加入通話（前置條件）
 * 2. GetGroupCallStreamChannels — 獲取頻道（單次，不重試）
 * 3. 下載分片循環（剝離 Telegram 頭部後餵給 ffmpeg）
 */
async function startRelay(sessionId, client, callInfo, onStatus) {
  if (activeRelays.has(sessionId)) {
    const existing = activeRelays.get(sessionId);
    existing.lastViewerAt = Date.now();
    return existing;
  }

  if (activeRelays.size >= MAX_CONCURRENT_RELAYS) {
    throw new Error("已達到最大並發直播轉發數限制");
  }

  const hasFfmpeg = await checkFfmpeg();
  if (!hasFfmpeg) {
    throw new Error("服務器未安裝 ffmpeg，無法轉發直播流。請在 fnOS 上安裝 ffmpeg 後重試。");
  }

  const outputDir = await ensureHlsDir(sessionId);
  const inputCall = makeInputCall(callInfo);
  const streamDcId = callInfo.streamDcId || 0;

  console.log(`[liveStreamRelay] Starting relay for session ${sessionId}, callId=${callInfo.id}, streamDcId=${streamDcId}`);

  if (!streamDcId) {
    throw new Error("該群組通話尚未進入流模式。Telegram 僅在參與者超過一定數量或使用 RTMP 直播模式時才會啟用流模式。小型群組通話目前無法在應用內播放，請使用複製連結方式在 Telegram 客戶端中觀看。");
  }

  // ★ 步驟 1：以聽眾身份加入群組通話（必須在獲取頻道之前）
  console.log("[liveStreamRelay] Step 1: Joining group call as listener...");
  const joinResult = await joinGroupCall(client, inputCall);
  if (!joinResult.joined) {
    throw new Error(`無法加入群組通話：${joinResult.error}。請確保您有權限加入此直播。`);
  }
  const callSelfSource = joinResult.selfSource;
  let hasLeftCall = false;

  // ★ 步驟 2：獲取流頻道信息（GramJS retries=1）
  // 等待 5 秒冷卻，避免 JoinGroupCall 後立即調用導致 flood wait
  console.log("[liveStreamRelay] Step 2: Waiting 5s cooldown before fetching stream channels...");
  await new Promise((r) => setTimeout(r, 5000));

  let channels = await getStreamChannels(client, inputCall, streamDcId);

  // 如果是 flood wait，等待 Telegram 指定的時間後重試一次
  if (channels?._floodWait) {
    const waitMs = channels._floodWait;
    console.log(`[liveStreamRelay] GetGroupCallStreamChannels flood wait, sleeping ${waitMs}ms before retry...`);
    await new Promise((r) => setTimeout(r, waitMs + 500));
    channels = await getStreamChannels(client, inputCall, streamDcId);
  }

  let videoChannel = 1;
  let lastTimestampMs = 0;

  if (channels && !channels._floodWait) {
    videoChannel = channels.channel;
    lastTimestampMs = adjustBootstrapTimestamp(channels.lastTimestampMs);
    console.log(`[liveStreamRelay] Got channels: videoChannel=${videoChannel}, lastTimestampMs=${channels.lastTimestampMs}, bootstrapTs=${lastTimestampMs}`);
  } else {
    throw new Error("無法獲取直播流頻道信息。該群組可能使用的是 WebRTC 視頻通話而非 RTMP 直播，目前不支持應用內播放。");
  }

  let stopped = false;
  let consecutiveFailures = 0;
  let consecutiveFloodWaits = 0;
  let segmentIndex = 0;

  const relay = {
    sessionId,
    outputDir,
    hlsPath: path.join(outputDir, "stream.m3u8"),
    startedAt: Date.now(),
    lastViewerAt: Date.now(),
    lastChunkAt: 0,
    chunkCount: 0,
    status: "starting",
    errorMessage: null,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      relay.status = "stopped";
      if (!hasLeftCall) {
        hasLeftCall = true;
        leaveGroupCall(client, inputCall, callSelfSource).catch(() => {});
      }
      activeRelays.delete(sessionId);
      setTimeout(async () => {
        await fs.remove(outputDir).catch(() => {});
      }, 5000);
      onStatus?.("stopped");
    }
  };

  activeRelays.set(sessionId, relay);

  // ★ 新會話開始前重置全局狀態
  headerDebugDone = false;
  h264DebugDone = false;
  cachedSps = null;
  cachedPps = null;

  console.log(`[liveStreamRelay] Stream params (per-chunk mode): videoChannel=${videoChannel}, bootstrapTs=${lastTimestampMs}, segmentDurationMs=${SEGMENT_DURATION_MS}`);

  const startupTimer = setTimeout(() => {
    if (relay.status === "starting" && relay.chunkCount === 0) {
      console.error("[liveStreamRelay] Startup timeout - no chunks received in 30s");
      relay.status = "error";
      relay.errorMessage = "啟動超時：30 秒內未收到任何視頻數據。可能是 DC 路由問題或直播流不可用。";
      relay.stop();
    }
  }, STARTUP_TIMEOUT);

  // ★ 步驟 3：主循環 — 逐片下載、獨立處理、生成 HLS 分片
  (async () => {
    while (!stopped) {
      if (Date.now() - relay.lastViewerAt > RELAY_IDLE_TIMEOUT) {
        console.log("[liveStreamRelay] idle timeout, stopping relay");
        relay.stop();
        break;
      }

      const loopStart = Date.now();
      console.log(`[liveStreamRelay] loop: requesting chunk ts=${lastTimestampMs}`);

      const { data: rawChunk, error: chunkError, floodWaitMs } = await downloadStreamChunk(
        client, inputCall, lastTimestampMs, videoChannel, streamDcId
      );

      const loopElapsed = Date.now() - loopStart;
      console.log(`[liveStreamRelay] loop: chunk result ts=${lastTimestampMs}, size=${rawChunk?.length || 0}, error=${chunkError || 'none'}, elapsed=${loopElapsed}ms`);

      if (rawChunk && rawChunk.length > 0) {
        consecutiveFailures = 0;
        consecutiveFloodWaits = 0;
        relay.chunkCount++;

        if (relay.chunkCount === 1) {
          clearTimeout(startupTimer);
          relay.status = "running";
          console.log(`[liveStreamRelay] First chunk received: ${rawChunk.length} bytes (raw), status=running`);
        }

        // ★ 剝離 Telegram 頭 → 提取 H.264 → 注入 SPS/PPS → 逐片轉碼
        const mp4Data = stripTelegramHeader(rawChunk);
        const h264Data = extractH264AnnexB(mp4Data);

        if (h264Data.length > 0) {
          // 為每個 chunk 注入快取的 SPS/PPS（逐片處理必需）
          const preparedData = prepareChunkForFfmpeg(h264Data);

          // 獨立調用 ffmpeg 處理這一 chunk → 輸出一個 .ts 分片
          const result = await processChunkToSegment(preparedData, segmentIndex, outputDir);

          if (result.success) {
            segmentIndex++;
            // 更新 HLS 播放列表
            updateHlsPlaylist(outputDir, segmentIndex, 10);
            // 清理舊分片
            cleanupOldSegments(outputDir, segmentIndex - 1, 15);

            if (relay.chunkCount <= 3 || relay.chunkCount % 10 === 0) {
              console.log(`[liveStreamRelay] Chunk #${relay.chunkCount} → segment #${segmentIndex - 1} OK (h264=${h264Data.length} bytes)`);
            }
          } else {
            console.log(`[liveStreamRelay] Chunk #${relay.chunkCount} processing failed, skipping`);
          }
        }

        relay.lastChunkAt = Date.now();
        lastTimestampMs += SEGMENT_DURATION_MS;
      } else {
        if (chunkError === "TIME_TOO_BIG") {
          consecutiveFailures = 0;
          // 時間戳太超前（實際是服務器緩衝窗口已過期），快速前進 2 秒追趕
          const oldTs = lastTimestampMs;
          lastTimestampMs += SEGMENT_DURATION_MS * 2;
          console.log(`[liveStreamRelay] TIME_TOO_BIG, fast-forward +2s (${oldTs} -> ${lastTimestampMs})`);
          continue;
        }

        if (chunkError === "TIME_TOO_SMALL" || chunkError === "TIME_INVALID") {
          // 時間戳落後：快速前進 10 秒（原為 5 秒），加速追趕直播流
          const oldTs = lastTimestampMs;
          lastTimestampMs += SEGMENT_DURATION_MS * 10;
          console.log(`[liveStreamRelay] Time too small/invalid, fast-forwarding +10s (${oldTs} -> ${lastTimestampMs})`);
          continue;
        }

        if (chunkError === "GROUPCALL_INVALID") {
          relay.status = "error";
          relay.errorMessage = "直播已結束或通話無效";
          relay.stop();
          break;
        }

        if (chunkError === "DISCONNECTED") {
          consecutiveFailures = 0;
          // 連接斷開：等待 GramJS 自動重連，同時補償時間戳
          console.log(`[liveStreamRelay] Connection dropped, waiting ${DISCONNECT_WAIT_MS}ms for reconnect...`);
          await new Promise((r) => setTimeout(r, DISCONNECT_WAIT_MS));
          // 補償等待期間流逝的時間（避免時間戳嚴重落後）
          const oldTs = lastTimestampMs;
          lastTimestampMs += DISCONNECT_WAIT_MS;
          console.log(`[liveStreamRelay] Reconnect wait done, timestamp compensated (${oldTs} -> ${lastTimestampMs})`);
          continue;
        }

        if (chunkError === "FLOOD_WAIT") {
          consecutiveFloodWaits++;
          const telegramWaitMs = floodWaitMs || 0;
          const waitMs = telegramWaitMs > 0 ? telegramWaitMs + 500 : Math.min(1000 * Math.pow(2, consecutiveFloodWaits), 10000);
          console.log(`[liveStreamRelay] Flood wait, backing off ${waitMs}ms (count=${consecutiveFloodWaits})`);
          // 補償等待時間：等待期間直播流繼續播放，時間戳必須同步前進
          const oldTs = lastTimestampMs;
          lastTimestampMs += waitMs;
          console.log(`[liveStreamRelay] Flood wait time compensated (${oldTs} -> ${lastTimestampMs})`);
          if (consecutiveFloodWaits >= 3) {
            console.log(`[liveStreamRelay] Entering rate limit cooldown for ${RATE_LIMIT_COOLDOWN}ms...`);
            await new Promise((r) => setTimeout(r, RATE_LIMIT_COOLDOWN));
            // 補償冷卻期間流逝的時間
            lastTimestampMs += RATE_LIMIT_COOLDOWN;
            console.log(`[liveStreamRelay] Cooldown time compensated (${lastTimestampMs - RATE_LIMIT_COOLDOWN} -> ${lastTimestampMs})`);
            consecutiveFloodWaits = 0;
            continue;
          }
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }

        consecutiveFailures++;
        // 每次失敗都記錄（方便診斷），但限制頻率
        if (consecutiveFailures <= 5 || consecutiveFailures % 5 === 0) {
          console.log(`[liveStreamRelay] Chunk download failed (timeMs=${lastTimestampMs}, error=${chunkError}, count=${consecutiveFailures})`);
        }
        if (consecutiveFailures > 20) {
          console.error("[liveStreamRelay] too many consecutive failures, stopping");
          relay.status = "error";
          relay.errorMessage = `連續 20 次下載分片失敗（${chunkError}），直播流可能已結束`;
          relay.stop();
          break;
        }
      }

      await new Promise((r) => setTimeout(r, CHUNK_POLL_INTERVAL));
    }
  })().catch((err) => {
    console.error("[liveStreamRelay] relay loop error:", err);
    relay.status = "error";
    relay.errorMessage = err.message;
    relay.stop();
  });

  return relay;
}

/**
 * 更新會話的最後觀看時間（心跳）
 */
function touchRelay(sessionId) {
  const relay = activeRelays.get(sessionId);
  if (relay) {
    relay.lastViewerAt = Date.now();
    return true;
  }
  return false;
}

/**
 * 停止直播流轉發會話
 */
async function stopRelay(sessionId) {
  const relay = activeRelays.get(sessionId);
  if (relay) {
    await relay.stop();
    return true;
  }
  return false;
}

/**
 * 獲取所有活躍的轉發會話
 */
function listActiveRelays() {
  return Array.from(activeRelays.values()).map((r) => ({
    sessionId: r.sessionId,
    status: r.status,
    errorMessage: r.errorMessage,
    startedAt: r.startedAt,
    chunkCount: r.chunkCount,
    streamReady: fs.existsSync(r.hlsPath)
  }));
}

/**
 * 獲取單個會話的詳細狀態（包含錯誤信息）
 */
function getRelayStatus(sessionId) {
  const relay = activeRelays.get(sessionId);
  if (!relay) return null;
  return {
    sessionId: relay.sessionId,
    status: relay.status,
    errorMessage: relay.errorMessage,
    startedAt: relay.startedAt,
    chunkCount: relay.chunkCount,
    ready: fs.existsSync(relay.hlsPath)
  };
}

/**
 * 檢查 HLS playlist 是否已就緒
 */
async function isPlaylistReady(sessionId) {
  const relay = activeRelays.get(sessionId);
  if (!relay) return false;
  return fs.existsSync(relay.hlsPath);
}

/**
 * 獲取 HLS 文件路徑
 */
function getHlsFilePath(sessionId, filename) {
  return path.join(HLS_BASE_DIR, sessionId, filename);
}

/**
 * 清理所有轉發會話
 */
async function cleanupAllRelays() {
  const promises = [];
  for (const relay of activeRelays.values()) {
    promises.push(relay.stop());
  }
  await Promise.all(promises);
  activeRelays.clear();
}

// 定期清理無觀眾的會話 + 僵死檢測
setInterval(() => {
  const now = Date.now();
  for (const [id, relay] of activeRelays) {
    // 1. 無觀眾超時
    if (now - relay.lastViewerAt > RELAY_IDLE_TIMEOUT && relay.status === "running") {
      console.log(`[liveStreamRelay] auto-stopping idle relay: ${id}`);
      relay.stop();
      continue;
    }
    // 2. 僵死檢測：running 狀態下超過 30 秒沒有成功下載 chunk，認為主循環卡住
    if (relay.status === "running" && relay.lastChunkAt > 0 && now - relay.lastChunkAt > 30_000) {
      console.error(`[liveStreamRelay] relay appears dead (no chunk for ${Math.round((now - relay.lastChunkAt) / 1000)}s), stopping: ${id}`);
      relay.errorMessage = relay.errorMessage || "直播流中斷：連接不穩定導致下載卡住";
      relay.stop();
    }
  }
}, 15_000);

module.exports = {
  startRelay,
  stopRelay,
  touchRelay,
  listActiveRelays,
  getRelayStatus,
  isPlaylistReady,
  getHlsFilePath,
  cleanupAllRelays,
  checkFfmpeg,
  HLS_BASE_DIR
};
