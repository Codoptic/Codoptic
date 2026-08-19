#!/usr/bin/env bash
set -euo pipefail

# Default roots to clean; override by passing one or more directories.
if [ "$#" -gt 0 ]; then
  ROOT_DIRS=("$@")
else
  ROOT_DIRS=(app components lib scripts tools)
fi

removed=0
skipped=0

for ROOT_DIR in "${ROOT_DIRS[@]}"; do
  if [ ! -d "$ROOT_DIR" ]; then
    echo "Skipping \"$ROOT_DIR\" (directory does not exist)" >&2
    skipped=$((skipped + 1))
    continue
  fi

  echo "Searching for cache directories in \"$ROOT_DIR\"..."

  found_in_root=0
  while IFS= read -r -d '' dir; do
    echo "Removing $dir"
    rm -rf "$dir"
    removed=$((removed + 1))
    found_in_root=1
  done < <(find "$ROOT_DIR" -type d \( -name "__pycache__" -o -name ".pytest_cache" \) -print0)

  if [ "$found_in_root" -eq 0 ]; then
    echo "No __pycache__ or .pytest_cache directories found in \"$ROOT_DIR\"."
  fi
done

echo "Done. Removed $removed cache director(ies); skipped $skipped missing root(s)."
