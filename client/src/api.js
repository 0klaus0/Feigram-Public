export function getToken() {
  return localStorage.getItem("fngram.token") || "";
}

export function setToken(token) {
  localStorage.setItem("fngram.token", token);
}

export async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getToken()}`,
      ...(options.headers || {})
    }
  });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    throw new Error(payload?.error || payload || "请求失败");
  }
  return payload;
}

export async function appLogin(password) {
  const payload = await api("/api/login", {
    method: "POST",
    body: JSON.stringify(password)
  });
  setToken(payload.token);
  return payload;
}
