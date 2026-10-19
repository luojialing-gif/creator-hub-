'use strict';

/**
 * CreatorHub 主进程
 *
 * 登录态隔离的核心机制：
 *   每个账号绑定一个独立的 Electron session 分区：persist:<platform>-account-<slot>
 *   ─ persist: 前缀 → Cookie / localStorage / IndexedDB 全部落盘到
 *     <userData>/Partitions/<分区名>/，应用重启后自动还原，因此不需要每次重新登录。
 *   ─ 分区名互不相同 → 账号之间不共享 Cookie，互不顶号。
 *
 * 本文件不做、也永远不会做的事：
 *   读取 / 导出 / 上传第三方 Cookie；保存第三方平台密码；绕过验证码或风控。
 *
 * 登录态能活多久，由平台服务端决定，本工具只负责把本机这一侧做到最稳：
 *   及时落盘、会话型 Cookie 转为可持久化、定期保活并巡检是否被踢。
 *   相关实现集中在 src/session-guard.js。
 */

const path = require('path');
const fs = require('fs');
const {
  app,
  BrowserWindow,
  WebContentsView,
  BrowserView,
  session,
  ipcMain,
  dialog,
  shell,
  clipboard,
  nativeTheme,
  Menu
} = require('electron');

const { PLATFORMS, getPlatform, platformName, isValidPlatform } = require('./shared/platforms');
const store = require('./store');
const { createSessionGuard } = require('./session-guard');

const SMOKE = process.env.CREATORHUB_SMOKE === '1';
const IS_MAC = process.platform === 'darwin';

// 注意：app.name 必须与打包后的可执行文件/Helper 名一致（ASCII），
// 否则 Electron 运行时会报 "Unable to find helper app"。
// 用户看到的「全媒体登录平台」通过窗口 title 与 Info.plist 的 CFBundleDisplayName 呈现。
app.setName('CreatorHub');

// 自检模式跑在隔离目录里，绝不碰用户真实的账号数据与登录态分区。
// 注意：不能用 /tmp —— Chromium 的子进程沙箱对 macOS /private/tmp 下的
// userData 目录会初始化失败，因此放在应用数据目录下的独立子目录。
const SMOKE_DIR = SMOKE ? path.join(app.getPath('appData'), 'CreatorHub', 'smoke-' + process.pid) : null;
if (SMOKE_DIR) {
  try {
    fs.mkdirSync(SMOKE_DIR, { recursive: true });
    app.setPath('userData', SMOKE_DIR);
  } catch (e) {
    console.error('无法创建自检隔离目录：' + e.message);
  }
}

// 必须在 app ready 之前设置，保证 userData 目录固定，登录态不会因启动方式不同而走丢
if (!SMOKE) {
  app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');
}

/** 主窗口 */
let mainWindow = null;
/** accountId -> { view, kind, partition, account, attached, lastUsedAt } */
const viewPool = new Map();
/** 由「新窗口打开」创建的窗口：accountId -> BrowserWindow[] */
const detachedWindows = new Map();
/** 已配置过的 session：partition -> session */
const sessionCache = new Map();
/** 全局状态（账号 + 设置） */
let state = null;

/* ---------------------------------------------------------- 单实例锁
 * 两个实例会共用同一份 userData 与 Partitions/<分区> 目录：
 * 轻则 Chromium 报「分区已被占用」，重则两个实例各自把内存里的账号列表
 * 写回 accounts.json，后写的把先写的覆盖掉（新增的账号凭空消失）。
 * 因此只允许一个实例，第二次启动改为唤起已有窗口。
 * 自检模式跑在独立目录、且需要并发执行，不禁用。
 */
if (!SMOKE) {
  if (!app.requestSingleInstanceLock()) {
    console.log('[全媒体登录平台] 已有实例在运行，本次启动退出并唤起已有窗口。');
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });
}

/* ============================================================ 基础工具 */

function userDataDir() {
  return app.getPath('userData');
}

function stateFilePath() {
  return store.paths.statePath;
}

/** 账号 → 分区名。slot 存在账号记录里，编辑 / 导入都不会改变它，登录态因此保持稳定。 */
function partitionFor(account) {
  const slot = account.slot || 1;
  return 'persist:' + account.platform + '-account-' + slot;
}

/** 分区名 → 该分区在磁盘上的目录（仅用于界面展示，不读取内容） */
function partitionDir(partition) {
  return path.join(userDataDir(), 'Partitions', partition.replace(/^persist:/, ''));
}

/** Electron 各版本对 storagePath 的暴露方式不一致（属性 / 方法），统一取值。 */
function storagePathOf(ses) {
  try {
    if (typeof ses.storagePath === 'function') return ses.storagePath() || '';
    if (typeof ses.storagePath === 'string') return ses.storagePath;
  } catch (e) {
    /* 忽略 */
  }
  return '';
}

function buildChromeUA() {
  const chrome = process.versions.chrome || '131.0.0.0';
  if (IS_MAC) {
    return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + chrome + ' Safari/537.36';
  }
  if (process.platform === 'win32') {
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + chrome + ' Safari/537.36';
  }
  return 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + chrome + ' Safari/537.36';
}

