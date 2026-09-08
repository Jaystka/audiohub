export const API = process.env.NEXT_PUBLIC_API_URL || '';

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    cache: 'no-store',
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export type Channel = {
  id: string;
  name: string;
  slug: string;
  description: string;
  priority: number;
  isActive: boolean;
};

export type Device = {
  id: string;
  name: string;
  deviceKey: string;
  type: 'player' | 'broadcaster';
  location: string;
  status: string;
  volume: number;
  lastSeenAt?: string;
};
