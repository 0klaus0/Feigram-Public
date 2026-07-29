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

const { execFile } = require("child_process");
const { promisify } = require("util");
const { spawn } = require("child_process");
const fs = require("fs-extra");
const path = require("path");
const { Api } = require("telegram");
const bigInt = require("big-integer");
const { dataDir } = require("./store");

const execFileAsync = promisify(execFile);

const HLS_BASE_DIR = path.join(dataDir, "live-hls");
const SEGMENT_DURATION = 2; // 秒（HLS 分片時長）
const WINDOW_SIZE = 6; // 保留 6 個分片
const MAX_CONCURRENT_RELAYS = 3;
const RELAY_IDLE_TIMEOUT = 60_000; // 無觀眾 60 秒後停止
const CHUNK_POLL_INTERVAL = 200; // ms
const STARTUP_TIMEOUT = 30_000; // 啟動超時 30 秒

// 直播流分片下載常量（來自 TGTV 參考實現 / 官方客戶端）
const SEGMENT_DURATION_MS = 1000; // 1 秒分片
const SEGMENT_BUFFER_MS = 2000; // 時間戳緩衝 2 秒
const GET_FILE_LIMIT = 128 * 1024; // 128KB（官方客戶端使用的值）
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
 * 獲取直播流頻道信息（單次調用，不重試）
 * 必須在 JoinGroupCall 之後調用，否則返回 GROUPCALL_JOIN_MISSING
 * @param {number} streamDcId - 流媒體所在的 DC ID（來自 GetGroupCall 的 stream_dc_id）
 */
