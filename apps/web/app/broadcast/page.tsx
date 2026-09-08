'use client';
import { useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, LocalTrackPublication, Track } from 'livekit-client';
import { api, Channel } from '@/lib/api';

type AudioSourceType = 'youtube' | 'mic' | 'system' | 'file';

type SearchResult = {
  id: string;
  title: string;
  duration: string;
  thumbnail: string;
  uploader: string;
  url: string;
};

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
  const [selectedTitle, setSelectedTitle] = useState<string>('Lofi Girl - lofi hip hop radio');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string>('');

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

  async function handleSearch(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (!searchQuery.trim()) return;

    setSearching(true);
    try {
      const res = await api<SearchResult[]>(`/api/youtube/search?q=${encodeURIComponent(searchQuery.trim())}`);
      setSearchResults(res || []);
    } catch (err) {
      console.error('Failed to search YouTube:', err);
      alert('Gagal mencari lagu di YouTube.');
    } finally {
      setSearching(false);
    }
  }

  function selectTrack(item: SearchResult) {
    setYoutubeUrl(item.url);
    setSelectedTitle(item.title);
  }

  function stopBroadcastCleanup() {
    if (raf.current) cancelAnimationFrame(raf.current);
    if (audioElementRef.current) {
      audioElementRef.current.pause();
      audioElementRef.current.src = '';
      audioElementRef.current = null;
    }
    if (customMediaStreamRef.current) {
      customMediaStreamRef.current.getTracks().forEach(t => t.stop());
      customMediaStreamRef.current = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    roomRef.current?.disconnect();
    roomRef.current = null;
    setStatusMessage('');
  }

  function setupAudioMeter(mediaStreamTrack: MediaStreamTrack) {
    try {
      if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
        const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
        audioContextRef.current = ctx;
      }
      const ctx = audioContextRef.current;
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
      setStatusMessage('Menghubungkan sumber audio...');

      if (sourceType === 'youtube') {
        if (!youtubeUrl.trim()) {
          alert('Silakan pilih atau masukkan link YouTube terlebih dahulu.');
          return;
        }

        setStatusMessage('Mengekstrak audio YouTube...');
        const streamUrl = `/api/youtube/stream?url=${encodeURIComponent(youtubeUrl.trim())}`;
        const audio = new Audio(streamUrl);
        audio.crossOrigin = 'anonymous';
        audio.autoplay = true;
        audioElementRef.current = audio;

        const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
        if (ctx.state === 'suspended') {
          await ctx.resume();
        }
        audioContextRef.current = ctx;

        const dest = ctx.createMediaStreamDestination();
        const src = ctx.createMediaElementSource(audio);
        src.connect(dest);
        src.connect(ctx.destination);

        await audio.play();
        const audioTrack = dest.stream.getAudioTracks()[0];
        customMediaStreamRef.current = dest.stream;
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
        if (ctx.state === 'suspended') {
          await ctx.resume();
        }
        audioContextRef.current = ctx;

        const dest = ctx.createMediaStreamDestination();
        const src = ctx.createMediaElementSource(audio);
        src.connect(dest);
        src.connect(ctx.destination);

        await audio.play();
        const audioTrack = dest.stream.getAudioTracks()[0];
        customMediaStreamRef.current = dest.stream;
        activeTrack = audioTrack;
      } else if (sourceType === 'system') {
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

        displayStream.getVideoTracks().forEach(t => t.stop());

        const audioTrack = displayStream.getAudioTracks()[0];
        if (!audioTrack) {
          displayStream.getTracks().forEach(t => t.stop());
          alert('Audio tab tidak dipilih! Pastikan Anda mencentang opsi "Also share tab audio" / "Share system audio" pada popup browser.');
          return;
        }

        customMediaStreamRef.current = displayStream;
        activeTrack = audioTrack;
      } else {
        // Microphone
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

      setStatusMessage('Menghubungkan ke LiveKit Media Server...');

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
      setStatusMessage('Sedang Mengudara (Live)');
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
        <div className="sub">Cari lagu YouTube langsung, streaming musik, atau gunakan mikrofon ke realtime channel.</div>
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
            <option value="youtube">🔍 Cari & Stream YouTube (Direct - Rendah Latency)</option>
            <option value="file">🎵 Audio File (MP3 / WAV Player)</option>
            <option value="system">💻 Computer / Tab Audio (Manual Screen Share)</option>
            <option value="mic">🎙️ Microphone / Audio Input Device</option>
          </select>
        </div>

        {/* YouTube Direct Search Section */}
        {sourceType === 'youtube' && (
          <div style={{ marginTop: 6, marginBottom: 18 }}>
            {/* Search Box */}
            <form onSubmit={handleSearch} style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <input
                type="text"
                placeholder="🔍 Ketik judul lagu / artis YouTube (misal: Lofi Hip Hop, Tulus, Sheila on 7)..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                disabled={live}
                style={{ flex: 1 }}
              />
              <button
                type="submit"
                className="btn"
                disabled={searching || live}
                style={{ minWidth: 90 }}
              >
                {searching ? 'Mencari...' : 'Cari'}
              </button>
            </form>

            {/* Quick Presets */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
              <button
                type="button"
                className="btn"
                style={{ fontSize: 12, padding: '4px 10px', background: 'rgba(255,255,255,0.08)' }}
                onClick={() => {
                  setYoutubeUrl('https://www.youtube.com/watch?v=jfKfPfyJRdk');
                  setSelectedTitle('Lofi Girl - lofi hip hop radio');
                }}
                disabled={live}
              >
                ☕ Lofi Girl Radio
              </button>
              <button
                type="button"
                className="btn"
                style={{ fontSize: 12, padding: '4px 10px', background: 'rgba(255,255,255,0.08)' }}
                onClick={() => {
                  setYoutubeUrl('https://www.youtube.com/watch?v=5qap5aO4i9A');
                  setSelectedTitle('Lofi Synthwave Chill');
                }}
                disabled={live}
              >
                🎧 Synthwave Radio
              </button>
              <button
                type="button"
                className="btn"
                style={{ fontSize: 12, padding: '4px 10px', background: 'rgba(255,255,255,0.08)' }}
                onClick={() => {
                  setYoutubeUrl('https://www.youtube.com/watch?v=DWcJFNfaw9c');
                  setSelectedTitle('Relaxing Acoustic Guitar');
                }}
                disabled={live}
              >
                🌿 Relaxing Acoustic
              </button>
            </div>

            {/* Search Results List */}
            {searchResults.length > 0 && (
              <div style={{ maxHeight: 240, overflowY: 'auto', background: 'rgba(0,0,0,0.3)', borderRadius: 8, padding: 8, marginBottom: 12, border: '1px solid rgba(255,255,255,0.08)' }}>
                <div style={{ fontSize: 12, color: '#aaa', marginBottom: 6, fontWeight: 600 }}>Hasil Pencarian:</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {searchResults.map(item => {
                    const isSelected = youtubeUrl === item.url;
                    return (
                      <div
                        key={item.id}
                        onClick={() => !live && selectTrack(item)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          padding: '6px 8px',
                          borderRadius: 6,
                          background: isSelected ? 'rgba(59,130,246,0.25)' : 'rgba(255,255,255,0.03)',
                          border: isSelected ? '1px solid rgba(59,130,246,0.5)' : '1px solid transparent',
                          cursor: live ? 'not-allowed' : 'pointer',
                          transition: 'background 0.2s',
                        }}
                      >
                        {item.thumbnail ? (
                          <img src={item.thumbnail} alt={item.title} style={{ width: 54, height: 36, objectFit: 'cover', borderRadius: 4 }} />
                        ) : (
                          <div style={{ width: 54, height: 36, background: '#333', borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10 }}>YT</div>
                        )}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: isSelected ? '#93c5fd' : '#fff' }}>
                            {item.title}
                          </div>
                          <div style={{ fontSize: 11, color: '#888' }}>
                            {item.uploader || 'YouTube'} {item.duration ? `• ${item.duration}` : ''}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="btn"
                          style={{ fontSize: 11, padding: '3px 8px', background: isSelected ? '#2563eb' : 'rgba(255,255,255,0.1)' }}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (!live) selectTrack(item);
                          }}
                          disabled={live}
                        >
                          {isSelected ? 'Terpilih ✓' : 'Pilih'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Currently Selected YouTube Track */}
            <div style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.25)', padding: '10px 14px', borderRadius: 8, fontSize: 13, color: '#86efac' }}>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>🎵 Lagu Siap Siaran:</div>
              <div style={{ color: '#fff', fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {selectedTitle || youtubeUrl}
              </div>
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
            💡 <strong>Tips:</strong> Saat popup browser muncul, pilih <strong>Tab</strong> atau <strong>Entire Screen</strong>, dan pastikan centang opsi <strong>"Also share tab audio"</strong>.
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
        {statusMessage && <div className="center" style={{ fontSize: 13, color: live ? '#4ade80' : '#94a3b8', marginTop: 10 }}>{statusMessage}</div>}
        <div className="center" style={{ marginTop: 18 }}>
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
