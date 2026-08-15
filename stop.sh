#!/bin/bash
# ============================================
# MyAgent 源码开发环境停止脚本
#   停止通过 start.sh 启动的后端和前端服务
# ============================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/.dev.pids"

echo "========================================"
echo "  MyAgent 停止开发服务"
echo "========================================"

if [ -f "$PID_FILE" ]; then
  echo ""
  echo "[Stop] 从 PID 文件读取进程..."
  while read -r PID; do
    if kill -0 "$PID" 2>/dev/null; then
      echo "  停止 PID $PID"
      kill "$PID" 2>/dev/null || true
    else
      echo "  PID $PID 已不存在"
    fi
  done < "$PID_FILE"
  rm -f "$PID_FILE"
  echo "[Stop] 完成"
else
  echo ""
  echo "[Stop] 未找到 PID 文件，尝试按进程名查找..."
  BACKEND_PID=$(pgrep -f "tsx.*src/index\.ts" 2>/dev/null || true)
  FRONTEND_PID=$(pgrep -f "vite" 2>/dev/null || true)
  [ -n "$BACKEND_PID" ] && echo "  停止后端 PID $BACKEND_PID" && kill "$BACKEND_PID" 2>/dev/null || true
  [ -n "$FRONTEND_PID" ] && echo "  停止前端 PID $FRONTEND_PID" && kill "$FRONTEND_PID" 2>/dev/null || true
  echo "[Stop] 完成"
fi