async function getStreamChannels(client, inputCall, streamDcId) {
  try {
    const result = await client.invoke(
      new Api.phone.GetGroupCallStreamChannels({ call: inputCall }),
      streamDcId || undefined
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
    console.error("[liveStreamRelay] getStreamChannels error:", errMsg);
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
    const result = await client.invoke(
      new Api.upload.GetFile({
        location,
        offset: bigInt(0),
        limit: GET_FILE_LIMIT,
        precise: false
      }),
      streamDcId || undefined
    );
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
    if (/FLOOD_WAIT/i.test(errMsg)) {
      return { data: null, error: "FLOOD_WAIT" };
    }
    console.error(`[liveStreamRelay] downloadStreamChunk error (timeMs=${timeMs}):`, errMsg);
    return { data: null, error: errMsg };
  }
}

/**
 * 啟動 ffmpeg 進程，將輸入文件轉為 HLS 輸出
 *
 * 策略變更：不再使用 pipe:0 管道輸入，因為 ffmpeg 的 MP4 解復用器需要 seek 來解析 moov atom，
 * 而管道不支持 seek。改為寫入臨時文件，然後通過 tail -F 持續跟蹤文件增長並管道傳給 ffmpeg。
 * 這樣 ffmpeg 在啟動時可以從文件讀取完整的 init segment（ftyp + moov），後續通過 tail -F 持續接收新數據。
 */
function spawnFfmpeg(outputDir, inputFile) {
  const playlistPath = path.join(outputDir, "stream.m3u8");
  const segmentPattern = path.join(outputDir, "seg_%04d.ts");

  // 使用 tail -F 跟蹤增長中的文件，並管道給 ffmpeg
  // tail -c +1 從頭開始，-F 跟蹤文件（即使被刪除重建也會繼續跟蹤）
  const tail = spawn("tail", ["-c", "+1", "-F", inputFile], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  const args = [
    "-y",
    "-fflags", "+genpts+nobuffer",
    "-flags", "low_delay",
    "-f", "mp4",              // 輸入格式：fragmented MP4
    "-i", "pipe:0",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-tune", "zerolatency",
    "-profile:v", "baseline",
    "-level", "3.1",
    "-g", String(SEGMENT_DURATION * 30),
    "-bf", "0",
    "-b:v", "800k",
    "-maxrate", "1000k",
    "-bufsize", "1600k",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ac", "2",
    "-ar", "44100",
    "-f", "hls",
    "-hls_time", String(SEGMENT_DURATION),
    "-hls_list_size", String(WINDOW_SIZE),
    "-hls_flags", "delete_segments+append_list+omit_endlist",
    "-hls_segment_filename", segmentPattern,
    playlistPath
  ];

  const ffmpeg = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });

  tail.stdout.pipe(ffmpeg.stdin);

  // 將 tail 的 stdout 管道到 ffmpeg 的 stdin
  tail.stdout.pipe(ffmpeg.stdin);

  let stderrBuffer = "";
  ffmpeg.stderr.on("data", (data) => {
    const text = data.toString();
    stderrBuffer += text;
    const lines = text.trim().split("\n");
    for (const line of lines) {
      if (/error|warning|invalid|failed|no such|cannot/i.test(line)) {
        console.error("[ffmpeg]", line.trim());
      }
    }
  });

  ffmpeg.on("exit", (code, signal) => {
    console.log(`[liveStreamRelay] ffmpeg exited: code=${code} signal=${signal}`);
    if (code !== 0 && code !== null) {
      const tail = stderrBuffer.slice(-500);
      console.error("[liveStreamRelay] ffmpeg last stderr:", tail);
    }
  });

  tail.on("exit", (code, signal) => {
    console.log(`[liveStreamRelay] tail exited: code=${code} signal=${signal}`);
  });

  tail.stderr.on("data", (data) => {
    console.log("[liveStreamRelay] tail stderr:", data.toString().trim());
  });

  return { ffmpeg, tail };
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
 * 以聽眾身份加入群組通話
 * Telegram 要求先 JoinGroupCall 才能調用 GetGroupCallStreamChannels 和下載分片
 * 注意：JoinGroupCall 在用戶主 DC 上調用（不傳 DC 參數）
 * @returns {Promise<{joined: boolean, selfSource: bigInt|null, error: string|null}>}
 */
async function joinGroupCall(client, inputCall) {
  try {
    const result = await client.invoke(
      new Api.phone.JoinGroupCall({
        call: inputCall,
        joinAs: new Api.InputPeerSelf(),
        muted: true,
        videoStopped: true,
        params: new Api.DataJSON({
          data: buildJoinParams()
        })
      })
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

  // ★ 步驟 2：獲取流頻道信息（單次調用，不重試）
  console.log("[liveStreamRelay] Step 2: Fetching stream channels...");
  const channels = await getStreamChannels(client, inputCall, streamDcId);

  let videoChannel = 1;
  let lastTimestampMs = 0;

  if (channels) {
    videoChannel = channels.channel;
    lastTimestampMs = adjustBootstrapTimestamp(channels.lastTimestampMs);
    console.log(`[liveStreamRelay] Got channels: videoChannel=${videoChannel}, lastTimestampMs=${channels.lastTimestampMs}, bootstrapTs=${lastTimestampMs}`);
  } else {
    console.log("[liveStreamRelay] GetGroupCallStreamChannels failed, using fallback defaults (videoChannel=1, ts=0)");
  }

  let stopped = false;
  let consecutiveFailures = 0;
  let consecutiveFloodWaits = 0;

  const relay = {
    sessionId,
    outputDir,
    playlistPath: path.join(outputDir, "stream.m3u8"),
    inputFile: path.join(outputDir, "input.mp4"),
    ffmpeg: null,
    tail: null,
    startedAt: Date.now(),
    lastViewerAt: Date.now(),
    chunkCount: 0,
    status: "starting",
    errorMessage: null,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      relay.status = "stopped";
      try { relay.tail?.kill("SIGTERM"); } catch {}
      try { relay.ffmpeg?.stdin?.end(); } catch {}
      setTimeout(() => {
        try { relay.ffmpeg?.kill("SIGKILL"); } catch {}
        try { relay.tail?.kill("SIGKILL"); } catch {}
      }, 2000);
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

  // 先初始化空的 input 文件（tail -F 需要文件存在才能開始跟蹤）
  await fs.writeFile(relay.inputFile, "");

  // 啟動 tail + ffmpeg（tail -F 跟蹤文件增長，ffmpeg 從管道讀取）
  console.log("[liveStreamRelay] Spawning tail + ffmpeg...");
  const { ffmpeg, tail } = spawnFfmpeg(outputDir, relay.inputFile);
  relay.ffmpeg = ffmpeg;
  relay.tail = tail;

  // ★ 關鍵：處理 ffmpeg stdin 的 EPIPE 錯誤，防止服務器崩潰
  relay.ffmpeg.stdin.on("error", (err) => {
    if (err.code === "EPIPE") {
      console.log("[liveStreamRelay] ffmpeg stdin EPIPE (ffmpeg exited), stopping gracefully...");
    } else {
      console.error("[liveStreamRelay] ffmpeg stdin error:", err.message);
    }
    // 不讓錯誤冒泡到 process 級別
  });

  console.log(`[liveStreamRelay] Stream params: scale=0(fixed), videoChannel=${videoChannel}, bootstrapTs=${lastTimestampMs}, segmentDurationMs=${SEGMENT_DURATION_MS}`);

  relay.ffmpeg.on("exit", (code, signal) => {
    if (!stopped) {
      relay.status = "error";
      relay.errorMessage = `ffmpeg 異常退出 (code=${code})`;
      onStatus?.("ffmpeg_exited");
    }
    activeRelays.delete(sessionId);
  });

  const startupTimer = setTimeout(() => {
    if (relay.status === "starting" && relay.chunkCount === 0) {
      console.error("[liveStreamRelay] Startup timeout - no chunks received in 30s");
      relay.status = "error";
      relay.errorMessage = "啟動超時：30 秒內未收到任何視頻數據。可能是 DC 路由問題或直播流不可用。";
      relay.stop();
    }
  }, STARTUP_TIMEOUT);

  // ★ 步驟 3：主循環 — 持續下載分片、剝離頭部、寫入 ffmpeg
  (async () => {
    while (!stopped) {
      if (Date.now() - relay.lastViewerAt > RELAY_IDLE_TIMEOUT) {
        console.log("[liveStreamRelay] idle timeout, stopping relay");
        relay.stop();
        break;
      }

      if (relay.ffmpeg.exitCode !== null || relay.ffmpeg.signalCode) {
        console.log("[liveStreamRelay] ffmpeg dead, stopping loop");
        relay.status = "error";
        relay.errorMessage = relay.errorMessage || "ffmpeg 進程已退出";
        break;
      }

      const { data: rawChunk, error: chunkError } = await downloadStreamChunk(
        client, inputCall, lastTimestampMs, videoChannel, streamDcId
      );

      if (rawChunk && rawChunk.length > 0) {
        consecutiveFailures = 0;
        consecutiveFloodWaits = 0;
        relay.chunkCount++;

        if (relay.chunkCount === 1) {
          clearTimeout(startupTimer);
          relay.status = "running";
          console.log(`[liveStreamRelay] First chunk received: ${rawChunk.length} bytes (raw), status=running`);
        }

        // ★ 關鍵：剝離 Telegram 自定義頭，提取純 MP4 媒體數據
        const mediaData = stripTelegramHeader(rawChunk);

        if (mediaData.length > 0) {
          try {
            // 寫入 input 文件（tail -F 會自動跟蹤並管道給 ffmpeg）
            await fs.appendFile(relay.inputFile, mediaData);
          } catch (writeErr) {
            console.error("[liveStreamRelay] file write error:", writeErr.message);
          }
        }

        lastTimestampMs += SEGMENT_DURATION_MS;
      } else {
        if (chunkError === "TIME_TOO_BIG") {
          consecutiveFailures = 0;
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }

        if (chunkError === "TIME_TOO_SMALL" || chunkError === "TIME_INVALID") {
          console.log("[liveStreamRelay] Time too small/invalid, re-syncing timestamp...");
          const freshChannels = await getStreamChannels(client, inputCall, streamDcId);
          if (freshChannels) {
            lastTimestampMs = adjustBootstrapTimestamp(freshChannels.lastTimestampMs);
            console.log(`[liveStreamRelay] Re-synced timestamp to ${lastTimestampMs}`);
          }
          continue;
        }

        if (chunkError === "GROUPCALL_INVALID") {
          relay.status = "error";
          relay.errorMessage = "直播已結束或通話無效";
          relay.stop();
          break;
        }

        if (chunkError === "FLOOD_WAIT") {
          consecutiveFloodWaits++;
          const waitMs = Math.min(1000 * Math.pow(2, consecutiveFloodWaits), 10000);
          console.log(`[liveStreamRelay] Flood wait, backing off ${waitMs}ms (count=${consecutiveFloodWaits})`);
          if (consecutiveFloodWaits > 5) {
            relay.status = "error";
            relay.errorMessage = "Telegram API 限流過於頻繁，請稍後再試";
            relay.stop();
            break;
          }
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }

        consecutiveFailures++;
        if (consecutiveFailures === 1) {
          console.log(`[liveStreamRelay] Chunk download failed (timeMs=${lastTimestampMs}, error=${chunkError})`);
        }
        if (consecutiveFailures > 30) {
          console.error("[liveStreamRelay] too many consecutive failures, stopping");
          relay.status = "error";
          relay.errorMessage = `連續 30 次下載分片失敗（${chunkError}），直播流可能已結束`;
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
    playlistReady: fs.existsSync(r.playlistPath)
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
    ready: fs.existsSync(relay.playlistPath)
  };
}

/**
 * 檢查 HLS playlist 是否已就緒
 */
async function isPlaylistReady(sessionId) {
  const relay = activeRelays.get(sessionId);
  if (!relay) return false;
  return fs.existsSync(relay.playlistPath);
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

// 定期清理無觀眾的會話
setInterval(() => {
  const now = Date.now();
  for (const [id, relay] of activeRelays) {
    if (now - relay.lastViewerAt > RELAY_IDLE_TIMEOUT && relay.status === "running") {
      console.log(`[liveStreamRelay] auto-stopping idle relay: ${id}`);
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
