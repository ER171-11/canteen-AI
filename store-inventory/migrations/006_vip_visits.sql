-- 会员到店识别台账
CREATE TABLE IF NOT EXISTS vip_visits (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id  TEXT,
  name       TEXT,
  phone      TEXT,
  table_id   TEXT,
  note       TEXT,
  ts         TEXT,
  source     TEXT
);
