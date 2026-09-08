'use client';
import { useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track } from 'livekit-client';
import { api, Channel } from '@/lib/api';

export default function Player() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [slug, setSlug] = useState('office');
  const [connected, setConnected] = useState(false);
  const [volume, setVolume] = useState(80);
  const audioHost = useRef<HTMLDivElement>(null);
  const roomRef = useRef<Room | null>(null);

  useEffect(() => {
    api<Channel[]>('/api/channels').then(c => {
      setChannels(c);
      if (c[0]) setSlug(c[0].slug);
    });
    return () => {
      roomRef.current?.disconnect();
    };
  }, []);

  async function connect() {
    roomRef.current?.disconnect();
    if (audioHost.current) audioHost.current.innerHTML = '';
    const tk = await api<{ token: string; url: string }>('/api/livekit/token', {
      method: 'POST',
      body: JSON.stringify({
        room: slug,
        identity: `player-${crypto.randomUUID()}`,
        name: 'Web Player',
        role: 'listener',
      }),
    });
    const room = new Room({ adaptiveStream: true });
    roomRef.current = room;
    room.on(RoomEvent.TrackSubscribed, track => {
      if (track.kind === Track.Kind.Audio) {
        const el = track.attach();
        el.autoplay = true;
        el.volume = volume / 100;
        el.controls = false;
        audioHost.current?.appendChild(el);
      }
    });
    room.on(RoomEvent.Disconnected, () => setConnected(false));
    await room.connect(tk.url || process.env.NEXT_PUBLIC_LIVEKIT_URL!, tk.token);
    setConnected(true);
  }

  function vol(v: number) {
    setVolume(v);
    audioHost.current?.querySelectorAll('audio').forEach(a => (a.volume = v / 100));
  }

  return (
    <div className="studio">
      <div className="center">
        <div className="title">Always-On Player</div>
        <div className="sub">Subscribe a browser, STB or kiosk to a channel.</div>
      </div>
      <div className="card" style={{ marginTop: 20 }}>
        <div className="field">
          <label>Channel</label>
          <select value={slug} onChange={e => setSlug(e.target.value)}>
            {channels.map(c => (
              <option key={c.id} value={c.slug}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="liveOrb">{connected ? '🔊' : '○'}</div>
        <div className="center">
          <div className={connected ? 'status-online' : 'status-offline'}>
            {connected ? 'Connected and listening' : 'Not connected'}
          </div>
        </div>
        <div className="field" style={{ marginTop: 20 }}>
          <label>Volume {volume}%</label>
          <input
            type="range"
            min="0"
            max="100"
            value={volume}
            onChange={e => vol(Number(e.target.value))}
          />
        </div>
        <div className="center" style={{ marginTop: 20 }}>
          <button className="btn" onClick={connect}>
            {connected ? 'Reconnect' : 'Connect player'}
          </button>
        </div>
        <div ref={audioHost} />
      </div>
    </div>
  );
}
