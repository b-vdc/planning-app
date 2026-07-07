const USER_KEY = "vdv-user-id";

export function getCurrentUserId(): string | null {
  return localStorage.getItem(USER_KEY);
}

export function setCurrentUserId(id: string): void {
  localStorage.setItem(USER_KEY, id);
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const userId = getCurrentUserId();
  const res = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(userId ? { "x-user-id": userId } : {}),
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
