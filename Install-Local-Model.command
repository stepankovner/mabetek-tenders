#!/bin/zsh
set -eu
umask 077
model_dir="$HOME/Library/Application Support/mabetek-tenders/models"
mkdir -p "$model_dir"
cd "$model_dir"
model=Qwen3-8B-Q4_K_M.gguf
digest=d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785
if [[ ! -f "$model" ]]; then
  /usr/bin/curl --fail --location --proto '=https' --proto-redir '=https' --retry 2 --continue-at - --output "$model.part" "https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/$model"
  print -r -- "$digest  $model.part" | /usr/bin/shasum -a 256 --check
  mv "$model.part" "$model"
else
  print -r -- "$digest  $model" | /usr/bin/shasum -a 256 --check
fi
if [[ ! -x /opt/homebrew/bin/llama-completion ]]; then
  /opt/homebrew/bin/brew install llama.cpp
fi
/opt/homebrew/bin/llama-completion --version
