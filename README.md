# AudioHub

Self-hosted realtime audio broadcasting platform. One browser/device can publish microphone audio and one or many player devices can receive it with low latency.

## Included

- Next.js 15 management UI
- Go REST API
- PostgreSQL schema + automatic migration
- LiveKit WebRTC media server
- Docker Compose deployment
- Broadcast Studio with microphone capture, audio meter and listener count
- Player with realtime audio subscription and volume control
- Channel management + priority metadata
- Device provisioning + online/offline heartbeat model
- Broadcast session history
- Starter schema for audio library and schedules

## Architecture

Browser Broadcaster -> LiveKit SFU -> Player browsers/STB kiosks

Management UI -> Go API -> PostgreSQL

## Local run

1. Install Docker + Docker Compose.
2. Copy `.env.example` to `.env` if you want to override defaults.
3. Run:

```bash
docker compose up --build
```

Open:
- Web: http://localhost:3000
- API health: http://localhost:8080/health
- LiveKit: ws://localhost:7880

Open `/broadcast` on Device A, choose a channel and click Start Broadcast. Open `/player` on Device B, choose the same channel and Connect Player.

## Production notes

WebRTC needs correct public networking. For a VPS deployment:
- Point HTTPS domain(s) to the web/API services.
- Expose TCP 7881 and UDP 50000-50100 to LiveKit.
- Set `rtc.use_external_ip: true` in `infra/livekit.yaml` when the server has a routable public IP.
- Replace `devkey/devsecret` and `JWT_SECRET`.
- Set `PUBLIC_LIVEKIT_URL=wss://livekit.your-domain.com` and configure TLS/reverse proxy for LiveKit websocket signaling.
- Browser microphone capture requires HTTPS except on localhost.

For difficult NAT/mobile networks, add a TURN server (e.g. coturn) and configure LiveKit TURN/TLS.

## Device kiosk

For an Armbian/STB player, configure Chromium to autostart in kiosk mode on:

`https://your-domain/player`

A production extension can bind the provisioned `deviceKey` to localStorage and send `/api/devices/{id}/heartbeat` every 10 seconds.

## Next production modules

The database already reserves `audio_assets` and `schedules`. Recommended next modules are object storage upload (MinIO/S3), scheduler worker, TTS, priority preemption, remote volume commands over WebSocket/NATS, audit logs, JWT/SSO and RBAC.