/** 默认 UA 里带 "Electron/33.x" 标识，部分平台会据此给出异常页面；可关闭。 */
function applyUA(ses) {
  try {
    if (state && state.settings.spoofChromeUA) ses.setUserAgent(buildChromeUA());
    else ses.setUserAgent(ses.getUserAgent().replace(/\sElectron\/[\d.]+/i, ''));
  } catch (e) {
    /* 某些版本对 setUserAgent 有限制，忽略即可 */
  }
}

/**
 * 获取（并首次配置）某个分区的 session。
 * 权限一律默认拒绝，只放开复制与全屏这两个内容平台正常使用的能力。
 */
function getSession(partition) {
  if (sessionCache.has(partition)) {
    const cached = sessionCache.get(partition);
    applyUA(cached);
    return cached;
  }

  const ses = session.fromPartition(partition);
  applyUA(ses);
  try {
    ses.setSpellCheckerEnabled(false);
  } catch (e) {
    /* 忽略 */
  }
  ses.setPermissionRequestHandler((contents, permission, callback) => {
    const allowed = ['clipboard-sanitized-write', 'fullscreen', 'window-management'];
    callback(allowed.indexOf(permission) !== -1);
  });
  ses.setPermissionCheckHandler((contents, permission) => {
    const allowed = ['clipboard-sanitized-write', 'fullscreen', 'window-management'];
    return allowed.indexOf(permission) !== -1;
  });
  sessionCache.set(partition, ses);
  return ses;
}

function findAccount(id) {
  return state.accounts.find((a) => a.id === id) || null;
}

/** 给账号附加派生字段：分区名、分区目录、目录是否已存在（供界面透明展示）。 */
function decorateAccounts(list) {
  return list.map((a) => {
    const partition = partitionFor(a);
    const dir = partitionDir(partition);
    let exists = false;
    try {
      exists = fs.existsSync(dir);
    } catch (e) {
      exists = false;
    }
    return Object.assign({}, a, { partition, partitionDir: dir, partitionExists: exists });
  });
}

/** 打开账号时的目标地址：优先「登录后 URL」，其次「登录入口 URL」，最后平台默认入口。 */
function targetUrl(account) {
  const custom = (account.postLoginUrl || '').trim();
  if (custom) return custom;
  const entry = (account.url || '').trim();
  if (entry) return entry;
  const p = getPlatform(account.platform);
  return p ? p.entry : 'about:blank';
}

function touchAccount(account) {
  account.lastOpenedAt = Date.now();
  store.save(state);
}

function toastPayload(message, kind) {
  return { message, kind: kind || 'info' };
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/* ==================================================== 内嵌视图（每账号一视图） */

/**
 * 创建承载第三方页面的视图。
 * 优先 WebContentsView（Electron 30+ 推荐），不可用时退回 BrowserView。
 */
function createHostedView(partition) {
  const webPreferences = {
    partition,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: false,
    autoplayPolicy: 'user-gesture-required',
    backgroundThrottling: false
  };
  if (typeof WebContentsView === 'function') {
    return { kind: 'wcv', view: new WebContentsView({ webPreferences }) };
  }
  if (typeof BrowserView === 'function') {
    return { kind: 'bv', view: new BrowserView({ webPreferences }) };
  }
  throw new Error('当前 Electron 版本既不支持 WebContentsView 也不支持 BrowserView');
}

function attachView(rec) {
  if (!mainWindow || rec.attached) return;
  if (rec.kind === 'wcv') {
    const host = mainWindow.contentView;
    if (!host) throw new Error('窗口未提供 contentView');
    host.addChildView(rec.view);
  } else {
    mainWindow.addBrowserView(rec.view);
  }
  rec.attached = true;
}

function detachView(rec) {
  if (!mainWindow || !rec.attached) return;
  try {
    if (rec.kind === 'wcv') {
      mainWindow.contentView.removeChildView(rec.view);
    } else {
      mainWindow.removeBrowserView(rec.view);
    }
  } catch (e) {
    /* 视图可能已被销毁 */
  }
  rec.attached = false;
}

function destroyView(rec) {
  detachView(rec);
  try {
    if (rec.view && rec.view.webContents && !rec.view.webContents.isDestroyed()) {
      rec.view.webContents.close(); // 关闭页面而非整个应用
    }
  } catch (e) {
    try {
      rec.view.webContents.destroy();
    } catch (e2) {
      /* 忽略 */
    }
  }
  viewPool.delete(rec.account.id);
}

/** 该账号的视图，不存在则创建（含事件绑定、弹窗策略、失败兜底）。 */
function ensureView(account) {
  const cached = viewPool.get(account.id);
  if (cached && cached.view && cached.view.webContents && !cached.view.webContents.isDestroyed()) {
    cached.account = account;
    return cached;
  }
  if (cached) viewPool.delete(account.id);

  const partition = partitionFor(account);
  const ses = getSession(partition);
  const made = createHostedView(partition);
  const view = made.view;
  const rec = { account, view, kind: made.kind, partition, session: ses, attached: false, lastUsedAt: Date.now() };

  try {
    view.setBackgroundColor('#ffffff');
  } catch (e) {
    /* 忽略 */
  }

  const wc = view.webContents;

  // 平台自己的弹窗（登录、扫码、授权页）必须留在本账号的分区里，否则登录会断
  wc.setWindowOpenHandler(({ url }) => {
    if (!/^https?:/i.test(url)) {
      shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 1100,
        height: 820,
        autoHideMenuBar: true,
        title: platformName(account.platform) + ' · ' + account.alias + ' · 弹窗',
        webPreferences: {
          partition,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          spellcheck: false
        }
      }
    };
  });

  const pushState = () => {
    if (rec.account.id !== (activeAccountId || '')) return;
    sendToRenderer('view:state', viewState(rec));
  };

  ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated'].forEach((ev) => {
    wc.on(ev, pushState);
  });

  wc.on('did-fail-load', (e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return; // -3 = ERR_ABORTED，正常的跳转中止
    if (rec.account.id !== (activeAccountId || '')) return;
    sendToRenderer('view:failed', {
      accountId: rec.account.id,
      errorCode,
      errorDescription: errorDescription || '加载失败',
      url: validatedURL || ''
    });
  });

  wc.on('render-process-gone', () => {
    if (rec.account.id === (activeAccountId || '')) {
      sendToRenderer('view:failed', {
        accountId: rec.account.id,
        errorCode: -1,
        errorDescription: '页面进程意外退出（通常是内存不足）。点击「重新加载」可恢复。',
        url: ''
      });
    }
  });

  wc.on('focus', () => {
    if (rec.account.id !== (activeAccountId || '')) {
      // 用户在视图内点击/输入，视为激活该账号
      activeAccountId = rec.account.id;
      sendToRenderer('view:activated', { accountId: rec.account.id });
    }
  });

  viewPool.set(account.id, rec);
  return rec;
}

