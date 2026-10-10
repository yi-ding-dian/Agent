#!/bin/bash
# ============================================
# MyAgent 一键打包脚本
#   用法：bash build/build.sh
#   产物：build/dist-electron/MyAgent-1.0.0.AppImage
#   流程：前端构建 → 客户端引擎 → Electron 主进程 → AppImage
# ============================================
set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> [1/4] 构建前端并同步到 Electron 目录"
cd "$ROOT"
npm run build:client
rm -rf "$ROOT/build/frontend-dist"
cp -r src/client/dist "$ROOT/build/frontend-dist"

echo "==> [2/4] 构建客户端引擎 (agent-engine.mjs)"
cd "$ROOT"
npm run build:electron

echo "==> [3/4] 编译 Electron 主进程"
cd "$ROOT"
npx tsc -p tsconfig.main.json

echo "==> [4/4] 打包 AppImage"
cd "$ROOT/build"
npx electron-builder --linux AppImage

echo "✅ 打包完成:"
ls -lht "$ROOT/build/dist-electron/"*.AppImage | head -1
