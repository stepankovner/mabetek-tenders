"""Первичное сохранение токена без текста в командной строке и истории."""
import getpass
import os
import re
from pathlib import Path

def main():
    os.umask(0o077)
    dest=Path(__file__).resolve().parents[1]/".private"
    dest.mkdir(mode=0o700,exist_ok=True)
    token=getpass.getpass("Telegram bot token (hidden): ")
    if not re.fullmatch(r"[0-9]{6,}:[A-Za-z0-9_-]{30,}",token): raise SystemExit("Invalid format")
    with (dest/"telegram.token").open("x",encoding="ascii") as f:f.write(token)
    print("Tender bot token saved.")

if __name__=="__main__":main()
