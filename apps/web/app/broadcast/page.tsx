'use client';
import { useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, LocalTrackPublication, Track } from 'livekit-client';
import { api, Channel } from '@/lib/api';

type AudioSourceType = 'mic' | 'system' | 'file';

export default function Broadcast() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [slug, setSlug] = useState('office');
  const [live, setLive] = useState(false);
  const [level, setLevel] = useState(0);
  const [listeners, setListeners] = useState(0);
  const [sourceType, setSourceType] = useState<AudioSourceType>('mic');
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [fileName, setFileName] = useState<string>('');

  const roomRef = useRef<Room | null>(null);
  const sessionRef = useRef<string | null>(null);
  const raf = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceNodeRef = useRef<MediaStreamAudioSourceNode | MediaElementAudioSourceNode | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const customTrackPubRef = useRef<LocalTrackPublication | null>(null);
  const customMediaStreamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    api<Channel[]>('/api/channels').then(c => {
      setChannels(c);
      if (c[0]) setSlug(c[0].slug);
    });

    // Enumerate audio input devices
    if (navigator.mediaDevices?.enumerateDevices) {
      navigator.mediaDevices.enumerateDevices().then(devices => {
        const audioInputs = devices.filter(d => d.kind === 'audioinput');
        setAudioDevices(audioInputs);
        if (audioInputs[0]) setSelectedDeviceId(audioInputs[0].deviceId);
      }).catch(console.error);
    }

    return () => {
      stopBroadcastCleanup();
    };
  }, []);

  function stopBroadcastCleanup() {
    if (raf.current) cancelAnimationFrame(raf.current);
    if (audioElementRef.current) {
      audioElementRef.current.pause();
      audioElementRef.current.src = '';
    }
    if (customMediaStreamRef.current) {
      customMediaStreamRef.current.getTracks().forEach(t => t.stop());
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close().catch(() => {});
    }
    roomRef.current?.disconnect();
    roomRef.current = null;
  }

  function setupAudioMeter(mediaStreamTrack: MediaStreamTrack) {
    try {
      const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      audioContextRef.current = ctx;
      const src = ctx.createMediaStreamSource(new MediaStream([mediaStreamTrack]));
      audioSourceNodeRef.current = src;
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
    } catch (e) {
      console.error('Failed to setup audio meter:', e);
    }
  }

  async function start() {
    const ch = channels.find(c => c.slug === slug);
    if (!ch) return;

    try {
      let activeTrack: MediaStreamTrack | null = null;

      if (sourceType === 'system') {
        // Capture system / tab audio
        if (!navigator.mediaDevices?.getDisplayMedia) {
          alert('Browser Anda tidak mendukung capture audio sistem / tab.');
          return;
        }

        const displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });

        // Stop the video track as we only need audio
        displayStream.getVideoTracks().forEach(t => t.stop());

        const audioTrack = displayStream.getAudioTracks()[0];
        if (!audioTrack) {
          displayStream.getTracks().forEach(t => t.stop());
          alert('Audio sistem tidak ditemukan! Pastikan Anda mencentang "Share tab audio" atau "Share system audio" pada popup browser.');
          return;
        }

        customMediaStreamRef.current = displayStream;
        activeTrack = audioTrack;
      } else if (sourceType === 'file') {
        const file = fileInputRef.current?.files?.[0];
        if (!file) {
          alert('Silakan pilih file audio (MP3/WAV) terlebih dahulu.');
          return;
        }

        const url = URL.createObjectURL(file);
        const audio = new Audio(url);
        audio.loop = true;
        audioElementRef.current = audio;

        const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
        audioContextRef.current = ctx;
        const dest = ctx.createMediaStreamDestination();
        const src = ctx.createMediaElementSource(audio);
        src.connect(dest);
        src.connect(ctx.destination); // dengarkan di speaker lokal juga

        await audio.play();
        const audioTrack = dest.stream.getAudioTracks()[0];
        customMediaStreamRef.current = dest.stream;
        activeTrack = audioTrack;
      } else {
        // Microphone with device selection
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : true,
        });
        customMediaStreamRef.current = stream;
        activeTrack = stream.getAudioTracks()[0];
      }

      if (!activeTrack) {
        alert('Gagal mengaktifkan sumber audio.');
        return;
      }

      // Connect to LiveKit Room
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

      // Publish the active track
      const pub = await room.localParticipant.publishTrack(activeTrack, {
        name: 'audio',
        source: sourceType === 'mic' ? Track.Source.Microphone : Track.Source.ScreenShareAudio,
      });
      customTrackPubRef.current = pub;

      // Handle stream end event (e.g. user clicks Stop Sharing on browser bar)
      activeTrack.onended = () => {
        stop();
      };

      // Start visualizer audio meter
      setupAudioMeter(activeTrack);

      // Register broadcast session to database
      const s = await api<{ id: string }>('/api/sessions/start', {
        method: 'POST',
        body: JSON.stringify({ channelId: ch.id }),
      });
      sessionRef.current = s.id;
      setLive(true);
    } catch (err: unknown) {
      console.error('Error starting broadcast:', err);
      stopBroadcastCleanup();
      const message = err instanceof Error ? err.message : String(err);
      alert(`Gagal memulai broadcast: ${message}`);
    }
  }

  async function stop() {
    if (sessionRef.current) {
      try {
        await api(`/api/sessions/${sessionRef.current}/stop`, { method: 'POST' });
      } catch (e) {
        console.error('Failed to stop session:', e);
      }
    }
    stopBroadcastCleanup();
    setLive(false);
    setLevel(0);
    setListeners(0);
  }

  return (
    <div className="studio">
      <div className="center">
        <div className="title">Broadcast Studio</div>
        <div className="sub">Publish your microphone, system audio, or music file to a realtime channel.</div>
      </div>
      <div className="card" style={{ marginTop: 20 }}>
        {/* Channel Selection */}
        <div className="field">
          <label>Target Channel</label>
          <select value={slug} onChange={e => setSlug(e.target.value)} disabled={live}>
            {channels.map(c => (
              <option key={c.id} value={c.slug}>
                {c.name} · priority {c.priority}
              </option>
            ))}
          </select>
        </div>

        {/* Audio Source Selector */}
        <div className="field">
          <label>Audio Source</label>
          <select
            value={sourceType}
            onChange={e => setSourceType(e.target.value as AudioSourceType)}
            disabled={live}
          >
            <option value="mic">🎙️ Microphone / Audio Input</option>
            <option value="system">💻 Computer / Tab Audio (YouTube, Spotify, System)</option>
            <option value="file">🎵 Audio File (MP3 / WAV Player)</option>
          </select>
        </div>

        {/* Dynamic Source Sub-options */}
        {sourceType === 'mic' && audioDevices.length > 0 && (
          <div className="field">
            <label>Select Microphone / Input Device</label>
            <select
              value={selectedDeviceId}
              onChange={e => setSelectedDeviceId(e.target.value)}
              disabled={live}
            >
              {audioDevices.map(d => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Audio Device (${d.deviceId.slice(0, 8)})`}
                </option>
              ))}
            </select>
          </div>
        )}

        {sourceType === 'system' && (
          <div style={{ background: 'rgba(255,255,255,0.05)', padding: '10px 14px', borderRadius: 8, fontSize: 13, color: '#aaa', marginBottom: 16 }}>
            💡 <strong>Tips:</strong> Saat popup browser muncul, pilih <strong>Tab</strong> (misal YouTube/Spotify) atau <strong>Entire Screen</strong>, dan pastikan centang opsi <strong>"Also share tab audio" / "Share system audio"</strong>.
          </div>
        )}

        {sourceType === 'file' && (
          <div className="field">
            <label>Select Audio File (MP3 / WAV)</label>
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*"
              disabled={live}
              onChange={e => setFileName(e.target.files?.[0]?.name || '')}
            />
            {fileName && <div style={{ fontSize: 12, color: '#4ade80', marginTop: 4 }}>File: {fileName}</div>}
          </div>
        )}

        <div className="liveOrb">{live ? 'LIVE' : (sourceType === 'file' ? 'FILE' : sourceType === 'system' ? 'PC' : 'MIC')}</div>
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
