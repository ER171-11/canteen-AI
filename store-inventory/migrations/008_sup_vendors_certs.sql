-- W3 供应商资质证照：certs 存 JSON 数组文本（[{type,cert_no,expire_at,url}]）
-- 幂等：库中已有该列时本文件会报 duplicate column，由迁移执行器逐文件 try/catch 忽略。
ALTER TABLE sup_vendors ADD COLUMN certs TEXT;
