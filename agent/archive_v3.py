"""Freeze new public lots while keeping all previously inspected IDs out of the new holdout."""
import hashlib
import json
from pathlib import Path

from .archive import CUTOFF, normalize

def load(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line]

def snapshot(root):
    known = load(root/'v2-held-out.jsonl') + load(root/'v2-development.jsonl')
    old_ids = {row['id'] for row in known}
    old_procedures = {row['id'].split('/')[1] for row in known}
    entries = {row['id']:row for row in known}
    for row in load(root/'roseltorg-originals-v3.jsonl'):
        entries.setdefault(row['id'],row)
    parents = {}
    def find(node):
        parents.setdefault(node,node)
        while parents[node] != node:
            parents[node] = parents[parents[node]]
            node = parents[node]
        return node
    for row in entries.values():
        procedure=row['id'].split('/')[1]
        org=row.get('organizer') or row.get('customer')
        if org:
            key=normalize(org)+'|'+normalize(row['subject'])
            parents[find('subject/'+key)] = find(procedure)
    old_groups={find(p) for p in old_procedures}
    recent={find(row['id'].split('/')[1]) for row in entries.values() if row['published']>=CUTOFF}
    groups={'development':[],'held-out':[]}
    for row in entries.values():
        group=find(row['id'].split('/')[1])
        name='held-out' if group in recent and group not in old_groups else 'development'
        groups[name].append(dict(id=row['id'],subject=row['subject'],published=row['published'],
                                 organizer=row.get('organizer') or row.get('customer'),place=row.get('place'),
                                 url=row['url'],price=row.get('price'),currency=row.get('currency'),deadline=row.get('deadline')))
    for name,rows in groups.items():
        rows.sort(key=lambda r:hashlib.sha256(r['id'].encode()).hexdigest())
        path=root/('v3-'+name+'.jsonl')
        data=''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in rows).encode()
        if path.exists() and path.read_bytes()!=data:
            raise ValueError('Замороженный манифест отличается: '+path.name)
        if not path.exists():
            path.write_bytes(data)
        print(path.name,len(rows),hashlib.sha256(data).hexdigest())
    return len(entries),len(old_ids)

if __name__=='__main__':
    snapshot(Path(__file__).resolve().parents[1]/'reports/archive')
