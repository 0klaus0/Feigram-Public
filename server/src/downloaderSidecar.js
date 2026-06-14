const DEFAULT_URL = "http://127.0.0.1:3090";

function baseUrl() {
  return String(process.env.FEIGRAM_DOWNLOADER_URL || DEFAULT_URL).replace(/\/+$/, "");
}

async function request(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 5000);
  try {
    const response = await fetch(`${baseUrl()}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(data.error || `Go downloader ${response.status}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function safe(call) {
  try {
    return await call();
  } catch (error) {
    return {
      ok: false,
      url: baseUrl(),
      error: error.name === "AbortError" ? "Go 下载服务无响应" : error.message
    };
  }
}

function health() {
  return safe(async () => ({ ...(await request("/health")), url: baseUrl() }));
}

function state() {
  return safe(async () => ({ ...(await request("/api/state")), url: baseUrl() }));
}

function updateConfig(patch) {
  return safe(async () => request("/api/config", {
    method: "PUT",
    body: JSON.stringify(patch || {})
  }));
}

function enqueueTask(task) {
  return request("/api/tasks", {
    method: "POST",
    body: JSON.stringify(task || {})
  });
}

function listTasks() {
  return request("/api/tasks");
}

function getTask(id) {
  return request(`/api/tasks/${encodeURIComponent(id)}`);
}

function queueTask(id) {
  return request(`/api/tasks/${encodeURIComponent(id)}/queue`, {
    method: "POST"
  });
}

function cancelTask(id) {
  return request(`/api/tasks/${encodeURIComponent(id)}/cancel`, {
    method: "POST"
  });
}

function deleteTask(id) {
  return request(`/api/tasks/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
}

module.exports = {
  baseUrl,
  cancelTask,
  deleteTask,
  enqueueTask,
  getTask,
  health,
  listTasks,
  queueTask,
  state,
  updateConfig
};
