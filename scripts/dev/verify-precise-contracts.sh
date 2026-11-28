#!/usr/bin/env bash
set -euo pipefail
exec /bin/bash scripts/dev/run-vitest-with-diagnostics.sh @aerodb/sweeper \
  test/progressive-capabilities.test.ts test/build-request-transient-pin.test.ts \
  test/progressive-cfd-jobs.test.ts test/progressive-remote-admission.test.ts \
  test/progressive-remote-jobs.test.ts
