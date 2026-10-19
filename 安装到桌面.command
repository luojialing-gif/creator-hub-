#!/bin/bash
# 把已打包好的 CreatorHub.app 安装到桌面（或 /Applications）。
# 用法：双击本文件；或在终端里执行
#   ./安装到桌面.command            # 装到桌面
#   ./安装到桌面.command /Applications   # 装到应用程序文件夹

set -u

cd "$(dirname "$0")" || exit 1
SRC="$(pwd)/dist/CreatorHub.app"
TARGET_DIR="${1:-$HOME/Desktop}"
DST="$TARGET_DIR/CreatorHub.app"

echo "=========================================="
echo " 安装「全媒体登录平台」到：$TARGET_DIR"
echo "=========================================="
echo

if [ ! -d "$SRC" ]; then
  echo "[×] 找不到打包产物：$SRC"
  echo "    请先执行：python3 tools/build_app.py --out ./dist"
  echo
  read -r -p "按回车键关闭..." _
  exit 1
fi

if [ -e "$DST" ]; then
  echo "已存在同名应用，将先移除：$DST"
  rm -rf "$DST" || { echo "[×] 移除失败，请手动删除后重试"; read -r -p "按回车键关闭..." _; exit 1; }
fi

echo "正在复制（约 234MB，通常几秒）..."
if ! /usr/bin/ditto "$SRC" "$DST"; then
  echo "[×] 复制失败。可能是权限不足（例如装到 /Applications 需要管理员权限）。"
  echo "    可改用：sudo ./安装到桌面.command /Applications"
  echo
  read -r -p "按回车键关闭..." _
  exit 1
fi

/usr/bin/xattr -cr "$DST" 2>/dev/null

echo
echo "[√] 安装完成：$DST"
echo
echo "双击它即可启动。账号数据仍在："
echo "  ~/Library/Application Support/CreatorHub/"
echo

# 装到桌面时顺手在访达里高亮一下，方便确认
/usr/bin/open -R "$DST" 2>/dev/null

read -r -p "按回车键关闭..." _
