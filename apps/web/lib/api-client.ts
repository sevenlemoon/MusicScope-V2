const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8100";

export class ApiRequestError extends Error {
  constructor(public readonly status: number) {
    super(`MusicScope API request failed (${status})`);
    this.name = "ApiRequestError";
  }
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new ApiRequestError(response.status);
  }
  return response.json() as Promise<T>;
}
