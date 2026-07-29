/**
 * liveStreamRelay.js — Telegram 群組直播流 HLS 轉發模組
 *
 * 正確流程（基於 TGTV / tgroupcall-dl 參考實現）：
 * 1. 檢查 ffmpeg 是否可用
 * 2. phone.JoinGroupCall — 以聽眾身份加入通話（必須在獲取頻道之前）
 * 3. phone.GetGroupCallStreamChannels — 獲取直播頻道信息（單次調用，不重試）
 * 4. upload.GetFile + InputGroupCallStream — 循環下載 1 秒視頻分片
 * 5. ffmpeg 轉碼為 HLS（.m3u8 + .ts）
 *
 * 關鍵：GetGroupCallStreamChannels 要求先 JoinGroupCall，否則返回 GROUPCALL_JOIN_MISSING
 * 參考：https://gram.js.org/ — GetGroupCallStreamChannels 錯誤表
 *       TGTV 設計文檔 — "join the group call, then poll upload.getFile"
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
  // 清空舊文件
  const existing = await fs.readdir(dir).catch(() => []);
  for (const f of existing) {
    await fs.remove(path.join(dir, f)).catch(() => {});
  }
  return dir;
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

    const channel = result.channels[0];
    return {
      channel: channel.channel,
      lastTimestampMs: Number(channel.lastTimestampMs || 0),
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
 * 啟動 ffmpeg 進程，將輸入管道轉為 HLS 輸出
 */
function spawnFfmpeg(outputDir) {
  const playlistPath = path.join(outputDir, "stream.m3u8");
  const segmentPattern = path.join(outputDir, "seg_%04d.ts");

  const args = [
    "-y",
    "-fflags", "+genpts+nobuffer",
    "-flags", "low_delay",
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

  return ffmpeg;
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
 * 3. 下載分片循環
 */
async function startRelay(sessionId, client, callInfo, onStatus) {
  // 如果已存在，返回現有會話
  if (activeRelays.has(sessionId)) {
    const existing = activeRelays.get(sessionId);
    existing.lastViewerAt = Date.now();
    return existing;
  }

  if (activeRelays.size >= MAX_CONCURRENT_RELAYS) {
    throw new Error("已達到最大並發直播轉發數限制");
  }

  // 先檢查 ffmpeg
  const hasFfmpeg = await checkFfmpeg();
  if (!hasFfmpeg) {
    throw new Error("服務器未安裝 ffmpeg，無法轉發直播流。請在 fnOS 上安裝 ffmpeg 後重試。");
  }

  const outputDir = await ensureHlsDir(sessionId);
  const inputCall = makeInputCall(callInfo);
  const streamDcId = callInfo.streamDcId || 0;

  console.log(`[liveStreamRelay] Starting relay for session ${sessionId}, callId=${callInfo.id}, streamDcId=${streamDcId}`);

  // 檢查 streamDcId：如果為 0，表示通話未進入流模式
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

  let videoChannel = 1; // 預設視頻頻道
  let lastTimestampMs = 0;

  if (channels) {
    videoChannel = channels.channel;
    lastTimestampMs = adjustBootstrapTimestamp(channels.lastTimestampMs);
    console.log(`[liveStreamRelay] Got channels: videoChannel=${videoChannel}, lastTimestampMs=${channels.lastTimestampMs}, bootstrapTs=${lastTimestampMs}`);
  } else {
    // 頻道信息獲取失敗，使用預設參數繼續嘗試
    console.log("[liveStreamRelay] GetGroupCallStreamChannels failed, using fallback defaults (videoChannel=1, ts=0)");
  }

  // 創建 relay 對象
  let stopped = false;
  let consecutiveFailures = 0;
  let consecutiveFloodWaits = 0;

  const relay = {
    sessionId,
    outputDir,
    playlistPath: path.join(outputDir, "stream.m3u8"),
    ffmpeg: null,
    startedAt: Date.now(),
    lastViewerAt: Date.now(),
    chunkCount: 0,
    status: "starting",
    errorMessage: null,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      relay.status = "stopped";
      try { relay.ffmpeg?.stdin?.end(); } catch {}
      setTimeout(() => {
        try { relay.ffmpeg?.kill("SIGKILL"); } catch {}
      }, 2000);
      // 離開群組通話（清理資源）
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

  // 啟動 ffmpeg
  console.log("[liveStreamRelay] Spawning ffmpeg...");
  relay.ffmpeg = spawnFfmpeg(outputDir);

  console.log(`[liveStreamRelay] Stream params: scale=0(fixed), videoChannel=${videoChannel}, bootstrapTs=${lastTimestampMs}, segmentDurationMs=${SEGMENT_DURATION_MS}`);

  // 處理 ffmpeg 退出
  relay.ffmpeg.on("exit", (code, signal) => {
    if (!stopped) {
      relay.status = "error";
      relay.errorMessage = `ffmpeg 異常退出 (code=${code})`;
      onStatus?.("ffmpeg_exited");
    }
    activeRelays.delete(sessionId);
  });

  // 啟動超時檢查
  const startupTimer = setTimeout(() => {
    if (relay.status === "starting" && relay.chunkCount === 0) {
      console.error("[liveStreamRelay] Startup timeout - no chunks received in 30s");
      relay.status = "error";
      relay.errorMessage = "啟動超時：30 秒內未收到任何視頻數據。可能是 DC 路由問題或直播流不可用。";
      relay.stop();
    }
  }, STARTUP_TIMEOUT);

  // ★ 步驟 3：主循環 — 持續下載分片並寫入 ffmpeg
  (async () => {
    while (!stopped) {
      // 檢查無觀眾超時
      if (Date.now() - relay.lastViewerAt > RELAY_IDLE_TIMEOUT) {
        console.log("[liveStreamRelay] idle timeout, stopping relay");
        relay.stop();
        break;
      }

      // 檢查 ffmpeg 是否還活著
      if (relay.ffmpeg.exitCode !== null || relay.ffmpeg.signalCode) {
        console.log("[liveStreamRelay] ffmpeg dead, stopping loop");
        relay.status = "error";
        relay.errorMessage = relay.errorMessage || "ffmpeg 進程已退出";
        break;
      }

      // 下載分片
      const { data: chunk, error: chunkError } = await downloadStreamChunk(
        client, inputCall, lastTimestampMs, videoChannel, streamDcId
      );

      if (chunk && chunk.length > 0) {
        consecutiveFailures = 0;
        consecutiveFloodWaits = 0;
        relay.chunkCount++;

        // 第一個分片成功，清除啟動超時
        if (relay.chunkCount === 1) {
          clearTimeout(startupTimer);
          relay.status = "running";
          console.log(`[liveStreamRelay] First chunk received: ${chunk.length} bytes, status=running`);
        }

        try {
          if (!relay.ffmpeg.stdin.destroyed) {
            relay.ffmpeg.stdin.write(chunk);
          }
        } catch (writeErr) {
          console.error("[liveStreamRelay] ffmpeg write error:", writeErr.message);
        }

        // 推進時間戳（固定 1000ms = 1 秒）
        lastTimestampMs += SEGMENT_DURATION_MS;
      } else {
        // 根據錯誤類型處理
        if (chunkError === "TIME_TOO_BIG") {
          // 分片尚未生成，正常情況，等待後重試
          consecutiveFailures = 0;
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }

        if (chunkError === "TIME_TOO_SMALL" || chunkError === "TIME_INVALID") {
          // 時間戳過舊，重新同步（單次獲取，不重試）
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
          // Flood wait：指數退避，最多等待 10 秒
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

        // 其他錯誤
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

      // 短暫等待
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
