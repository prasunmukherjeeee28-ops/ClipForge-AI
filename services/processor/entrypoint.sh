#!/bin/sh
set -eu

: "${PROCESSOR_SCRATCH_DIR:=/var/lib/clipforge/scratch}"
: "${PROCESSOR_STT_MODEL_CACHE_DIR:=/var/cache/clipforge/models}"

# Mounted volumes are commonly owned by root. Prepare only the mount roots,
# then run the actual processor as the dedicated unprivileged UID.
for directory in "$PROCESSOR_SCRATCH_DIR" "$PROCESSOR_STT_MODEL_CACHE_DIR"; do
  mkdir -p "$directory"
  chown 10001:10001 "$directory"
  chmod 0700 "$directory"
done

exec gosu 10001:10001 python -m clipforge_processor.worker
