#!/bin/bash
# 全媒体登录平台 启动器 —— 在访达里双击本文件即可启动桌面版。
# 会自动处理 ELECTRON_RUN_AS_NODE 这个常见的启动坑。

cd "$(dirname "$0")" || exit 1

APP_NAME="全媒体登录平台"
DIR="$(pwd)"

echo "=========================================="
echo " $APP_NAME · 多平台创作者中心聚合工作台"
echo "=========================================="

# 1) 检查 Electron 是否已安装
if [ ! -x "./node_modules/.bin/electron" ]; then
  echo ""
  echo "[!] 还没装依赖。正在安装（首次约需几分钟）..."
  echo ""
  if [ -n "$ELECTRON_MIRROR" ]; then
    npm install
  else
    echo "    使用国内镜像加速下载 Electron 二进制..."
    ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" npm install
  fi
  if [ ! -x "./node_modules/.bin/electron" ]; then
    echo ""
    echo "[×] 依赖安装失败。请在终端里手动执行："
    echo "    cd \"$DIR\""
    echo "    ELECTRON_MIRROR=\"https://npmmirror.com/mirrors/electron/\" npm install"
    echo ""
    read -r -p "按回车键关闭..." _
    exit 1
  fi
fi

# 2) 清掉 ELECTRON_RUN_AS_NODE（存在时 electron 会以纯 Node 模式启动并报 setAppName 之类的错）
unset ELECTRON_RUN_AS_NODE

echo ""
echo "正在启动... 关掉应用窗口即可退出。"
echo ""

./node_modules/.bin/electron . "$@"
CODE=$?

if [ $CODE -ne 0 ]; then
  echo ""
  echo "[×] 应用以退出码 $CODE 结束。若为首次启动失败，可尝试："
  echo "    1) 确认已安装依赖：npm install"
  echo "    2) 在系统设置 → 隐私与安全性 中允许本应用运行"
  echo ""
  read -r -p "按回车键关闭..." _
fi
