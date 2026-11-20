"""Оценка закрытого набора после человеческой сверки. Один ID на группу и лот."""
import argparse
import hashlib
import json
from pathlib import Path
USEFUL={"рассмотреть","нужно уточнение"}
LABELS=USEFUL|{"отклонить","недостаточно исходных данных"}

def load(path):
    rows=[json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    index={r["id"]:r for r in rows}
    if len(index)!=len(rows):raise ValueError("Повтор ID")
    return index

def metrics(gold,found):
    if found.keys()-gold.keys(): raise ValueError("ID вне манифеста")
    if any(r["label"] not in LABELS for r in gold.values()):raise ValueError("Неизвестная метка")
    useful={k for k,r in gold.items() if r["label"] in USEFUL}
    shown={k for k,r in found.items() if r["shown"]}
    urgent={k for k in shown if found[k]["urgent"]}
    return {"recall":[len(useful&shown),len(useful)],"urgent_precision":[len(useful&urgent),len(urgent)],"omitted_from_collection":sorted(gold.keys()-found.keys()),"missed_useful":sorted(useful-shown),"false_urgent":sorted(urgent-useful)}

if __name__=="__main__":
    p=argparse.ArgumentParser();p.add_argument("adjudicated",type=Path);p.add_argument("bot",type=Path)
    args=p.parse_args()
    print(json.dumps(metrics(load(args.adjudicated),load(args.bot)),ensure_ascii=False,indent=2))
