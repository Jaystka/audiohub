CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'admin',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text UNIQUE NOT NULL,
  description text,
  priority int NOT NULL DEFAULT 5,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  device_key text UNIQUE NOT NULL,
  type text NOT NULL CHECK (type IN ('broadcaster','player')),
  location text,
  status text NOT NULL DEFAULT 'offline',
  volume int NOT NULL DEFAULT 80 CHECK (volume BETWEEN 0 AND 100),
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS channel_devices (
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('broadcaster','listener')),
  PRIMARY KEY(channel_id, device_id)
);

CREATE TABLE IF NOT EXISTS broadcast_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  broadcaster_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  peak_listeners int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'live'
);

CREATE TABLE IF NOT EXISTS audio_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  url text NOT NULL,
  mime_type text,
  duration_seconds int,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  audio_asset_id uuid REFERENCES audio_assets(id) ON DELETE CASCADE,
  title text NOT NULL,
  cron_expression text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO users(name,email,password_hash,role)
VALUES ('Administrator','admin@audiohub.local','demo','admin')
ON CONFLICT(email) DO NOTHING;

INSERT INTO channels(name,slug,description,priority)
VALUES
('Office Announcement','office','General office announcements',5),
('Emergency','emergency','High priority emergency broadcast',10)
ON CONFLICT(slug) DO NOTHING;
