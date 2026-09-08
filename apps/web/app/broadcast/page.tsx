'use client';
import { useEffect, useRef, useState } from 'react';
import { Room, RoomEvent } from 'livekit-client';
import { api, Channel } from '@/lib/api';

export default function Broadcast() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [slug, setSlug] = useState('office');
  const [live, setLive] = useState(false);
  const [level, setLevel] = useState(0);
  const [listeners, setListeners] = useState(0);
  const roomRef = useRef<Room | null>(null);
  const sessionRef = useRef<string | null>(null);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    api<Channel[]>('/api/channels').then(c => {
      setChannels(c);
      if (c[0]) setSlug(c[0].slug);
    });
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      roomRef.current?.disconnect();
    };
  }, []);

  async function start() {
    const ch = channels.find(c => c.slug === slug);
    if (!ch) return;
    const tk = await api<{ token: string; url: string }>('/api/livekit/token', {
      method: 'POST',
      body: JSON.stringify({
        room: slug,
        identity: `browser-${crypto.randomUUID()}`,
        name: 'Web Broadcaster',
        role: 'broadcaster',
      }),
    });
    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;
    room.on(RoomEvent.ParticipantConnected, () => setListeners(room.remoteParticipants.size));
    room.on(RoomEvent.ParticipantDisconnected, () => setListeners(room.remoteParticipants.size));
    await room.connect(tk.url || process.env.NEXT_PUBLIC_LIVEKIT_URL!, tk.token);
    await room.localParticipant.setMicrophoneEnabled(true);
    const pub = [...room.localParticipant.audioTrackPublications.values()][0];
    const media = pub?.track?.mediaStreamTrack;
    if (media) {
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(new MediaStream([media]));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const draw = () => {
        analyser.getByteFrequencyData(data);
        setLevel(
          Math.round(
            (data.reduce((a, b) => a + b, 0) / data.length / 255) * 100
          )
        );
        raf.current = requestAnimationFrame(draw);
      };
      draw();
    }
    const s = await api<{ id: string }>('/api/sessions/start', {
      method: 'POST',
      body: JSON.stringify({ channelId: ch.id }),
    });
    sessionRef.current = s.id;
    setLive(true);
  }

  async function stop() {
    if (raf.current) cancelAnimationFrame(raf.current);
    if (sessionRef.current) await api(`/api/sessions/${sessionRef.current}/stop`, { method: 'POST' });
    roomRef.current?.disconnect();
    roomRef.current = null;
    setLive(false);
    setLevel(0);
    setListeners(0);
  }

  return (
    <div className="studio">
      <div className="center">
        <div className="title">Broadcast Studio</div>
        <div className="sub">Publish your microphone to a realtime channel.</div>
      </div>
      <div className="card" style={{ marginTop: 20 }}>
        <div className="field">
          <label>Channel</label>
          <select value={slug} onChange={e => setSlug(e.target.value)} disabled={live}>
            {channels.map(c => (
              <option key={c.id} value={c.slug}>
                {c.name} · priority {c.priority}
              </option>
            ))}
          </select>
        </div>
        <div className="liveOrb">{live ? 'LIVE' : 'MIC'}</div>
        <div className="meter">
          <div style={{ width: `${level}%` }} />
        </div>
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 14 }}>
          <div className="sub">Audio level {level}%</div>
          <div className="sub">Listeners {listeners}</div>
        </div>
        <div className="center" style={{ marginTop: 22 }}>
          {!live ? (
            <button className="btn" onClick={start}>
              Start broadcast
            </button>
          ) : (
            <button className="btn danger" onClick={stop}>
              Stop broadcast
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
