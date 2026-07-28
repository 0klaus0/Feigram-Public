/**
 * liveStreamRelay.js — Telegram 群組直播流 HLS 轉發模組
 *
 * 工作流程：
 * 1. 通過 phone.GetGroupCallStreamChannels 獲取直播頻道信息
 * 2. 循環使用 InputGroupCallStream + upload.GetFile 下載視頻分片
 * 3. 將分片餵給 ffmpeg，轉碼為 HLS（.m3u8 + .ts）
 * 4. 通過 Express 靜態文件提供 HLS 播放
 */

const { spawn } = require("child_process");
const fs = require("fs-extra");
const path = require("path");
const { Api } = require("telegram");
const bigInt = require("big-integer");
const { dataDir } = require("./store");

const HLS_BASE_DIR = path.join(dataDir, "live-hls");
const SEGMENT_DURATION = 2; // 秒
const WINDOW_SIZE = 6; // 保留 6 個分片
const MAX_CONCURRENT_RELAYS = 3;
const RELAY_IDLE_TIMEOUT = 60_000; // 無觀眾 60 秒後停止
const CHUNK_RETRY_LIMIT = 3;
const CHUNK_POLL_INTERVAL = 200; // ms

// 活躍的轉發會話
const activeRelays = new Map();

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
 * @param {TelegramClient} client - GramJS 客戶端
 * @param {object} inputCall - InputGroupCall 對象 { id, accessHash }
 * @returns {Promise<object|null>} 頻道信息
 */
async function getStreamChannels(client, inputCall) {
  try {
    const result = await client.invoke(
      new Api.phone.GetGroupCallStreamChannels({ call: inputCall })
    );
    if (!result?.channels?.length) return null;

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
 * @param {TelegramClient} client
 * @param {object} inputCall - { id, accessHash }
 * @param {number} timeMs - 時間戳（毫秒）
 * @param {number} scale - 分片大小刻度
 * @param {number} videoChannel - 視頻頻道 ID
 * @returns {Promise<Buffer|null>}
 */
async function downloadStreamChunk(client, inputCall, timeMs, scale, videoChannel) {
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
        })
      );
      if (result?.bytes?.length > 0) {
        return Buffer.from(result.bytes);
      }
      return null;
    } catch (err) {
      lastErr = err;
      // 短暫等待後重試
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  console.error(`[liveStreamRelay] downloadStreamChunk failed after ${CHUNK_RETRY_LIMIT} attempts:`, lastErr?.message);
  return null;
}

/**
 * 啟動 ffmpeg 進程，將輸入管道轉為 HLS 輸出
 * @param {string} outputDir - HLS 輸出目錄
 * @returns {import('child_process').ChildProcess}
 */
