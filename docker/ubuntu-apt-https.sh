#!/bin/sh
set -eu

find "${1:-/etc/apt}" -maxdepth 2 -type f \( -name '*.list' -o -name '*.sources' \) \
  -exec sed -E -i \
    -e 's#http://archive\.ubuntu\.com/ubuntu([/[:space:]]|$)#https://archive.ubuntu.com/ubuntu\1#g' \
    -e 's#http://security\.ubuntu\.com/ubuntu([/[:space:]]|$)#https://security.ubuntu.com/ubuntu\1#g' {} +
