CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('employee','manager','admin')),
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE employee_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  employee_code TEXT UNIQUE,
  department TEXT,
  designation TEXT,
  phone TEXT,
  joined_at DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE site_settings (
  id INT PRIMARY KEY DEFAULT 1,  -- singleton row
  company_name TEXT NOT NULL DEFAULT 'Bright Sky Construction',
  site_name TEXT,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  radius_feet NUMERIC NOT NULL DEFAULT 200,
  working_hours_start TIME DEFAULT '07:00',
  working_hours_end TIME DEFAULT '17:00',
  auto_clock_in_enabled BOOLEAN DEFAULT TRUE,
  auto_break_on_exit_enabled BOOLEAN DEFAULT TRUE,
  auto_correction_enabled BOOLEAN DEFAULT TRUE,
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE attendance_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  work_date DATE NOT NULL,
  clock_in_time TIMESTAMPTZ,
  clock_out_time TIMESTAMPTZ,
  break_minutes INT DEFAULT 0,
  worked_minutes INT DEFAULT 0,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, work_date)
);

CREATE TABLE punch_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  session_id UUID REFERENCES attendance_sessions(id),
  punch_type TEXT NOT NULL,
  punch_time TIMESTAMPTZ DEFAULT NOW(),
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  source TEXT DEFAULT 'manual',
  remarks TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID REFERENCES users(id),
  action_type TEXT,
  entity_type TEXT,
  entity_id TEXT,
  old_value JSONB,
  new_value JSONB,
  ip_address TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE export_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by UUID REFERENCES users(id),
  export_type TEXT,
  date_from DATE,
  date_to DATE,
  file_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);