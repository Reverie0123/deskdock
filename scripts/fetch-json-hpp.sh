#!/bin/sh
# 下载 nlohmann/json 单头文件到 native/helper/json.hpp
set -e
cd "$(dirname "$0")/.."
URL=https://github.com/nlohmann/json/releases/latest/download/json.hpp
if curl -s -m 8 -x http://127.0.0.1:7897 https://api.github.com >/dev/null 2>&1; then P="-x http://127.0.0.1:7897"; else P=""; fi
curl -L $P -m 120 -o native/helper/json.hpp "$URL"
ls -la native/helper/json.hpp