let activeAccountId = null;

function viewState(rec) {
  const wc = rec.view.webContents;
  let url = '';
  try {
    url = wc.getURL();
  } catch (e) {
    url = '';
  }
  let title = '';
  try {
    title = wc.getTitle();
  } catch (e) {
    title = '';
  }
  let canGoBack = false;
  let canGoForward = false;
  try {
    const nav = wc.navigationHistory;
    if (nav && typeof nav.canGoBack === 'function') {
      canGoBack = nav.canGoBack();
      canGoForward = nav.canGoForward();
    } else {
      canGoBack = wc.canGoBack();
      canGoForward = wc.canGoForward();
    }
  } catch (e) {
    /* 忽略 */
  }
  return {
    accountId: rec.account.id,
    platform: rec.account.platform,
    alias: rec.account.alias,
    partition: rec.partition,
    url,
    title,
    loading: wc.isLoading(),
    canGoBack,
    canGoForward
  };
}

/** 切换到某个账号的内嵌视图：其它视图摘掉（按设置决定是否保留页面在后台运行）。 */
function showAccountView(accountId, bounds) {
  const account = findAccount(accountId);
  if (!account) return { error: '账号不存在' };

  for (const [id, rec] of Array.from(viewPool.entries())) {
    if (id === accountId) continue;
    detachView(rec);
    if (!state.settings.keepViewsAlive) destroyView(rec);
  }

  const rec = ensureView(account);
  attachView(rec);
  rec.lastUsedAt = Date.now();
  activeAccountId = accountId;
  if (bounds) setViewBounds(bounds);

  if (!rec.view.webContents.isLoading() && !rec.view.webContents.getURL()) {
    rec.view.webContents.loadURL(targetUrl(account)).catch(() => {});
  }
  touchAccount(account);
  return { ok: true, state: viewState(rec) };
}

function setViewBounds(bounds) {
  if (!activeAccountId) return { ok: false };
  const rec = viewPool.get(activeAccountId);
  if (!rec || !rec.attached) return { ok: false };
  const b = {
    x: Math.max(0, Math.round(bounds.x || 0)),
    y: Math.max(0, Math.round(bounds.y || 0)),
    width: Math.max(0, Math.round(bounds.width || 0)),
    height: Math.max(0, Math.round(bounds.height || 0))
  };
  if (b.width < 50 || b.height < 50) {
    // 面板被折叠/隐藏，直接收起视图而不是塞一个 1px 的怪东西
    try {
      rec.view.setVisible(false);
    } catch (e) {
      /* 忽略 */
    }
    return { ok: true, hidden: true };
  }
  try {
    rec.view.setVisible(true);
  } catch (e) {
    /* 旧版本没有 setVisible */
  }
  rec.view.setBounds(b);
  return { ok: true };
}

function hideActiveView() {
  if (!activeAccountId) return { ok: true };
  const rec = viewPool.get(activeAccountId);
  if (!rec) return { ok: true };
  try {
    rec.view.setVisible(false);
  } catch (e) {
    /* 旧版本没有 setVisible：退化为移到屏幕外 */
    try {
      rec.view.setBounds({ x: -10000, y: -10000, width: 100, height: 100 });
    } catch (e2) {
      /* 忽略 */
    }
  }
  return { ok: true };
}

