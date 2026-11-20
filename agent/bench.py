"""Фактический замер извлечения из переданного документа на Mac."""
import argparse
import json
import resource
import time
from pathlib import Path
from .pipeline import extract

if __name__=="__main__":
    p=argparse.ArgumentParser();p.add_argument("document",type=Path);args=p.parse_args()
    start=time.perf_counter();rows=extract(args.document)
    print(json.dumps(dict(seconds=round(time.perf_counter()-start,3),max_rss_bytes=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,fragments=len(rows)),indent=2))
