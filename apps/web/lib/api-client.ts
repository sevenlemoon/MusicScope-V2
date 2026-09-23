const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8100";

export class ApiRequestError extends Error {
  constructor(public readonly status: number, public readonly code?: string, message?: string) {
    super(message || `MusicScope API request failed (${status})`);
    this.name = "ApiRequestError";
  }
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && typeof init.body === "string" && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    cache: "no-store",
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { detail?: string | { code?: string; message?: string } } | null;
    const detail = payload?.detail;
    throw new ApiRequestError(
      response.status,
      typeof detail === "object" ? detail.code : undefined,
      typeof detail === "object" ? detail.message : typeof detail === "string" ? detail : undefined,
    );
  }
  return response.json() as Promise<T>;
}

export function apiUrl(path: string) {
  return `${API_BASE}${path}`;
}
