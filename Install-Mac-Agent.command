#!/bin/zsh
set -eu
umask 077
project_dir=${0:A:h}
cd "$project_dir"
if [[ -x /Library/Frameworks/Python.framework/Versions/3.12/bin/python3 ]]; then
  python_bin=/Library/Frameworks/Python.framework/Versions/3.12/bin/python3
else
  python_bin=$(command -v python3)
fi
"$python_bin" -c 'import pymupdf' || { print 'Для запуска требуется PyMuPDF из agent/requirements.txt.'; exit 1; }
exec "$python_bin" -m agent.install
