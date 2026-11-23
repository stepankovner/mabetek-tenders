CREATE TABLE IF NOT EXISTS document_tasks (
  key TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  watched INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL DEFAULT(unixepoch()),
  due INTEGER NOT NULL DEFAULT(unixepoch()),
  lease TEXT,
  until_ts INTEGER NOT NULL DEFAULT 0,
  checked INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS document_tasks_due ON document_tasks(due,watched,created);
CREATE TABLE IF NOT EXISTS document_reviews (
  lot INTEGER NOT NULL REFERENCES lots(id),
  revision INTEGER NOT NULL,
  digest TEXT,
  report TEXT NOT NULL,
  checked INTEGER NOT NULL DEFAULT(unixepoch()),
  PRIMARY KEY(lot,revision)
);
CREATE TABLE IF NOT EXISTS document_proofs (
  job INTEGER PRIMARY KEY REFERENCES jobs(id),
  lease TEXT NOT NULL,
  digest TEXT NOT NULL,
  checked INTEGER NOT NULL DEFAULT(unixepoch())
);
INSERT OR IGNORE INTO document_tasks(key,url,watched)
SELECT CASE WHEN json_extract(v.payload,'$.source')='eis-order' THEN 'eis:'||l.procedure_no
            ELSE json_extract(v.payload,'$.url') END,
       json_extract(v.payload,'$.url'),1
FROM lots l JOIN versions v ON v.lot=l.id AND v.revision=l.revision
WHERE (json_extract(v.payload,'$.source')='eis-order' AND json_extract(v.payload,'$.url') LIKE 'https://zakupki.gov.ru/%')
   OR (json_extract(v.payload,'$.source')='rzd-rts' AND json_extract(v.payload,'$.url') LIKE 'https://rzd.rts-tender.ru/TenderInterests/%');
