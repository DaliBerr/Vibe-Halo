-- Bound hot authentication/capacity queries as the registered device pool grows.
CREATE INDEX IF NOT EXISTS devices_kind_status ON devices(kind,status);
CREATE INDEX IF NOT EXISTS challenge_device ON auth_challenges(device_id);
