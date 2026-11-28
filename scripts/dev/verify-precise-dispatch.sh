#!/usr/bin/env bash
set -euo pipefail
# Keep the original precise-admission coverage and exercise the composed request.
if [[ ${1:-} == cutover ]]; then
  exec /bin/bash scripts/dev/run-vitest-with-diagnostics.sh @aerodb/db test/campaign-profile-enrollment.test.ts -t 'sealed dispatch cutover compatibility'
fi
exec /bin/bash scripts/dev/run-vitest-with-diagnostics.sh @aerodb/db \
  test/campaign-profile-enrollment.test.ts -t \
  'sealed dispatch cutover compatibility|subsonic through precise priority|keeps prior-generation stop safety|claims multiple precise units in order|prefers one complete registered short-work group|keeps the v1 precise march at one lane|sealed progressive solver dispatch|continues one bounded precise full-URANS case|admits one exact saved-case FAST continuation|composes high-Mach fast local-time work|bounded progressive numerical recovery|progressive remote dispatch pins one exact request|progressive remote dispatch composes only after authenticated capabilities'
