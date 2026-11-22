"""Оценка закрытого набора после человеческой сверки. Один ID на группу и лот."""
import argparse
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
    for row in found.values():
        if type(row.get("shown")) is not bool or type(row.get("urgent")) is not bool:
            raise ValueError("Признаки показа и срочности должны быть логическими")
        if row["urgent"] and not row["shown"]:
            raise ValueError("Срочное уведомление должно быть показано")
    shown={k for k,r in found.items() if r["shown"]}
    urgent={k for k in shown if found[k]["urgent"]}
    by_class = {}
    for label in sorted(USEFUL):
        ids = {key for key, row in gold.items() if row["label"] == label}
        by_class[label] = [len(ids & shown), len(ids)]
    return {
        "recall": [len(useful & shown), len(useful)],
        "recall_by_class": by_class,
        "urgent_precision": [len(useful & urgent), len(urgent)],
        "omitted_from_collection": sorted(gold.keys() - found.keys()),
        "missed_useful": sorted(useful - shown),
        "false_urgent": sorted(urgent - useful),
    }


def selection_targets(report):
    targets = {}
    for key, percent in (("recall", 90), ("urgent_precision", 70)):
        hits, total = report[key]
        targets[key] = {
            "minimum_percent": percent,
            "met": hits * 100 >= total * percent if total else None,
        }
    return targets


def acceptance_sample(gold):
    confirmed = sum(row["label"] == "рассмотреть" for row in gold.values())
    useful = sum(row["label"] in USEFUL for row in gold.values())
    return {
        "lots": len(gold),
        "useful": useful,
        "confirmed": confirmed,
        "size_target_met": len(gold) >= 200 and useful >= 30,
    }


if __name__=="__main__":
    p=argparse.ArgumentParser();p.add_argument("adjudicated",type=Path);p.add_argument("bot",type=Path)
    p.add_argument("--manifest",type=Path,help="Сверить полный состав закрытой выборки для приёмки")
    args=p.parse_args()
    gold=load(args.adjudicated)
    if args.manifest:
        manifest=load(args.manifest)
        if gold.keys()!=manifest.keys():
            p.error("Метки должны покрывать все и только лоты замороженного манифеста")
    report = metrics(gold, load(args.bot))
    if args.manifest:
        report["sample"] = acceptance_sample(gold)
        report["selection_targets"] = selection_targets(report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if args.manifest and not report["sample"]["size_target_met"]:
        p.exit(2, "Выборка ниже целевого размера. Фактические дроби приведены в отчёте.\n")
    if args.manifest and any(target["met"] is not True for target in report["selection_targets"].values()):
        p.exit(2, "Порог полноты или точности не достигнут либо отсутствуют наблюдения.\n")
