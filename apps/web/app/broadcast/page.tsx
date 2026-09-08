'use client';
import { useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, LocalTrackPublication, Track } from 'livekit-client';
import { api, Channel } from '@/lib/api';

type AudioSourceType = 'mic' | 'youtube' | 'system' | 'file';

export default function Broadcast() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [slug, setSlug] = useState('office');
  const [live, setLive] = useState(false);
  const [level, setLevel] = useState(0);
  const [listeners, setListeners] = useState(0);
  const [sourceType, setSourceType] = useState<AudioSourceType>('youtube');
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [fileName, setFileName] = useState<string>('');
  const [youtubeUrl, setYoutubeUrl] = useState<string>('https://www.youtube.com/watch?v=jfKfPfyJRdk');
  const [youtubeId, setYoutubeId] = useState<string>('jfKfPfyJRdk');

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

  function extractYouTubeId(url: string): string {
    if (!url) return '';
    const trimmed = url.trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
      return trimmed;
    }
    const match = trimmed.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|shorts\/|live\/))([\w-]{11})/);
    return match ? match[1] : '';
  }

  function handleYoutubeUrlChange(val: string) {
    setYoutubeUrl(val);
    const id = extractYouTubeId(val);
    if (id) {
      setYoutubeId(id);
    }
  }

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

      if (sourceType === 'system' || sourceType === 'youtube') {
        // Capture system / tab audio
        if (!navigator.mediaDevices?.getDisplayMedia) {
          alert('Browser Anda tidak mendukung capture audio tab / sistem.');
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
          alert('Audio tab tidak dipilih! Pastikan Anda mencentang opsi "Also share tab audio" / "Share system audio" pada popup browser.');
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
        src.connect(ctx.destination);

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

      // Handle stream end event
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
        <div className="sub">Publish YouTube audio, microphone, or music files directly to a realtime channel.</div>
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
            <option value="youtube">▶️ YouTube Streamer (Built-in Player)</option>
            <option value="system">💻 Computer / Tab Audio (Spotify, Other Tabs)</option>
            <option value="file">🎵 Audio File (MP3 / WAV Player)</option>
            <option value="mic">🎙️ Microphone / Audio Input</option>
          </select>
        </div>

        {/* YouTube Section */}
        {sourceType === 'youtube' && (
          <div style={{ marginTop: 6, marginBottom: 18 }}>
            <div className="field">
              <label>YouTube URL or Video ID</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="text"
                  placeholder="https://www.youtube.com/watch?v=..."
                  value={youtubeUrl}
                  onChange={e => handleYoutubeUrlChange(e.target.value)}
                  disabled={live}
                  style={{ flex: 1 }}
                />
              </div>
            </div>

            {/* Quick Presets */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6, marginBottom: 12 }}>
              <button
                type="button"
                className="btn"
                style={{ fontSize: 12, padding: '4px 10px', background: 'rgba(255,255,255,0.08)' }}
                onClick={() => handleYoutubeUrlChange('https://www.youtube.com/watch?v=jfKfPfyJRdk')}
              >
                ☕ Lofi Girl Radio
              </button>
              <button
                type="button"
                className="btn"
                style={{ fontSize: 12, padding: '4px 10px', background: 'rgba(255,255,255,0.08)' }}
                onClick={() => handleYoutubeUrlChange('https://www.youtube.com/watch?v=5qap5aO4i9A')}
              >
                🎧 Lofi Synthwave
              </button>
              <button
                type="button"
                className="btn"
                style={{ fontSize: 12, padding: '4px 10px', background: 'rgba(255,255,255,0.08)' }}
                onClick={() => handleYoutubeUrlChange('https://www.youtube.com/watch?v=DWcJFNfaw9c')}
              >
                🌿 Relaxing Acoustic
              </button>
            </div>

            {/* Embedded Responsive YouTube Player */}
            {youtubeId && (
              <div style={{ position: 'relative', width: '100%', paddingTop: '56.25%', borderRadius: 10, overflow: 'hidden', background: '#000', marginTop: 10, boxShadow: '0 4px 20px rgba(0,0,0,0.4)' }}>
                <iframe
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', border: 'none' }}
                  src={`https://www.youtube.com/embed/${youtubeId}?autoplay=1&enablejsapi=1`}
                  title="YouTube video player"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  allowFullScreen
                />
              </div>
            )}

            <div style={{ background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.25)', padding: '10px 14px', borderRadius: 8, fontSize: 13, color: '#93c5fd', marginTop: 12 }}>
              💡 <strong>Petunjuk Siaran YouTube:</strong>
              <ol style={{ margin: '4px 0 0 16px', padding: 0 }}>
                <li>Putar video YouTube di player di atas.</li>
                <li>Klik tombol <strong>Start broadcast</strong> di bawah.</li>
                <li>Pada popup browser, pilih <strong>Tab ini (AudioHub)</strong> dan pastikan centang <strong>"Also share tab audio"</strong>.</li>
              </ol>
            </div>
          </div>
        )}

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

        <div className="liveOrb">{live ? 'LIVE' : (sourceType === 'youtube' ? 'YT' : sourceType === 'file' ? 'FILE' : sourceType === 'system' ? 'PC' : 'MIC')}</div>
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
