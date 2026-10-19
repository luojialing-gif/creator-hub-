/* 生成两个「预览副本」用于无头截图。种子数据只存在于预览副本，绝不进入交付文件。 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(require('os').tmpdir(), 'creatorhub-preview');
fs.mkdirSync(OUT, { recursive: true });

const PLATFORMS = [
  { id: 'douyin', name: '抖音', abbr: '抖', entry: 'https://creator.douyin.com/creator-micro/home' },
  { id: 'xhs', name: '小红书', abbr: '书', entry: 'https://creator.xiaohongshu.com/publish/publish?source=&published=true' },
  { id: 'wxch', name: '视频号', abbr: '视', entry: 'https://channels.weixin.qq.com/login.html' },
  { id: 'kuaishou', name: '快手', abbr: '快', entry: 'https://cp.kuaishou.com/article/manage/video?status=1&from=publish' }
];
const NAMES = {
  douyin: ['抖音·主号', '抖音·矩阵号A', '抖音·矩阵号B'],
  xhs: ['小红书·主号', '小红书·种草号', '小红书·品牌号'],
  wxch: ['视频号·主号', '视频号·情感号', '视频号·知识号'],
  kuaishou: ['快手·主号', '快手·本地号', '快手·带货号']
};
const NOTES = {
  0: '主力账号，日更 1 条，重点看发布后的 2 小时数据',
  1: '矩阵小号，搬运与二次剪辑，待排期',
  2: '新起的测试号，还没开始运营'
};
const STATUS = ['normal', 'pending', 'loggedout'];

function accounts(forElectron) {
  const out = [];
  PLATFORMS.forEach((p) => {
    NAMES[p.id].forEach((alias, i) => {
      const a = {
        id: 'acc_' + p.id + '_' + (i + 1),
        platform: p.id,
        alias: alias,
        note: NOTES[i],
        url: p.entry,
        postLoginUrl: p.id === 'wxch' ? 'https://channels.weixin.qq.com/platform/post/list' : '',
        status: STATUS[i],
        sort: (i + 1) * 10,
        slot: i + 1,
        createdAt: Date.now() - (30 - i) * 86400000,
        lastOpenedAt: i === 0 ? Date.now() - 42 * 60000 : i === 1 ? Date.now() - 5 * 3600000 : null
      };
      if (forElectron) {
        a.partition = 'persist:' + p.id + '-account-' + (i + 1);
        a.partitionDir = '/Users/you/Library/Application Support/CreatorHub/Partitions/' + p.id + '-account-' + (i + 1);
        a.partitionExists = i === 0;
      }
      out.push(a);
    });
  });
  return out;
}

/* ---------- 1. Electron 渲染层预览（带 mock 的 window.hub） ---------- */
(function buildElectronPreview() {
  let html = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src/renderer/styles.css'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');

  const mock = `
<script>
/* ===== 预览专用：模拟 preload 暴露的 window.hub（不进入交付文件） ===== */
(function () {
  var ACCOUNTS = ${JSON.stringify(accounts(true))};
  var PLATFORMS = ${JSON.stringify(PLATFORMS.map((p, i) => Object.assign({}, p, {
    color: ['#20232E', '#FF2442', '#07C160', '#FF6A00'][i],
    colorDark: ['#9AA3B8', '#FF5C70', '#2FD07F', '#FF8A3D'][i],
    note: '', loginHint: '', embedBlocked: true
  })))};
  var noop = function () { return Promise.resolve({ ok: true }); };
  window.hub = {
    boot: function () {
      return Promise.resolve({
        platforms: PLATFORMS, accounts: ACCOUNTS,
        settings: { theme: 'light', spoofChromeUA: true, keepViewsAlive: true, lastPlatform: 'all', lastAccountId: null },
        statuses: ['normal', 'pending', 'loggedout', 'disabled'],
        statusLabel: { normal: '正常', pending: '待发布', loggedout: '未登录', disabled: '停用' },
        env: { platformLabel: 'darwin', electron: '33.2.0', chrome: '130.0.6723.0', node: '20.18.0',
               userData: '/Users/you/Library/Application Support/CreatorHub',
               stateFile: '/Users/you/Library/Application Support/CreatorHub/accounts.json', dark: false }
      });
    },
    saveAccount: noop, deleteAccount: noop, reorder: noop, move: noop, updateSettings: noop,
    exportAccounts: noop, importAccounts: noop, seedAccounts: noop,
    diagnostics: function () {
      return Promise.resolve({
        userData: '/Users/you/Library/Application Support/CreatorHub',
        stateFile: '/Users/you/Library/Application Support/CreatorHub/accounts.json',
        dataDir: '/Users/you/Library/Application Support/CreatorHub',
        partitions: ACCOUNTS.map(function (a) { return { accountId: a.id, alias: a.alias, platform: a.platform, partition: a.partition, dir: a.partitionDir, exists: a.partitionExists }; }),
        activeViews: [], versions: { electron: '33.2.0', chrome: '130.0.6723.0', node: '20.18.0' }
      });
    },
    openView: function () { return Promise.resolve({ ok: true, state: { url: 'https://creator.douyin.com/creator-micro/home', loading: true, canGoBack: false, canGoForward: false } }); },
    openWindow: noop, openMany: noop, closeView: noop, setViewBounds: noop, hideView: noop, showView: noop,
    viewNav: noop, viewLoad: noop, releaseBackgroundViews: noop, clearAccountData: noop,
    copy: noop, openExternal: noop, openPath: noop,
    onViewState: function () {}, onViewFailed: function () {}, onViewActivated: function () {},
    onViewClosed: function () {}, onNotice: function () {}, onWindowResized: function () {}
  };
})();
<\/script>`;

  html = html.replace('<link rel="stylesheet" href="styles.css" />', '<style>\n' + css + '\n</style>');
  // 预览副本把脚本内联进来，而 index.html 的 CSP 禁止内联脚本，故预览时移除 CSP 声明
  // （交付文件保留 CSP：它通过 <script src="app.js"> 从自身加载，不受影响）
  html = html.replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/, '');
  html = html.replace('<script src="app.js"></script>', mock + '\n<script>\n' + app + '\n<\/script>');
  fs.writeFileSync(path.join(OUT, 'electron-ui.html'), html, 'utf8');
  console.log('已生成 <tmp>/creatorhub-preview/electron-ui.html');
})();

