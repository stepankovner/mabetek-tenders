"""Локальное рабочее место для ручного разбора первичных документов."""
import argparse
import hashlib
import json
import os
import sqlite3
import tempfile
from contextlib import closing
from pathlib import Path
from .pipeline import catalogue_subject, classify, extract, quote, render

ROOT=Path(__file__).resolve().parents[1]
def connection(path):
    path.parent.mkdir(parents=True,exist_ok=True)
    db=sqlite3.connect(path)
    db.row_factory=sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    try:
        migrations = sorted((int(f.stem), f) for f in (ROOT / "migrations").glob("*.sql"))
        if migrations and db.execute("PRAGMA user_version").fetchone()[0] < migrations[-1][0]:
            with db:
                db.execute("BEGIN IMMEDIATE")
                version = db.execute("PRAGMA user_version").fetchone()[0]
                for number, file in migrations:
                    if number <= version:
                        continue
                    script = file.read_text(encoding="utf-8")
                    start = 0
                    for i, char in enumerate(script):
                        if char == ";" and sqlite3.complete_statement(script[start:i + 1]):
                            db.execute(script[start:i + 1])
                            start = i + 1
                    if script[start:].strip():
                        db.execute(script[start:])
                    db.execute(f"PRAGMA user_version={number}")
        db.execute("""CREATE TABLE IF NOT EXISTS catalogue_observations (
            lot INTEGER NOT NULL REFERENCES lots(id), source TEXT NOT NULL,
            sequence INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT(unixepoch()),
            payload TEXT NOT NULL, PRIMARY KEY(lot,source,sequence))""")
    except BaseException:
        db.close()
        raise
    return db

def observe_catalogue(db, lot, entry):
    from .eat_import import enqueue_candidates
    # The observation and its upload queue entry share the same transaction.
    # A crash between SQLite storage and the network cannot lose this candidate.
    enqueue_candidates(db, [entry], commit=False)
    payload = json.dumps(entry, sort_keys=True, ensure_ascii=False)
    latest = db.execute(
        "SELECT sequence,payload FROM catalogue_observations WHERE lot=? AND source=? ORDER BY sequence DESC LIMIT 1",
        (lot, entry["source"])).fetchone()
    if latest and latest["payload"] == payload:
        return
    sequence = latest["sequence"] + 1 if latest else 1
    db.execute("INSERT INTO catalogue_observations(lot,source,sequence,payload) VALUES(?,?,?,?)",
               (lot, entry["source"], sequence, payload))


def record(db, entry, docs, *, catalogue=False):
    mandatory=("source","procedure","lot","url","title")
    if not all(isinstance(entry.get(k),str) and entry[k].strip() for k in mandatory): raise ValueError("Нужны " + ", ".join(mandatory))
    rows=[row for path in docs for row in extract(path)]
    body=dict(entry,attachments=[])
    for doc in docs:
        with open(doc,"rb") as f: body["attachments"].append(dict(name=Path(doc).name,sha256=hashlib.file_digest(f,"sha256").hexdigest()))
    canonical=json.dumps(["eis" if entry.get("eis") else entry["source"],entry.get("eis") or entry["procedure"],entry["lot"]],ensure_ascii=False,separators=(",",":"))
    payload=json.dumps(body,sort_keys=True,ensure_ascii=False)
    digest=hashlib.sha256(payload.encode()).hexdigest()
    db.execute("BEGIN IMMEDIATE")
    with db:
        existing=db.execute("SELECT l.id,l.revision,v.digest,v.payload FROM lots l JOIN versions v ON l.id=v.lot AND l.revision=v.revision WHERE canonical=?",(canonical,)).fetchone()
        if catalogue and existing:
            observe_catalogue(db, existing["id"], entry)
            saved = json.loads(existing["payload"])
            differences = {key: {"stored": saved.get(key), "observed": entry[key]}
                           for key in ("title", "url") if saved.get(key) != entry[key]}
            return differences
        if existing and existing["digest"]==digest: return existing["id"],existing["revision"]
        rev=existing["revision"]+1 if existing else 1
        result,reason=classify(catalogue_subject(entry)+" "+" ".join(r["text"] for r in rows),entry.get("place",""))
        lot=db.execute("INSERT INTO lots(canonical,procedure_no,lot_no,revision,deadline,status) VALUES(?,?,?,?,?,?) ON CONFLICT(canonical) DO UPDATE SET revision=excluded.revision,deadline=excluded.deadline,status=excluded.status RETURNING id",(canonical,entry["procedure"],entry["lot"],rev,entry.get("deadline"),result)).fetchone()[0]
        db.execute("INSERT INTO versions VALUES(?,?,?,?,unixepoch())",(lot,rev,digest,payload))
        db.execute("INSERT OR IGNORE INTO links VALUES(?,?,?)",(lot,entry["source"],entry["url"]))
        db.execute("INSERT INTO evidence VALUES(?,?,?,?,?)",(lot,rev,"отбор",reason,digest))
        db.executemany("INSERT INTO evidence VALUES(?,?,?,?,?)",[(lot,rev,r["file"]+" · "+r["location"],r["text"],r["sha256"]) for r in rows])
        db.execute("UPDATE offers SET state='устарело' WHERE lot=?",(lot,))
        if catalogue:
            observe_catalogue(db, lot, entry)
        return lot,rev