function closeActiveView() {
  if (!activeAccountId) return { ok: true };
  const rec = viewPool.get(activeAccountId);
  if (rec) detachView(rec);
  activeAccountId = null;
  return { ok: true };
}

/* ==================================================== 独立窗口打开 */

function openAccountWindow(account, url) {
  const partition = partitionFor(account);
  getSession(partition);
  const win = new BrowserWindow({
    width: 1240,
    height: 880,
    title: platformName(account.platform) + ' · ' + account.alias,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });
  win.loadURL(url || targetUrl(account)).catch(() => {});

  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (!/^https?:/i.test(target)) {
      shell.openExternal(target).catch(() => {});
      return { action: 'deny' };
    }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        autoHideMenuBar: true,
        webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true }
      }
    };
  });

  if (!detachedWindows.has(account.id)) detachedWindows.set(account.id, []);
  const list = detachedWindows.get(account.id);
  list.push(win);
  win.on('closed', () => {
    const arr = detachedWindows.get(account.id) || [];
    const i = arr.indexOf(win);
    if (i !== -1) arr.splice(i, 1);
  });
  touchAccount(account);
  return win;
}

/* ==================================================== 主窗口与菜单 */

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 900,
    minHeight: 620,
    show: !SMOKE,
    title: '全媒体登录平台',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16181d' : '#f4f5f7',
    autoHideMenuBar: true,
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload 里只用到 ipcRenderer / contextBridge，仍保持隔离
      spellcheck: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  mainWindow.on('resize', () => {
    sendToRenderer('window:resized', {});
  });
  mainWindow.on('closed', () => {
    viewPool.forEach((rec) => destroyView(rec));
    mainWindow = null;
  });

  return mainWindow;
}

