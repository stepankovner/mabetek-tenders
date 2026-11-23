"""Compare frozen title decisions with independently saved responses, preserving missing IDs."""
import argparse
import collections
import json
import re
from pathlib import Path
from .archive_v3 import load

def compare(root, version='v3', output=None):
    cards={r['id']:r for r in load(root/f'{version}-held-out.jsonl')}
    predictions={r['id']:r['title_match'] for r in load(root/f'{version}-title-results.jsonl')}
    if predictions.keys()!=cards.keys():
        raise ValueError('Результаты фильтра не совпадают с манифестом')
    result={}
    sources = collections.defaultdict(list)
    for path in sorted((root/f'{version}-review').glob('response-*.txt')):
        prompt=(path.parent/path.name.replace('response','prompt')).read_text()
        records = [json.loads(line) for line in prompt.splitlines() if line.startswith('{"id"')]
        batch = {record['id'] for record in records}
        aliases = {record['review_id']:record['id'] for record in records if 'review_id' in record}
        if not batch <= cards.keys() or len(aliases) != sum('review_id' in r for r in records):
            raise ValueError('Некорректные идентификаторы в партии')
        response = re.sub(r'\n[ \n]*\t[ \n]*\n', ' | ', path.read_text())
        for line in response.splitlines():
            fields=[field.strip().strip('*`') for field in line.strip().strip('|').split('|')]
            if len(fields)<3:
                continue
            key=re.sub(r'^\s*(?:\d+[.)]\s*)?','',fields[0])
            key=aliases.get(key,key)
            if key not in batch:
                linked=[k for k in batch if fields[-1].rstrip(' .')==cards[k]['url'] and key==k.split('/')[1]]
                if len(linked)==1:key=linked[0]
            reported_url = fields[-1].strip().rstrip(' .')
            label=fields[1].lower()
            if key not in batch or label not in ('рассмотреть','нужно уточнение','отклонить','недостаточно данных'):
                continue
            cited_urls = re.findall(r'https?://[^\s<>\[\]()]+', reported_url)
            original = cards[key]['url']
            if original in cited_urls:
                evidence = 'original_url'
            elif cited_urls:
                evidence = 'other_url'
            else:
                evidence = 'id_only'
            sources[key].append(dict(response=path.name, label=label, status=evidence,
                                     urls=cited_urls))
            if evidence == 'other_url':
                continue
            if key in result and result[key]!=label:raise ValueError('Противоречивый ответ '+key)
            result[key]=label
    comparison = []
    for key in cards:
        citations = sources[key]
        checked = {c['label'] for c in citations if c['status'] == 'original_url'}
        comparison.append(dict(id=key, title_match=predictions[key], independent=result.get(key),
                               linked_label=next(iter(checked), None), citations=citations))
    if output is None:
        output = root / (version + '-comparison-audited.jsonl')
    output.write_text(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in comparison))
    print('Результаты по ID:',len(result),'из',len(cards))
    print('Фильтр, класс, количество:',dict(collections.Counter((r['title_match'],r['independent']) for r in comparison)))

if __name__=='__main__':
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('--version', choices=['v3','v4'], default='v3')
    args = cli.parse_args()
    root = Path(__file__).resolve().parents[1]/'reports/archive'
    compare(root, args.version)
