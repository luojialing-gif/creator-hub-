#!/bin/bash
# 全媒体登录平台 网页版启动器 —— 双击用默认浏览器打开纯前端导航聚合页。
# 注意：网页版无法隔离第三方平台登录态，仅作账号导航用。

cd "$(dirname "$0")" || exit 1

PAGE="./web/creator-hub-web.html"

if [ ! -f "$PAGE" ]; then
  echo "[×] 找不到 $PAGE"
  read -r -p "按回车键关闭..." _
  exit 1
fi

open "$PAGE"
echo "已在默认浏览器中打开网页版。"
sleep 1