function buildMenu() {
  const template = [
    ...(IS_MAC
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          }
        ]
      : []),
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        {
          label: '重新加载当前工作台页面',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            const rec = activeAccountId ? viewPool.get(activeAccountId) : null;
            if (rec && rec.view && !rec.view.webContents.isDestroyed()) rec.view.webContents.reload();
            else if (mainWindow) mainWindow.webContents.reload();
          }
        },
        {
          label: '返回账号列表',
          accelerator: 'CmdOrCtrl+Shift+L',
          click: () => {
            closeActiveView();
            sendToRenderer('view:closed', {});
          }
        },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        { role: 'toggleDevTools', label: '开发者工具（界面）' }
      ]
    },
    {
      label: '窗口',
      submenu: [{ role: 'minimize', label: '最小化' }, { role: 'close', label: '关闭' }]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ==================================================== IPC 接口 */

function registerIpc() {
  ipcMain.handle('hub:boot', () => ({
    platforms: PLATFORMS,
    accounts: decorateAccounts(store.listAccounts(state)),
    settings: state.settings,
    statuses: store.STATUSES,
    statusLabel: store.STATUS_LABEL,
    guard: {
      patrolling: sessionGuard.isPatrolling(),
      lastPatrolAt: sessionGuard.stats.lastPatrolAt,
      lastPatrolSummary: sessionGuard.stats.lastPatrolSummary,
      lastFlushAt: sessionGuard.stats.lastFlushAt
    },
    env: {
      platformLabel: process.platform,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      userData: userDataDir(),
      stateFile: stateFilePath(),
      dark: nativeTheme.shouldUseDarkColors
    }
  }));

  ipcMain.handle('hub:saveAccount', (e, payload) => {
    const res = store.upsertAccount(state, payload || {});
    if (res.error) return res;
    return { account: res.account, created: res.created, accounts: decorateAccounts(store.listAccounts(state)) };
  });

  ipcMain.handle('hub:deleteAccount', (e, id) => {
    const account = findAccount(id);
    const res = store.deleteAccount(state, id);
    if (res.error) return res;
    const rec = viewPool.get(id);
    if (rec) destroyView(rec);
    if (activeAccountId === id) activeAccountId = null;
    // 只删除账号配置，不主动清除该分区的登录态（用户可在设置里显式清理）
    return { ok: true, accounts: decorateAccounts(store.listAccounts(state)), partition: account ? partitionFor(account) : null };
  });

  ipcMain.handle('hub:reorder', (e, payload) => {
    const res = store.reorder(state, payload.platform, payload.orderedIds);
    if (res.error) return res;
    return { ok: true, accounts: decorateAccounts(store.listAccounts(state)) };
  });

  ipcMain.handle('hub:move', (e, payload) => {
    const res = store.move(state, payload.id, payload.dir);
    if (res.error) return res;
    return { ok: true, accounts: decorateAccounts(store.listAccounts(state)) };
  });

  ipcMain.handle('hub:updateSettings', (e, patch) => {
    state.settings = store.normalizeSettings(patch, state.settings);
    store.save(state);
    if (patch && patch.theme) {
      nativeTheme.themeSource = patch.theme === 'system' ? 'system' : patch.theme;
    }
    if (patch && typeof patch.spoofChromeUA === 'boolean') {
      sessionCache.forEach((ses) => applyUA(ses));
    }
    // 保活间隔 / 开关变了要重新排期
    if (patch && (patch.keepAlive !== undefined || patch.keepAliveHours !== undefined || patch.patrolOnStart !== undefined)) {
      sessionGuard.reschedule();
    }
    return { settings: state.settings };
  });

  /** 立即巡检全部账号的登录态（同时完成一轮保活访问）。 */
  ipcMain.handle('hub:patrol', async (e, payload) => {
    try {
      const res = await sessionGuard.patrolNow({ manual: true, accountId: (payload && payload.accountId) || null });
      return { ok: true, summary: res.summary || null, skipped: !!res.skipped, reason: res.reason || '' };
    } catch (err) {
      return { error: '巡检失败：' + (err && err.message ? err.message : String(err)) };
    }
  });

  /** 手动把登录态写进磁盘（会话型 Cookie 一并加固）。 */
  ipcMain.handle('hub:flushSession', async () => {
    try {
      const summary = await sessionGuard.flushNow(true);
      return { ok: true, summary, at: Date.now() };
    } catch (err) {
      return { error: '写入失败：' + (err && err.message ? err.message : String(err)) };
    }
  });

  ipcMain.handle('hub:export', async () => {
    const payload = store.exportPayload(state);
    const stamp = new Date().toISOString().slice(0, 10);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出账号配置',
      defaultPath: path.join(app.getPath('downloads'), '全媒体登录平台-账号-' + stamp + '.json'),
      filters: [{ name: 'JSON 文件', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    fs.writeFileSync(result.filePath, JSON.stringify(payload, null, 2), 'utf8');
    return { ok: true, filePath: result.filePath, count: payload.accounts.length };
  });

  ipcMain.handle('hub:import', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入账号配置',
      properties: ['openFile'],
      filters: [{ name: 'JSON 文件', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8'));
    } catch (err) {
      return { error: '文件不是合法的 JSON：' + err.message };
    }
    const res = store.importPayload(state, parsed);
    if (res.error) return res;
    return { ok: true, filePath: result.filePaths[0], added: res.added, updated: res.updated, skipped: res.skipped, accounts: decorateAccounts(store.listAccounts(state)), settings: state.settings };
  });

  /* ---------------- 视图控制 ---------------- */

  ipcMain.handle('view:open', (e, payload) => {
    const account = findAccount(payload && payload.id);
    if (!account) return { error: '账号不存在' };
    if (payload.mode === 'window') {
      openAccountWindow(account, payload.url);
      return { ok: true, mode: 'window' };
    }
    return showAccountView(account.id, payload.bounds);
  });

  ipcMain.handle('view:openMany', (e, payload) => {
    const ids = Array.isArray(payload && payload.ids) ? payload.ids : [];
    let opened = 0;
    ids.forEach((id, i) => {
      const account = findAccount(id);
      if (!account) return;
      // 错开 260ms，避免同一瞬间对同一平台并发建连（更容易触发风控）
      setTimeout(() => {
        try {
          openAccountWindow(account);
        } catch (err) {
          /* 忽略单个失败 */
        }
      }, i * 260);
      opened += 1;
    });
    return { ok: true, opened };
  });

  ipcMain.handle('view:close', () => {
    closeActiveView();
    return { ok: true };
  });

  ipcMain.handle('view:bounds', (e, bounds) => setViewBounds(bounds || {}));
  ipcMain.handle('view:hide', () => hideActiveView());
  ipcMain.handle('view:show', (e, bounds) => (activeAccountId ? setViewBounds(bounds || {}) : { ok: false }));

  ipcMain.handle('view:nav', (e, action) => {
    const rec = activeAccountId ? viewPool.get(activeAccountId) : null;
    if (!rec || rec.view.webContents.isDestroyed()) return { error: '没有打开中的工作台页面' };
    const wc = rec.view.webContents;
    try {
      if (action === 'back') {
        if (wc.navigationHistory && typeof wc.navigationHistory.goBack === 'function') wc.navigationHistory.goBack();
        else wc.goBack();
      } else if (action === 'forward') {
        if (wc.navigationHistory && typeof wc.navigationHistory.goForward === 'function') wc.navigationHistory.goForward();
        else wc.goForward();
      } else if (action === 'reload') {
        wc.reload();
      } else if (action === 'stop') {
        wc.stop();
      } else if (action === 'home') {
        const account = findAccount(activeAccountId);
        if (account) wc.loadURL(targetUrl(account)).catch(() => {});
      } else if (action === 'devtools') {
        wc.openDevTools({ mode: 'detach' });
      }
    } catch (err) {
      return { error: err.message };
    }
    return { ok: true };
  });

  ipcMain.handle('view:load', (e, url) => {
    const rec = activeAccountId ? viewPool.get(activeAccountId) : null;
    if (!rec || rec.view.webContents.isDestroyed()) return { error: '没有打开中的工作台页面' };
    let target = String(url || '').trim();
    if (!/^https?:\/\//i.test(target)) target = 'https://' + target;
    try {
      rec.view.webContents.loadURL(target).catch(() => {});
      return { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('view:releaseBackground', () => {
    let released = 0;
    viewPool.forEach((rec, id) => {
      if (id === activeAccountId) return;
      destroyView(rec);
      released += 1;
    });
    return { ok: true, released };
  });

  /** 清理某账号的本地登录态（等于把该账号登出）。仅清本地，不读取、不外传。 */
  ipcMain.handle('hub:clearData', async (e, id) => {
    const account = findAccount(id);
    if (!account) return { error: '账号不存在' };
    const partition = partitionFor(account);
    const rec = viewPool.get(id);
    if (rec) destroyView(rec);
    const ses = getSession(partition);
    await ses.clearStorageData();
    await ses.clearCache();
    try {
      await ses.clearAuthCache();
    } catch (err) {
      /* 忽略 */
    }
    if (activeAccountId === id) activeAccountId = null;
    return { ok: true, partition, dir: partitionDir(partition) };
  });

  ipcMain.handle('hub:diagnostics', () => ({
    userData: userDataDir(),
    stateFile: stateFilePath(),
    dataDir: path.dirname(stateFilePath()),
    partitions: store.listAccounts(state).map((a) => ({
      accountId: a.id,
      alias: a.alias,
      platform: a.platform,
      partition: partitionFor(a),
      dir: partitionDir(partitionFor(a)),
      exists: fs.existsSync(partitionDir(partitionFor(a)))
    })),
    activeViews: Array.from(viewPool.keys()),
    guard: {
      patrolling: sessionGuard.isPatrolling(),
      lastFlushAt: sessionGuard.stats.lastFlushAt,
      lastPatrolAt: sessionGuard.stats.lastPatrolAt,
      lastPatrolSummary: sessionGuard.stats.lastPatrolSummary,
      flushRuns: sessionGuard.stats.flushRuns,
      patrolRuns: sessionGuard.stats.patrolRuns
    },
    health: store.listAccounts(state).map((a) => ({
      alias: a.alias,
      state: a.health ? a.health.state : 'untested',
      checkedAt: a.health ? a.health.checkedAt : 0
    })),
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    }
  }));

  ipcMain.handle('hub:copy', (e, text) => {
    clipboard.writeText(String(text == null ? '' : text));
    return { ok: true };
  });

  ipcMain.handle('hub:openExternal', (e, url) => {
    const target = String(url || '');
    if (!/^https?:\/\//i.test(target)) return { error: 'URL 不合法' };
    shell.openExternal(target).catch(() => {});
    return { ok: true };
  });

  ipcMain.handle('hub:openPath', (e, target) => {
    if (typeof target !== 'string' || !target) return { error: '路径不合法' };
    shell.openPath(target).catch(() => {});
    return { ok: true };
  });

  /** 快速创建账号位：每个平台 3 个，便于立刻验收「3 个账号切换」。 */
  ipcMain.handle('hub:seed', () => {
    let created = 0;
    PLATFORMS.forEach((p) => {
      const count = state.accounts.filter((a) => a.platform === p.id).length;
      for (let i = count + 1; i <= 3; i += 1) {
        const res = store.upsertAccount(state, {
          platform: p.id,
          alias: p.name + '账号' + i,
          note: '示例账号位，可改名或删除',
          url: p.entry,
          status: i === 1 ? 'normal' : i === 2 ? 'pending' : 'loggedout'
        });
        if (!res.error) created += 1;
      }
    });
    return { ok: true, created, accounts: decorateAccounts(store.listAccounts(state)) };
  });
}

/* ==================================================== 登录态守护 */

/**
 * 隐藏探针窗口：用于静默加载某账号的工作台，判断它的登录态还在不在。
 * 用真实窗口（show:false）而不是离屏，是因为只有真实渲染进程才会完整执行页面 JS，
 * 平台也才会顺带续期自己的会话 —— 这同时就是「保活」本身。
 */
function makeProbeWindow(partition) {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    skipTaskbar: true,
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  });
  try {
    win.setMenuBarVisibility(false);
  } catch (e) {
    /* 忽略 */
  }
  return win;
}

/** 该账号所属平台的登录页特征子串（定义在 shared/platforms.js） */
function loginHintsFor(account) {
  const p = getPlatform(account.platform);
  return (p && p.loginHints) || [];
}

/**
 * 巡检要加载的地址。
 * 视频号这类「入口页本身就是登录页」的平台，必须优先用自定义的「登录后 URL」，
 * 否则永远停在 login.html，判出来的结果全是假的。
 */
function probeUrlFor(account) {
  const p = getPlatform(account.platform) || {};
  const post = (account.postLoginUrl || '').trim();
  if (p.healthProbe === 'post' && post) return post;
  return targetUrl(account);
}

const sessionGuard = createSessionGuard({
  getSession,
  listAccounts: () => store.listAccounts(state),
  partitionFor,
  probeUrlFor,
  loginHintsFor,
  /** 账号已经开着视图时，直接看它现在的地址，不再重复加载、不打扰用户 */
  getLiveUrl(accountId) {
    const rec = viewPool.get(accountId);
    if (!rec || !rec.view || !rec.view.webContents) return null;
    try {
      if (rec.view.webContents.isDestroyed()) return null;
      return rec.view.webContents.getURL() || null;
    } catch (e) {
      return null;
    }
  },
  makeProbe: makeProbeWindow,
  getSettings: () => state.settings,
  onHealth(accountId, health) {
    const acc = findAccount(accountId);
    if (acc) acc.health = store.normalizeHealth(health);
    sendToRenderer('hub:health', { accountId, health: acc ? acc.health : null });
  },
  onProgress(payload) {
    sendToRenderer('hub:patrolProgress', payload);
  },
  onPatrolDone(summary) {
    // 巡检结果批量落一次盘，避免每个账号都写一遍数据文件
    try {
      store.save(state);
    } catch (e) {
      /* 忽略 */
    }
    sendToRenderer('hub:patrolDone', summary);
    if (summary && summary.needsLogin > 0) {
      sendToRenderer(
        'hub:notice',
        toastPayload('有 ' + summary.needsLogin + ' 个账号需要重新登录，卡片上已标出，可一键批量打开重登。', 'warn')
      );
    }
  },
  logger: { info: function () {}, warn: function (m) { console.warn('[session-guard] ' + m); } }
});

/* ==================================================== 生命周期 */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    store.init(app.getPath('userData'));
    const loaded = store.load();
    state = loaded.state;
    nativeTheme.themeSource = state.settings.theme || 'system';

    if (SMOKE) {
      await runSmokeTest();
      return;
    }

    buildMenu();
    registerIpc();
    createMainWindow();
    sessionGuard.start();

    if (loaded.recovered) {
      mainWindow.webContents.once('did-finish-load', () => {
        sendToRenderer('hub:notice', toastPayload(loaded.recovered, 'warn'));
      });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  });

  /**
   * 退出前把 Cookie 真正写进磁盘再放行。
   * Chromium 的写盘是延迟的，强退会丢掉最后一段时间的写入 —— 那正是「刚登录过、重开又要登」的常见成因。
   * 最多等 QUIT_FLUSH_TIMEOUT_MS，绝不因为刷盘失败而卡住退出。
   */
  const QUIT_FLUSH_TIMEOUT_MS = 2500;
  let quitFlushStarted = false;
  app.on('before-quit', (e) => {
    if (quitFlushStarted) return;
    if (!state || state.settings.flushOnQuit === false) return;
    quitFlushStarted = true;
    e.preventDefault();
    sessionGuard.stop();
    sessionGuard
      .flushBeforeQuit(QUIT_FLUSH_TIMEOUT_MS)
      .catch(() => null)
      .then(() => app.quit());
  });

  app.on('window-all-closed', () => {
    if (!IS_MAC) app.quit();
  });
}

/* ==================================================== 冒烟自检（npm run smoke） */

/**
 * 无界面自检：验证「每个账号独立持久化分区」这一核心承诺真的成立。
 * 输出一行 JSON，并以退出码表达结果，供 CI / 人工核对。
 */
async function runSmokeTest() {
  const results = [];
  const check = (name, pass, detail) => results.push({ name, pass: !!pass, detail: detail === undefined ? '' : detail });

  try {
    check('账号数据文件可读写', typeof stateFilePath() === 'string' && state !== null, stateFilePath());

    const seededA = store.upsertAccount(state, { platform: 'douyin', alias: '冒烟-抖音-1', url: getPlatform('douyin').entry });
    const seededB = store.upsertAccount(state, { platform: 'douyin', alias: '冒烟-抖音-2', url: getPlatform('douyin').entry });
    check('可为同一平台创建多个账号', !seededA.error && !seededB.error && seededA.account.slot !== seededB.account.slot,
      'slots=' + [seededA.account && seededA.account.slot, seededB.account && seededB.account.slot].join(','));

    const win = createMainWindow();
    await new Promise((resolve) => {
      if (win.webContents.isLoading()) win.webContents.once('did-finish-load', resolve);
      else resolve();
    });
    check('主窗口可加载渲染层', true, win.webContents.getURL());

    const accA = findAccount(seededA.account.id);
    const accB = findAccount(seededB.account.id);

    const pA = partitionFor(accA);
    const pB = partitionFor(accB);
    check('分区名按平台与账号编号生成', pA === 'persist:douyin-account-' + accA.slot && pA !== pB, pA + ' / ' + pB);

    const sesA = getSession(pA);
    const sesB = getSession(pB);
    check('不同账号拿到不同 session 实例', sesA !== sesB && storagePathOf(sesA) !== storagePathOf(sesB),
      storagePathOf(sesA) + ' | ' + storagePathOf(sesB));

    // 关键验证：往 A 的 cookie 罐写一条，B 里读不到 → 证明没共享登录态
    const probe = { url: 'https://creator.douyin.com/', name: '__creatorhub_probe', value: 'A', domain: '.douyin.com', path: '/' };
    await sesA.cookies.set(probe);
    const inA = await sesA.cookies.get({ name: '__creatorhub_probe' });
    const inB = await sesB.cookies.get({ name: '__creatorhub_probe' });
    check('A 账号写入的 Cookie 只存在于 A 分区', inA.length === 1 && inB.length === 0,
      'A=' + inA.length + ' B=' + inB.length);

    /* ---- 登录态守护：在真实 Chromium 上验证「会话型凭据被转成可落盘」 ---- */
    // 不写 expirationDate 就是一条会话型 Cookie，Chromium 默认不会把它写进磁盘，
    // 而这正是「重启应用就要重新登录」的常见成因。
    const sessionProbe = {
      url: 'https://creator.douyin.com/',
      name: '__creatorhub_session_probe',
      value: 'SESSION-LIKE',
      domain: '.douyin.com',
      path: '/',
      secure: true
    };
    await sesA.cookies.set(sessionProbe);
    const beforeHarden = (await sesA.cookies.get({ name: '__creatorhub_session_probe' }))[0];
    check('会话型 Cookie 在加固前确实没有过期时间（这就是掉登录的根因之一）',
      !!beforeHarden && (!beforeHarden.expirationDate || beforeHarden.session === true),
      'session=' + (beforeHarden && beforeHarden.session) + ' exp=' + (beforeHarden && beforeHarden.expirationDate));

    // 只对这个分区跑加固，绝不动 B
    const hardenResult = await sessionGuard.hardenSession(sesA);
    const afterHarden = (await sesA.cookies.get({ name: '__creatorhub_session_probe' }))[0];
    check('加固后会话型 Cookie 拿到了过期时间（因此会被写进磁盘）',
      !!afterHarden && !!afterHarden.expirationDate && afterHarden.expirationDate > Date.now() / 1000 + 300 * 86400,
      'converted=' + hardenResult.converted + ' exp=' + (afterHarden && afterHarden.expirationDate));
    check('加固不改写 Cookie 的值（平台凭据原样保留）',
      !!afterHarden && afterHarden.value === 'SESSION-LIKE',
      afterHarden && afterHarden.value);

    const flushSummary = await sessionGuard.flushNow(true);
    check('落盘+加固可对全部分区批量执行且不报错',
      flushSummary.partitions >= 2 && flushSummary.failed === 0,
      JSON.stringify(flushSummary));
    check('加固后的凭据仍只存在于 A 分区（B 里读不到）',
      (await sesB.cookies.get({ name: '__creatorhub_session_probe' })).length === 0);
    check('守护返回的统计里不含任何凭据值',
      !/SESSION-LIKE/.test(JSON.stringify(flushSummary)),
      JSON.stringify(flushSummary));

    // 清理探针，别给用户留垃圾
    await sesA.cookies.remove('https://creator.douyin.com/', '__creatorhub_probe');
    await sesA.cookies.remove('https://creator.douyin.com/', '__creatorhub_session_probe');

    // 内嵌视图能力
    const rec = ensureView(accA);
    rec.view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
    const viewOk = rec.kind === 'wcv';
    check('内嵌 WebContentsView 可用（每账号一视图）', viewOk, rec.kind);
    if (!viewOk) {
      check('已回退到 BrowserView', rec.kind === 'bv', rec.kind);
    }

    // 分区目录存在性（落盘位置，重启后由此还原登录态）
    await sesA.flushStorageData();
    const dirA = partitionDir(pA);
    check('分区数据落在 userData/Partitions 下', dirA.indexOf(path.join(userDataDir(), 'Partitions')) === 0, dirA);

    const fp = store.exportPayload(state);
    const exportFields = Array.from(
      new Set(
        fp.accounts.reduce((acc, a) => acc.concat(Object.keys(a)), [])
      )
    );
    const credentialWords = ['cookie', 'password', 'passwd', 'token', 'session', 'auth', 'secret'];
    check(
      '导出字段里没有任何 Cookie / 密码类凭据字段',
      !credentialWords.some((w) => exportFields.some((f) => f.toLowerCase().indexOf(w) !== -1)),
      exportFields.join(',')
    );
    check(
      '自检跑在隔离目录，不会污染真实数据',
      path.basename(userDataDir()).indexOf('smoke-') === 0 &&
        path.dirname(userDataDir()) === path.join(app.getPath('appData'), 'CreatorHub'),
      userDataDir()
    );

    const before = state.accounts.length;
    const imp = store.importPayload(state, JSON.parse(JSON.stringify(fp)));
    check('导入可正常执行（按平台+别名去重，不重复建号）', !imp.error && state.accounts.length === before,
      JSON.stringify(imp));

    // 清理冒烟数据
    store.deleteAccount(state, seededA.account.id);
    store.deleteAccount(state, seededB.account.id);

    const failed = results.filter((r) => !r.pass);
    console.log(JSON.stringify({ smoke: failed.length === 0 ? 'PASS' : 'FAIL', results }, null, 2));
    cleanupSmokeDir();
    app.exit(failed.length === 0 ? 0 : 1);
  } catch (err) {
    console.log(JSON.stringify({ smoke: 'ERROR', message: err.stack || String(err), results }, null, 2));
    cleanupSmokeDir();
    app.exit(2);
  }
}

function cleanupSmokeDir() {
  if (!SMOKE_DIR) return;
  try {
    fs.rmSync(SMOKE_DIR, { recursive: true, force: true });
  } catch (e) {
    /* 清理失败不影响结论，下次启动会用新的临时目录 */
  }
}