def backup(source, output):
    with closing(sqlite3.connect(source.resolve().as_uri() + '?mode=ro', uri=True)) as db:
        if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lots'").fetchone():
            raise ValueError("В базе нет таблицы лотов")
        with tempfile.TemporaryDirectory(dir=output.parent) as folder:
            staged = Path(folder) / "snapshot.sqlite"
            staged.touch(mode=0o600)
            with closing(sqlite3.connect(staged)) as target:
                db.backup(target)
                if target.execute("PRAGMA integrity_check").fetchall() != [('ok',)]:
                    raise ValueError("Резервная копия не прошла проверку")
            # Publish a complete snapshot without replacing an existing file.
            os.link(staged, output)


def main():
    os.umask(0o077)
    p=argparse.ArgumentParser()
    p.add_argument("--db",type=Path,default=Path.home()/"Library/Application Support/mabetek-tenders/local.sqlite")
    sub=p.add_subparsers(dest="op",required=True)
    imp=sub.add_parser("import");imp.add_argument("card",type=Path);imp.add_argument("docs",nargs="*",type=Path)
    sub.add_parser("inbox")
    show=sub.add_parser("show");show.add_argument("lot",type=int)
    sub.add_parser("observations").add_argument("lot", type=int)
    save=sub.add_parser("answer");save.add_argument("lot",type=int);save.add_argument("revision",type=int);save.add_argument("terms",type=Path)
    for op in ("preview","issue"):
        cmd=sub.add_parser(op);cmd.add_argument("lot",type=int)
        if op=="issue":
            cmd.add_argument("--approve-digest",required=True);cmd.add_argument("--template",required=True,type=Path);cmd.add_argument("output",type=Path)
    sub.add_parser("backup").add_argument("output",type=Path)
    args=p.parse_args()
    if args.op=="backup":
        backup(args.db, args.output)
        return
    db=connection(args.db)
    if args.op=="import": print(record(db,json.loads(args.card.read_text()),args.docs));return
    if args.op=="inbox":
        for r in db.execute("select id,procedure_no,lot_no,revision,status from lots order by id desc"): print(*r,sep=" | ")
        return
    lot=db.execute("SELECT l.*,v.payload FROM lots l JOIN versions v ON v.lot=l.id AND v.revision=l.revision WHERE l.id=?",(args.lot,)).fetchone()
    if not lot: raise ValueError("Лот отсутствует")
    key=("local",lot["id"],lot["revision"])
    if args.op=="observations":
        for row in db.execute("SELECT source,sequence,seen,payload FROM catalogue_observations WHERE lot=? ORDER BY seen,source,sequence", (args.lot,)):
            print(json.dumps(dict(source=row["source"], sequence=row["sequence"], seen=row["seen"],
                                  card=json.loads(row["payload"])), ensure_ascii=False))
        return
    if args.op=="show":
        print(lot["payload"],lot["status"])
        latest = db.execute("""SELECT source,sequence,seen,payload FROM catalogue_observations AS o
            WHERE lot=? AND sequence=(SELECT max(sequence) FROM catalogue_observations
            WHERE lot=o.lot AND source=o.source) ORDER BY source""", (args.lot,))
        for row in latest:
            print("Последнее наблюдение каталога", row["source"], row["sequence"], row["payload"], sep=" · ")
        for r in db.execute("select location,text from evidence where lot=? and revision=?",key[1:]): print(*r,sep=" · ")
        return
    if args.op=="answer":
        if args.revision!=lot["revision"]: raise ValueError("Проверьте новую версию документов")
        terms=json.loads(args.terms.read_text())
        with db:
            db.execute("INSERT OR REPLACE INTO answers VALUES(?,?,?,'terms',?)",(*key,json.dumps(terms,ensure_ascii=False)))
        return
    saved=db.execute("select value from answers where owner=? and lot=? and revision=? and field='terms'",key).fetchone()
    if not saved: raise ValueError("Нет ответов по текущей версии")
    terms=json.loads(saved[0]);card=json.loads(lot["payload"])
    terms.update(customer=card.get("customer"),lot=lot["procedure_no"]+"/"+lot["lot_no"],confirmed=True)
    summary=json.dumps(quote(terms),ensure_ascii=False,sort_keys=True,indent=2)
    digest=hashlib.sha256((str(lot["revision"])+summary).encode()).hexdigest()
    if args.op=="preview": print(summary,digest);return
    if args.approve_digest!=digest: raise ValueError("Сводка изменилась")
    if args.output.exists(): raise ValueError("Выберите новое имя файла")
    render(terms,args.output,template=args.template)
    with db: db.execute("insert into offers(lot,revision,digest,state) values(?,?,?,'подготовлено локально')",(lot["id"],lot["revision"],digest))

if __name__=="__main__": main()
