# 用 GitHub Actions 打包 Windows + macOS 安装包

> 已经帮你把配置和代码都提交到了本地 git 仓库（首次提交 32 个文件，账号数据/node_modules 都已排除）。
> 你只需要做下面 3 步，就能在云端一次性出齐 `.exe` 和 `.dmg`。

---

## 第 1 步：在 GitHub 建一个空仓库

1. 打开 https://github.com/new
2. 仓库名随便填，比如 `creator-hub`
3. **Public 或 Private 都行**（不放心就选 Private，不影响打包）
4. **不要**勾选「Add a README / .gitignore / license」——保持完全空的仓库
5. 点 **Create repository**

创建后页面会显示一个远程地址，形如：
```
https://github.com/你的用户名/creator-hub.git
```

---

## 第 2 步：在终端里推送代码

打开终端（访达 → 应用程序 → 实用工具 → 终端），粘贴下面命令，把 `你的用户名` 和 `仓库名` 换成你自己的：

```bash
cd /Users/Zhuanz/WorkBuddy/2026-10-13-16-39-44/creator-hub

git branch -M main
git remote add origin https://github.com/你的用户名/仓库名.git
git push -u origin main
```

> 首次 push 会要求登录。用 GitHub 用户名 + **Personal Access Token**（不是账户密码）。
> Token 生成入口：GitHub 右上角头像 → Settings → Developer settings → Personal access tokens
> → Fine-grained tokens → 只勾这一个仓库的 `Contents: Read and write` 权限即可。
> 或者如果你装了 GitHub Desktop / `gh` CLI，也能用它来 push。

---

## 第 3 步：触发打包

1. 打开你的仓库页面 → 点顶部 **Actions** 标签
2. 左侧选 **build** 工作流
3. 右侧 **Run workflow** → `target` 选 **both**（两个平台都打）→ 绿色按钮确认

两个 job 会并行跑（macOS runner + Windows runner），各约 5–10 分钟。

---

## 第 4 步：下载产物

跑完后，点进那一次运行 → 页面底部 **Artifacts** 区，会看到两个压缩包：

| Artifact | 解压后得到 | 给谁用 |
| --- | --- | --- |
| `creatorhub-macos` | `CreatorHub-1.1.0-arm64.dmg`、`CreatorHub-1.1.0-x64.dmg` | Apple 芯片 Mac 用 arm64；Intel Mac 用 x64 |
| `creatorhub-windows` | `CreatorHub-Setup-1.1.0-x64.exe`（安装包）、`CreatorHub-Portable-1.1.0.exe`（免安装） | Windows 用户 |

> ⚠️ Artifact 默认只保留 **14 天**，记得及时下载转发。

---

## 常见问题

**Q：构建失败了怎么办？**
点进失败的那个 job 看红色日志。最常见两个原因：
1. 忘了把图标提交进仓库 —— 但这次已经帮你提交了（`build/icon.icns`、`build/icon.ico` 都在里面）
2. 网络下载 Electron 慢 —— 配置里已经加了国内镜像 `npmmirror.com`，一般不会

**Q：要改版本号？**
改 `package.json` 里的 `"version"`，再推一次、重新触发即可。

**Q：安装包没签名，对方电脑会拦吗？**
会提示一下，但能装。Mac 在「系统设置 → 隐私与安全性 → 仍要打开」；Windows 在 SmartScreen 点「更多信息 → 仍要运行」。详细说明在 `docs/分享指南.md` 里。