function spawnFfmpeg(outputDir) {
  const playlistPath = path.join(outputDir, "stream.m3u8");
  const segmentPattern = path.join(outputDir, "seg_%04d.ts");

  const args = [
    "-y",
    "-fflags", "+genpts",
    "-i", "pipe:0",                    // 從 stdin 讀取
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-tune", "zerolatency",
    "-profile:v", "baseline",
    "-level", "3.1",
    "-g", String(SEGMENT_DURATION * 30), // GOP = 幀率 * 秒數
    "-bf", "0",                          // 無 B 幀，降低延遲
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

  ffmpeg.stderr.on("data", (data) => {
    // 只在調試時輸出
    if (process.env.LIVE_DEBUG === "1") {
      console.error("[ffmpeg]", data.toString().trim());
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
 * @param {string} sessionId - 唯一會話 ID（用於 HLS 路徑）
 * @param {TelegramClient} client - GramJS 客戶端
 * @param {object} callInfo - { id, accessHash } 群組通話信息
 * @param {Function} onStatus - 狀態回調 (status) => void
 * @returns {Promise<object>} 會話信息
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

  const outputDir = await ensureHlsDir(sessionId);
  const inputCall = makeInputCall(callInfo);

  onStatus?.("connecting");

  // 獲取流頻道信息
  const channels = await getStreamChannels(client, inputCall);
  if (!channels) {
    throw new Error("無法獲取直播流頻道信息，直播可能已結束或未開始視頻流");
  }

  onStatus?.("starting_ffmpeg");

  const ffmpeg = spawnFfmpeg(outputDir);
  let lastTimestampMs = channels.lastTimestampMs;
  const scale = channels.scale || 0;
  const videoChannel = channels.channel;
  // scale=0 → 1000ms, scale=1 → 500ms, scale=2 → 250ms
  const segmentDurationMs = Math.max(1000 >> scale, 100);

  let stopped = false;
  let consecutiveFailures = 0;
  const relay = {
    sessionId,
    outputDir,
    playlistPath: path.join(outputDir, "stream.m3u8"),
    ffmpeg,
    startedAt: Date.now(),
    lastViewerAt: Date.now(),
    chunkCount: 0,
    status: "running",
    stop: async () => {
      if (stopped) return;
      stopped = true;
      relay.status = "stopped";
      try {
        ffmpeg.stdin?.end();
      } catch {}
      setTimeout(() => {
        try { ffmpeg.kill("SIGKILL"); } catch {}
      }, 2000);
      activeRelays.delete(sessionId);
      // 清理 HLS 文件
      setTimeout(async () => {
        await fs.remove(outputDir).catch(() => {});
      }, 5000);
      onStatus?.("stopped");
    }
  };

  activeRelays.set(sessionId, relay);

  // 處理 ffmpeg 退出
  ffmpeg.on("exit", (code, signal) => {
    if (!stopped) {
      console.log(`[liveStreamRelay] ffmpeg exited unexpectedly: code=${code} signal=${signal}`);
      relay.status = "error";
      onStatus?.("ffmpeg_exited");
    }
    activeRelays.delete(sessionId);
  });

  // 主循環：持續下載分片並寫入 ffmpeg
  onStatus?.("streaming");

  // 使用異步循環拉取分片
  (async () => {
    while (!stopped) {
      // 檢查無觀眾超時
      if (Date.now() - relay.lastViewerAt > RELAY_IDLE_TIMEOUT) {
        console.log("[liveStreamRelay] idle timeout, stopping relay");
        relay.stop();
        break;
      }

      // 檢查 ffmpeg 是否還活著
      if (ffmpeg.exitCode !== null || ffmpeg.signalCode) {
        console.log("[liveStreamRelay] ffmpeg dead, stopping loop");
        break;
      }

      const chunk = await downloadStreamChunk(client, inputCall, lastTimestampMs, scale, videoChannel);

      if (chunk && chunk.length > 0) {
        consecutiveFailures = 0;
        relay.chunkCount++;

        try {
          if (!ffmpeg.stdin.destroyed) {
            ffmpeg.stdin.write(chunk);
          }
        } catch (writeErr) {
          console.error("[liveStreamRelay] ffmpeg write error:", writeErr.message);
        }

        // 推進時間戳
        lastTimestampMs += segmentDurationMs;
      } else {
        consecutiveFailures++;
        if (consecutiveFailures > 20) {
          console.error("[liveStreamRelay] too many consecutive failures, stopping");
          relay.stop();
          break;
        }
        // 嘗試重新獲取最新的時間戳
        if (consecutiveFailures % 5 === 0) {
          const freshChannels = await getStreamChannels(client, inputCall);
          if (freshChannels && freshChannels.lastTimestampMs > lastTimestampMs) {
            lastTimestampMs = freshChannels.lastTimestampMs;
          }
        }
      }

      // 短暫等待
      await new Promise((r) => setTimeout(r, CHUNK_POLL_INTERVAL));
    }
  })().catch((err) => {
    console.error("[liveStreamRelay] relay loop error:", err);
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
    startedAt: r.startedAt,
    chunkCount: r.chunkCount,
    playlistReady: fs.existsSync(r.playlistPath)
  }));
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
  isPlaylistReady,
  getHlsFilePath,
  cleanupAllRelays,
  HLS_BASE_DIR
};
