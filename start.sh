#!/bin/bash
# ============================================
# MyAgent 源码开发环境启动脚本
#   同时启动后端（tsx）和前端（Vite dev server）
#   Ctrl+C 停止所有服务
# ============================================
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/.dev.pids"

cleanup() {
  echo ""
  echo "[Start] 正在停止服务..."
  if [ -f "$PID_FILE" ]; then
    while read -r PID; do
      if kill -0 "$PID" 2>/dev/null; then
        echo "  停止 PID $PID"
        kill "$PID" 2>/dev/null || true
      fi
    done < "$PID_FILE"
    rm -f "$PID_FILE"
  fi
  exit 0
}

trap cleanup INT TERM

echo "========================================"
echo "  MyAgent 源码开发环境"
echo "========================================"

# ── 端口检查：如果 7980 已被占用则强制释放 ──
PORT=${PORT:-7980}
if ss -tlnp 2>/dev/null | grep -q ":$PORT "; then
  echo "  [Port] $PORT 已被占用，正在释放..."
  OLD_PID=$(ss -tlnp 2>/dev/null | grep ":$PORT " | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1)
  if [ -n "$OLD_PID" ]; then
    echo "  [Port] 停止旧进程 PID $OLD_PID"
    kill "$OLD_PID" 2>/dev/null || true
    # 等待端口释放
    for i in 1 2 3; do
      sleep 0.5
      if ! ss -tlnp 2>/dev/null | grep -q ":$PORT "; then
        break
      fi
    done
  fi
fi

# ── 后端 ──
echo ""
echo "[Backend] 启动后端..."
cd "$SCRIPT_DIR/backend"
npx tsx watch src/index.ts &
BACKEND_PID=$!
echo "  PID: $BACKEND_PID  端口: ${PORT}"

# ── 前端 ──
echo ""
echo "[Frontend] 启动前端开发服务器..."
cd "$SCRIPT_DIR/frontend"
npm run dev &
FRONTEND_PID=$!
echo "  PID: $FRONTEND_PID  端口: 5173"

# 保存 PID
echo "$BACKEND_PID" > "$PID_FILE"
echo "$FRONTEND_PID" >> "$PID_FILE"

echo ""
echo "========================================"
echo "  后端: http://localhost:${PORT:-7980}"
echo "  前端: http://localhost:5173"
echo "  停止: Ctrl+C"
echo "========================================"

# 等待子进程
wait
