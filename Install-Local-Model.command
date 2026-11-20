#!/bin/zsh
set -eu
umask 077
model_dir="$HOME/Library/Application Support/mabetek-tenders/models"
mkdir -p "$model_dir"
cd "$model_dir"
model=Qwen3-8B-Q4_K_M.gguf
digest=d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785
expected_bytes=5027783488
zmodload zsh/system
touch .model-install.lock
if ! zsystem flock -t 0 -f lock_fd .model-install.lock; then
  print -r -- "Установщик модели уже работает."
  exit 0
fi
if [[ ! -f "$model" ]]; then
  part="$model.part"
  touch "$part"
  delay=5
  while true; do
    bytes=$(/usr/bin/stat -f %z "$part")
    if (( bytes == expected_bytes )); then break; fi
    if (( bytes > expected_bytes )); then
      print -u2 -- "Размер частичного файла превышает ожидаемый. Файл сохранён для проверки."
      exit 1
    fi
    print -r -- "Продолжаю загрузку с байта $bytes из $expected_bytes."
    if /usr/bin/curl --fail --location --proto '=https' --proto-redir '=https' --connect-timeout 30 --speed-limit 1 --speed-time 120 --continue-at - --output "$model.part" "https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/$model"; then
      rc=0
    else
      rc=$?
    fi
    current=$(/usr/bin/stat -f %z "$part")
    if (( current == expected_bytes )); then break; fi
    case $rc in
      0|5|6|7|16|18|28|35|52|55|56|92|95) ;;
      *) print -u2 -- "Ошибка curl $rc. Частичный файл сохранён."; exit $rc ;;
    esac
    if (( current > bytes )); then delay=5; fi
    print -r -- "Сохранено $current байт. Следующая попытка через $delay с."
    sleep "$delay"
    (( delay = delay < 60 ? delay * 2 : 120 ))
  done
  print -r -- "$digest  $model.part" | /usr/bin/shasum -a 256 --check
  mv "$model.part" "$model"
else
  print -r -- "$digest  $model" | /usr/bin/shasum -a 256 --check
fi
if [[ ! -x /opt/homebrew/bin/llama-completion ]]; then
  /opt/homebrew/bin/brew install llama.cpp
fi
/opt/homebrew/bin/llama-completion --version
