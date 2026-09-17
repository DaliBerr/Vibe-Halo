CREATE TABLE device_profiles (
  device_id TEXT PRIMARY KEY REFERENCES devices(id),
  revision INTEGER NOT NULL,
  profile_jws TEXT NOT NULL
);
