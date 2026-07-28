/**
 * liveStreamRelay.js — Telegram 群組直播流 HLS 轉發模組
 *
 * 工作流程：
 * 1. 檢查 ffmpeg 是否可用
 * 2. 通過 phone.GetGroupCallStreamChannels 獲取直播頻道信息
 * 3. 循環使用 InputGroupCallStream + upload.GetFile 下載視頻分片
 * 4. 將分片餵給 ffmpeg，轉碼為 HLS（.m3u8 + .ts）
 * 5. 通過 Express 靜態文件提供 HLS 播放
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
const SEGMENT_DURATION = 2; // 秒
const WINDOW_SIZE = 6; // 保留 6 個分片
const MAX_CONCURRENT_RELAYS = 3;
const RELAY_IDLE_TIMEOUT = 60_000; // 無觀眾 60 秒後停止
const CHUNK_RETRY_LIMIT = 3;
const CHUNK_POLL_INTERVAL = 200; // ms
const STARTUP_TIMEOUT = 30_000; // 啟動超時 30 秒

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
 * 獲取直播流頻道信息
 * @param {number} streamDcId - 流媒體所在的 DC ID（來自 GetGroupCall 的 stream_dc_id）
 */
async function getStreamChannels(client, inputCall, streamDcId) {
  try {
    // GetGroupCallStreamChannels 必須在 stream_dc_id 指定的 DC 上調用
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

    // 取第一個頻道（通常是主視頻流）
    const channel = result.channels[0];
    return {
      channel: channel.channel,
      scale: channel.scale || 0,
      lastTimestampMs: Number(channel.lastTimestampMs || 0),
      allChannels: result.channels.map((c) => ({
        channel: c.channel,
        scale: c.scale || 0,
        lastTimestampMs: Number(c.lastTimestampMs || 0)
      }))
    };
  } catch (err) {
    console.error("[liveStreamRelay] getStreamChannels error:", err.message);
    return null;
  }
}

/**
 * 下載單個直播流分片
 * @param {number} streamDcId - 流媒體所在的 DC ID
 */
async function downloadStreamChunk(client, inputCall, timeMs, scale, videoChannel, streamDcId) {
  const location = new Api.InputGroupCallStream({
    call: inputCall,
    timeMs: bigInt(timeMs),
    scale,
    ...(videoChannel != null ? { videoChannel, videoQuality: 1 } : {})
  });

  let lastErr = null;
  for (let attempt = 0; attempt < CHUNK_RETRY_LIMIT; attempt++) {
    try {
      const result = await client.invoke(
        new Api.upload.GetFile({
          location,
          offset: bigInt(0),
          limit: 1024 * 1024, // 1MB
          precise: true
        }),
        streamDcId || undefined
      );
      if (result?.bytes?.length > 0) {
        return Buffer.from(result.bytes);
      }
      return null;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  console.error(`[liveStreamRelay] downloadStreamChunk failed (timeMs=${timeMs}):`, lastErr?.message);
  return null;
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

  // 始終記錄 ffmpeg 錯誤輸出
  let stderrBuffer = "";
  ffmpeg.stderr.on("data", (data) => {
    const text = data.toString();
    stderrBuffer += text;
    // 只記錄錯誤和警告行
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
      // 輸出最後幾行 stderr 幫助診斷
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
 * 啟動直播流轉發會話
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

  // 獲取流頻道信息（在正確的 DC 上調用）
  const channels = await getStreamChannels(client, inputCall, streamDcId);
  if (!channels) {
    throw new Error(`無法獲取直播流頻道信息（DC=${streamDcId}）。可能是 DC 路由問題或直播流暫時不可用，請稍後重試。`);
  }

  // 創建 relay 對象（在啟動 ffmpeg 之前，以便錯誤追蹤）
  let stopped = false;
  let consecutiveFailures = 0;
  let lastErrorMessage = null;

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

  let lastTimestampMs = channels.lastTimestampMs;
  const scale = channels.scale || 0;
  const videoChannel = channels.channel;
  const segmentDurationMs = Math.max(1000 >> scale, 100);

  console.log(`[liveStreamRelay] Stream params: scale=${scale}, videoChannel=${videoChannel}, lastTimestampMs=${lastTimestampMs}, segmentDurationMs=${segmentDurationMs}`);

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

  // 主循環：持續下載分片並寫入 ffmpeg
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

      const chunk = await downloadStreamChunk(client, inputCall, lastTimestampMs, scale, videoChannel, streamDcId);

      if (chunk && chunk.length > 0) {
        consecutiveFailures = 0;
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

        // 推進時間戳
        lastTimestampMs += segmentDurationMs;
      } else {
        consecutiveFailures++;
        if (consecutiveFailures === 1) {
          console.log(`[liveStreamRelay] Chunk download returned empty (timeMs=${lastTimestampMs}), attempt ${consecutiveFailures}`);
        }
        if (consecutiveFailures > 20) {
          console.error("[liveStreamRelay] too many consecutive failures, stopping");
          relay.status = "error";
          relay.errorMessage = "連續 20 次下載分片失敗，直播流可能已結束";
          relay.stop();
          break;
        }
        // 嘗試重新獲取最新的時間戳
        if (consecutiveFailures % 5 === 0) {
          console.log("[liveStreamRelay] Re-fetching stream channels for fresh timestamp...");
          const freshChannels = await getStreamChannels(client, inputCall, streamDcId);
          if (freshChannels && freshChannels.lastTimestampMs > lastTimestampMs) {
            lastTimestampMs = freshChannels.lastTimestampMs;
            console.log(`[liveStreamRelay] Updated timestamp to ${lastTimestampMs}`);
          }
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