/* ---------- 2. 网页版预览（预置 localStorage 种子） ---------- */
(function buildWebPreview() {
  let html = fs.readFileSync(path.join(ROOT, 'web/creator-hub-web.html'), 'utf8');
  const seed = `
<script>
/* ===== 预览专用：预置 localStorage 种子数据（不进入交付文件） ===== */
(function () {
  var data = {
    'creator-hub-web.accounts.v1': ${JSON.stringify(JSON.stringify(accounts(false)))},
    'creator-hub-web.settings.v1': JSON.stringify({ theme: 'light', bannerClosed: false, lastPlatform: 'all' })
  };
  var mem = {};
  function shim() {
    Object.keys(data).forEach(function (k) { mem[k] = data[k]; });
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
        setItem: function (k, v) { mem[k] = String(v); },
        removeItem: function (k) { delete mem[k]; },
        clear: function () { mem = {}; }
      }
    });
  }
  try {
    localStorage.setItem('__probe', '1');
    localStorage.removeItem('__probe');
    Object.keys(data).forEach(function (k) { localStorage.setItem(k, data[k]); });
  } catch (e) {
    shim();
  }
})();
<\/script>`;
  html = html.replace('<script>', seed + '\n<script>');
  fs.writeFileSync(path.join(OUT, 'web-light.html'), html, 'utf8');

  // 深色 + 单平台视图（走 hash 深链）
  fs.writeFileSync(path.join(OUT, 'web-dark.html'), html.replace("theme: 'light'", "theme: 'dark'"), 'utf8');
  console.log('已生成 web-light.html、web-dark.html');
})();
