#!/bin/sh
# 下载 nlohmann/json 单头文件到 native/helper/json.hpp
set -e
cd "$(dirname "$0")/.."
URL=https://github.com/nlohmann/json/releases/latest/download/json.hpp
# curl honours HTTPS_PROXY / https_proxy from the environment; set it if GitHub is not reachable directly
curl -L -m 120 -o native/helper/json.hpp "$URL"
ls -la native/helper/json.hpp
