#!/usr/bin/env bash
# 启动 MCP 服务
set -e

cd "$(dirname "$0")"

echo "正在启动 MCP 服务..."
node src/index.js
