"""Private, verified daily SQLite snapshots and bounded service diagnostics."""
import os
from datetime import datetime, timezone
from pathlib import Path

from .local import backup


def maintain(base: Path, *, day=None, keep=7):
    day = day or datetime.now(timezone.utc).strftime('%Y-%m-%d')
    if keep < 1:
        raise ValueError('Нужно сохранить хотя бы одну копию')
    directory = base / 'backups'
    directory.mkdir(mode=0o700, exist_ok=True)
    os.chmod(directory, 0o700)
    created = []
    for source in sorted(base.glob('*.sqlite')):
        output = directory / f'{source.stem}-{day}.sqlite'
        if not output.exists():
            backup(source, output)
            created.append(output.name)
        # Only remove old automatic snapshots of this database, after a valid
        # snapshot exists. Manually named backups and active databases stay intact.
        snapshots = sorted(p for p in directory.glob(f'{source.stem}-????-??-??.sqlite')
                           if p.is_file())
        for old in snapshots[:-keep]:
            old.unlink()
    log = base / 'agent-error.log'
    if log.exists() and log.stat().st_size > 5_000_000:
        # launchd holds this inode open: preserve the tail and truncate in place.
        with log.open('r+b') as handle:
            handle.seek(-1_000_000, os.SEEK_END)
            tail = handle.read().split(b'\n', 1)[-1]
            handle.seek(0)
            handle.write(tail)
            handle.truncate()
    return created
