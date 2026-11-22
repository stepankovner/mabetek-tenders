"""Check the worktree Qwen pipeline against the complete archived RZD notice on macOS."""
import hashlib
import json
import re
import resource
import subprocess
import time
from pathlib import Path

from .model import MODEL, analyze, select_fragments

DOCUMENT_SHA = '4f254d2ed94e3e5ac4e7944a114fb532b987dd28534ea53b816d4523f34983ca'
MODEL_SHA = 'd98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785'


def verified_lines(result, name, lines):
    numbers = []
    for citation in result.splitlines():
        match = re.fullmatch(re.escape(name) + r", строка ([1-9][0-9]*): (.+)", citation)
        if not match:
            return []
        number = int(match[1])
        if number > len(lines) or len(match[2].strip()) < 8 or match[2] not in lines[number - 1]:
            return []
        numbers.append(number)
    return numbers


def check(base):
    doc = base / 'documents/24233643' / (DOCUMENT_SHA + '.doc')
    with (base / 'models' / MODEL).open('rb') as stream:
        weights_sha = hashlib.file_digest(stream, 'sha256').hexdigest()
    if weights_sha != MODEL_SHA or hashlib.sha256(doc.read_bytes()).hexdigest() != DOCUMENT_SHA:
        raise ValueError('Контрольная сумма модели или документа отличается от эталона')
    name = json.loads(doc.with_suffix('.json').read_text())['name']
    source = subprocess.check_output(['textutil', '-convert', 'txt', '-stdout', str(doc)], timeout=15)
    lines = source.decode().splitlines()
    rows = select_fragments([dict(file=name, location=f'строка {n}', text=line)
                             for n, line in enumerate(lines, 1)])
    start = time.monotonic()
    result = analyze(rows, base)
    numbers = verified_lines(result, name, lines)
    quotes = [line.split(f'{name}, строка {i}: ', 1)[1] for line, i in zip(result.splitlines(), numbers)]
    cited = any('Место оказания услуг' in quote and 'Путевой' in quote for quote in quotes)
    return dict(result=result, cited=cited, verified_quote_lines=numbers, seconds=round(time.monotonic()-start, 3),
                child_peak_rss_bytes=resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss,
                lines=len(lines), document_sha256=DOCUMENT_SHA, weights_sha256=weights_sha)


if __name__ == '__main__':
    report = check(Path.home() / 'Library/Application Support/mabetek-tenders')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    raise SystemExit(0 if report['cited'] else 1)
