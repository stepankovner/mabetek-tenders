"""Freeze a RAD holdout before inspecting independent labels or tuning thresholds."""
import collections
import hashlib
import json
import re
from pathlib import Path
from .archive import CUTOFF, normalize
from .archive_v3 import load

ARCHIVE = Path(__file__).resolve().parents[1] / 'reports/archive'


def family(row):
    return normalize(row.get('organizer') or row.get('customer') or ''), normalize(row['subject'])


def freeze(root):
    known = [row for name in ('v3-development', 'v3-held-out', 'broad-sample', 'development')
             for row in load(root / (name + '.jsonl'))]
    procedures = {row.get('procedure') or row['id'].split('/')[1] for row in known}
    procedures.add('32616584495')
    families = {family(row) for row in known}
    strata = collections.defaultdict(list)
    source = root / 'rad-candidates-2026-11-21.jsonl'
    for row in load(source):
        if not CUTOFF <= row['published'] <= '2026-11-19':
            continue
        name = {'': 'general', 'Хабаровск': 'regional'}.get(row['query'], 'industry')
        strata[name].append(row)

    def order(row):
        return hashlib.sha256(('mabetek-v4|' + row['id']).encode()).digest()

    chosen = []
    for stratum, quota in [('industry', 80), ('regional', 70), ('general', 50)]:
        count = 0
        for row in sorted(strata[stratum], key=order):
            procedure = re.sub(r'\.lot\d+$', '', row['procedure'])
            group = family(row)
            if procedure in procedures or group in families:
                continue
            chosen.append({k:row[k] for k in ('id','procedure','published','subject','organizer','url','record_sha256')})
            procedures.add(procedure)
            families.add(group)
            count += 1
            if count == quota:
                break
        if count != quota:
            raise ValueError('Недостаточно уникальных групп: ' + stratum)
    target = root / 'v4-held-out.jsonl'
    payload = ''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in sorted(chosen, key=order)).encode()
    if target.exists() and target.read_bytes() != payload:
        raise ValueError('Замороженный манифест отличается')
    if not target.exists():
        target.write_bytes(payload)
    print(len(chosen), hashlib.sha256(payload).hexdigest())


if __name__ == '__main__':
    freeze(ARCHIVE)
