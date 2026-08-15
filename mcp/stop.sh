#!/usr/bin/env bash
# 停止 MCP 服务
set -e

PID_FILE="/tmp/my-mcp-server.pid"

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "正在停止 MCP 服务（PID: $PID）..."
    kill "$PID"
    rm -f "$PID_FILE"
    echo "✓ 服务已停止"
  else
    echo "进程不存在，清理 PID 文件"
    rm -f "$PID_FILE"
  fi
else
  # 通过进程名查找
  PID=$(pgrep -f "node src/index.js" 2>/dev/null || true)
  if [ -n "$PID" ]; then
    echo "正在停止 MCP 服务（PID: $PID）..."
    kill "$PID"
    echo "✓ 服务已停止"
  else
    echo "未找到运行中的 MCP 服务"
  fi
fi
