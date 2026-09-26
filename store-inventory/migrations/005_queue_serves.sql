-- 候餐服务结构化台账（发茶/小食等），供 modules/booking 回读
CREATE TABLE IF NOT EXISTS queue_serves (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT,
  action     TEXT,
  item       TEXT,
  qty        REAL,
  note       TEXT,
  queue_no   TEXT,
  wait_eta_min INTEGER,
  queue_count INTEGER,
  ts         TEXT,
  source     TEXT
);
