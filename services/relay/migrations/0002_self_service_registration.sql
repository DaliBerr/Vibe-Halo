-- Operations-only settings. No public HTTP endpoint can change these values.
CREATE TABLE relay_settings (id TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO relay_settings(id,value) VALUES('registration','open');
CREATE INDEX device_capacity ON devices(kind,status);
