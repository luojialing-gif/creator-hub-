/* jsdom 冒烟测试：真正跑一遍渲染层逻辑 */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const FILE = process.argv[2] || path.join(__dirname, '..', 'web', 'creator-hub-web.html');
const html = fs.readFileSync(FILE, 'utf8');

const results = [];
function ok(pass, name, detail) {
  results.push({ pass: !!pass, name, detail: detail === undefined ? '' : String(detail) });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const OPENED = [];
const ERRORS = [];

function makeDom(existingStorage) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => ERRORS.push('jsdomError: ' + (e.message || e)));
  vc.on('error', (m) => ERRORS.push('error: ' + m));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://localhost/',
    virtualConsole: vc,
    beforeParse(window) {
      window.open = function (url) {
        OPENED.push(url);
        return { closed: false };
      };
      Object.defineProperty(window.navigator, 'clipboard', {
        value: { writeText: () => Promise.resolve() },
        configurable: true
      });
      window.URL.createObjectURL = () => 'blob:mock';
      window.URL.revokeObjectURL = () => {};
      if (!window.document.execCommand) window.document.execCommand = () => true;
      // 把 8 秒内嵌超时压缩到 60ms，便于在测试里断言「禁止嵌入」降级路径
      const rawTimeout = window.setTimeout;
      window.setTimeout = function (fn, delay) {
        const d = typeof delay === 'number' && delay >= 5000 ? 60 : delay;
        return rawTimeout.call(window, fn, d);
      };
      if (existingStorage) {
        Object.keys(existingStorage).forEach((k) => window.localStorage.setItem(k, existingStorage[k]));
      }
    }
  });
  return dom;
}

function click(dom, selector) {
  const el = dom.window.document.querySelector(selector);
  if (!el) throw new Error('找不到可点击元素：' + selector);
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  return el;
}

function text(dom, selector) {
  const el = dom.window.document.querySelector(selector);
  return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
}

(async function main() {
  /* ---------------- 1. 初始化 ---------------- */
  const dom = makeDom(null);
  const w = dom.window;
  const d = w.document;
  await sleep(60);

  ok(d.documentElement.getAttribute('data-theme') !== null, '初始化设置主题属性',
     d.documentElement.getAttribute('data-theme'));
  ok(text(dom, '#cards').indexOf('先添加第一个账号') !== -1, '空数据首屏显示空状态而不是空白',
     text(dom, '#cards').slice(0, 40));
  ok(text(dom, '#bannerBox').indexOf('纯网页版无法隔离第三方登录态') !== -1,
     '首屏明确告知纯网页无法隔离第三方登录态');
  ok(d.querySelectorAll('#platformList .side-item').length === 5,
     '左侧列出「全部 + 4 个平台」', d.querySelectorAll('#platformList .side-item').length);
  const platformNames = Array.from(d.querySelectorAll('#platformList .side-name')).map((e) => e.textContent);
  ok(['抖音', '小红书', '视频号', '快手'].every((n) => platformNames.indexOf(n) !== -1),
     '四个平台分组均存在', platformNames.join('/'));

  /* ---------------- 2. 添加账号 ---------------- */
  click(dom, '[data-act="add-account"]');
  ok(!!d.getElementById('f-alias'), '点击「添加账号」弹出表单');
  const urlDefault = d.getElementById('f-url').value;
  ok(urlDefault.indexOf('creator.douyin.com') !== -1, '登录入口 URL 预填平台默认地址', urlDefault);

  d.getElementById('f-alias').value = '抖音·主号';
  d.getElementById('f-note').value = '主力带货号，日更 1 条';
  click(dom, '[data-act="save-account"]');
  await sleep(30);
  ok(text(dom, '#cards').indexOf('抖音·主号') !== -1, '保存后卡片出现在列表中');
  const stored = JSON.parse(w.localStorage.getItem('creator-hub-web.accounts.v1') || '[]');
  ok(stored.length === 1 && stored[0].alias === '抖音·主号', '账号已写入 localStorage',
     JSON.stringify(stored[0] || {}));

  // 表单校验：非法 URL 应被拦下
  click(dom, '[data-act="add-account"]');
  d.getElementById('f-alias').value = '非法URL号';
  d.getElementById('f-url').value = 'creator.douyin.com/xxx';
  click(dom, '[data-act="save-account"]');
  await sleep(30);
  const stillOne = JSON.parse(w.localStorage.getItem('creator-hub-web.accounts.v1') || '[]');
  ok(stillOne.length === 1, '非 http(s) 的 URL 被校验拦下', '当前账号数=' + stillOne.length);
  click(dom, '[data-act="modal-close"]');

  // 空别名应被拦下
  click(dom, '[data-act="add-account"]');
  d.getElementById('f-alias').value = '   ';
  click(dom, '[data-act="save-account"]');
  await sleep(30);
  ok(JSON.parse(w.localStorage.getItem('creator-hub-web.accounts.v1')).length === 1, '空别名被校验拦下');
  click(dom, '[data-act="modal-close"]');

  /* ---------------- 3. 快速创建 3×4 ---------------- */
  click(dom, '[data-act="settings"]');
  await sleep(30);
  click(dom, '[data-act="quick-seed"]');
  await sleep(30);
  const afterSeed = JSON.parse(w.localStorage.getItem('creator-hub-web.accounts.v1'));
  ok(afterSeed.length === 12, '快速创建补齐到每平台 3 个（1 个已有 + 11 个新建）', afterSeed.length);
  const perPlatform = {};
  afterSeed.forEach((a) => { perPlatform[a.platform] = (perPlatform[a.platform] || 0) + 1; });
  ok(Object.keys(perPlatform).length === 4 && Object.values(perPlatform).every((n) => n >= 3),
     '每个平台都 ≥3 个账号', JSON.stringify(perPlatform));

  /* ---------------- 4. 平台切换 + 搜索 ---------------- */
  click(dom, '[data-act="pick-platform"][data-platform="douyin"]');
  await sleep(30);
  ok(d.querySelectorAll('#cards .card').length === 3, '切到抖音后只显示该平台账号',
     d.querySelectorAll('#cards .card').length);
  ok(w.location.hash === '#p=douyin', '平台切换写入 hash 便于深链/刷新保持', w.location.hash);

  d.getElementById('searchInput').value = '账号2';
  d.getElementById('searchInput').dispatchEvent(new w.Event('input', { bubbles: true }));
  await sleep(20);
  ok(d.querySelectorAll('#cards .card').length === 1, '搜索可过滤账号',
     d.querySelectorAll('#cards .card').length);
  d.getElementById('searchInput').value = '';
  d.getElementById('searchInput').dispatchEvent(new w.Event('input', { bubbles: true }));
  await sleep(20);
  ok(d.querySelectorAll('#cards .card').length === 3, '清空搜索后恢复全部');

  d.getElementById('searchInput').value = '不存在的关键词zzz';
  d.getElementById('searchInput').dispatchEvent(new w.Event('input', { bubbles: true }));
  await sleep(20);
  ok(text(dom, '#cards').indexOf('没有匹配的账号') !== -1, '搜索无结果时显示空状态而不是白屏');
  d.getElementById('searchInput').value = '';
  d.getElementById('searchInput').dispatchEvent(new w.Event('input', { bubbles: true }));
  await sleep(20);

  /* ---------------- 5. 打开账号（新标签） ---------------- */
  OPENED.length = 0;
  click(dom, '#cards .card [data-act="open-account"]');
  await sleep(30);
  ok(OPENED.length === 1 && OPENED[0].indexOf('https://') === 0, '点击账号用新标签打开平台',
     OPENED.join(','));
  const openedAcc = JSON.parse(w.localStorage.getItem('creator-hub-web.accounts.v1'))
    .filter((a) => a.lastOpenedAt)[0];
  ok(!!openedAcc, '记录最近打开时间');

  /* ---------------- 6. 复制链接 ---------------- */
  click(dom, '#cards .card [data-act="copy-link"]');
  await sleep(30);
  ok(text(dom, '#toastRoot').indexOf('链接已复制') !== -1, '复制链接给出反馈');

  /* ---------------- 7. 尝试内嵌 → 8 秒无响应判定被拒 ---------------- */
  click(dom, '#cards .card [data-act="try-embed"]');
  await sleep(30);
  ok(!!d.getElementById('embedFrame'), '点击「尝试内嵌」创建 iframe');
  ok(text(dom, '#embedMsgTitle').indexOf('正在尝试内嵌') !== -1, '初始状态为「正在尝试」',
     text(dom, '#embedMsgTitle'));
  await sleep(150);
  ok(text(dom, '#embedMsgTitle') === '该平台禁止嵌入，请点击新标签打开',
     '超时后显示「该平台禁止嵌入，请点击新标签打开」', text(dom, '#embedMsgTitle'));
  ok(d.getElementById('embedMsg').classList.contains('show'), '降级提示可见，不会白屏');

  // 重新尝试后模拟 load 事件 → 走「已加载」分支
  click(dom, '[data-act="embed-reload"]');
  await sleep(30);
  const frame = d.getElementById('embedFrame');
  frame.dispatchEvent(new w.Event('load'));
  await sleep(30);
  ok(!d.getElementById('embedMsg').classList.contains('show'), '收到 load 事件后隐藏提示层');
  ok(text(dom, '#embedStatus').indexOf('已加载') !== -1, '状态文案切到「已加载」',
     text(dom, '#embedStatus'));
  OPENED.length = 0;
  click(dom, '[data-act="embed-newtab"]');
  await sleep(20);
  ok(OPENED.length === 1, '内嵌面板里的「新标签打开」可用');
  click(dom, '[data-act="embed-close"]');
  await sleep(20);
  ok(!d.getElementById('embedFrame'), '收起内嵌后 iframe 被移除');

  /* ---------------- 8. 排序 ---------------- */
  const before = Array.from(d.querySelectorAll('#cards .card')).map((c) => c.querySelector('.card-alias').textContent);
  click(dom, '#cards .card:nth-child(2) [data-act="move-up"]');
  await sleep(30);
  const after = Array.from(d.querySelectorAll('#cards .card')).map((c) => c.querySelector('.card-alias').textContent);
  ok(after[0] === before[1] && after[1] === before[0], '上移按钮改变排序', before.join('>') + ' → ' + after.join('>'));

  /* ---------------- 9. 一键打开（批量） ---------------- */
  OPENED.length = 0;
  click(dom, '[data-act="bulk-open"][data-filter="all"]');
  await sleep(1400);
  ok(OPENED.length === 3, '一键打开当前平台全部账号（3 个）', OPENED.length);
  OPENED.length = 0;
  click(dom, '[data-act="bulk-open"][data-filter="loggedout"]');
  await sleep(900);
  ok(OPENED.length === 1, '可按「未登录」筛选批量打开', OPENED.length);

  /* ---------------- 10. 导出 ---------------- */
  let exported = 0;
  const origClick = w.HTMLAnchorElement.prototype.click;
  w.HTMLAnchorElement.prototype.click = function () { exported += 1; };
  click(dom, '[data-act="export"]');
  await sleep(40);
  ok(exported === 1, '导出触发下载（生成账 JSON 文件）');
  ok(text(dom, '#toastRoot').indexOf('已导出') !== -1, '导出给出数量反馈');
  w.HTMLAnchorElement.prototype.click = origClick;

  /* ---------------- 11. 删除（带二次确认） ---------------- */
  const countBefore = d.querySelectorAll('#cards .card').length;
  click(dom, '#cards .card [data-act="delete-account"]');
  await sleep(20);
  ok(text(dom, '#modalRoot').indexOf('删除账号') !== -1, '删除前弹出确认框');
  click(dom, '[data-act="modal-confirm"]');
  await sleep(40);
  ok(d.querySelectorAll('#cards .card').length === countBefore - 1, '确认后账号被删除',
     d.querySelectorAll('#cards .card').length);
  const afterDelete = JSON.parse(w.localStorage.getItem('creator-hub-web.accounts.v1'));
  ok(afterDelete.length === 11, '删除同步写入 localStorage', afterDelete.length);

  /* ---------------- 12. 设置弹层 ---------------- */
  click(dom, '[data-act="settings"]');
  await sleep(30);
  ok(text(dom, '#modalRoot').indexOf('Chrome') !== -1 && text(dom, '#modalRoot').indexOf('Firefox') !== -1,
     '设置里给出 Chrome 多用户 / Firefox 容器的隔离建议');
  const themeSel = d.getElementById('s-theme');
  themeSel.value = 'dark';
  themeSel.dispatchEvent(new w.Event('change', { bubbles: true }));
  await sleep(30);
  ok(d.documentElement.getAttribute('data-theme') === 'dark', '设置里可切深色模式');
  themeSel.value = 'light';
  themeSel.dispatchEvent(new w.Event('change', { bubbles: true }));
  await sleep(30);
  ok(d.documentElement.getAttribute('data-theme') === 'light', '可切回浅色模式');
  click(dom, '[data-act="modal-close"]');
  await sleep(20);

  /* ---------------- 13. 重载恢复（新 DOM + 预置 storage） ---------------- */
  const snapshot = {
    'creator-hub-web.accounts.v1': w.localStorage.getItem('creator-hub-web.accounts.v1'),
    'creator-hub-web.settings.v1': JSON.stringify({ theme: 'dark', bannerClosed: true, lastPlatform: 'kuaishou' })
  };
  const dom2 = makeDom(snapshot);
  await sleep(60);
  const d2 = dom2.window.document;
  ok(d2.querySelectorAll('#cards .card').length === 3, '重载后恢复到上次平台（快手）的 3 个账号',
     d2.querySelectorAll('#cards .card').length);
  ok(dom2.window.document.documentElement.getAttribute('data-theme') === 'dark', '重载后恢复深色模式');
  ok(text(dom2, '#bannerBox') === '', '已关闭的提示条不再出现');

  /* ---------------- 14. 导入 ---------------- */
  const dom3 = makeDom(null);
  await sleep(60);
  const w3 = dom3.window;
  const d3 = w3.document;
  const importPayload = {
    kind: 'creator-hub-accounts',
    accounts: [
      { platform: 'wxch', alias: '视频号·主号', note: '来自导入', url: 'https://channels.weixin.qq.com/login.html', status: 'pending', sort: 10 },
      { platform: 'wxch', alias: '视频号·小号', url: 'https://channels.weixin.qq.com/login.html', status: 'loggedout', sort: 20 }
    ]
  };
  const fileInput = d3.getElementById('importFile');
  const fakeFile = new w3.File([JSON.stringify(importPayload)], 'accounts.json', { type: 'application/json' });
  Object.defineProperty(fileInput, 'files', { value: [fakeFile], configurable: true });
  fileInput.dispatchEvent(new w3.Event('change', { bubbles: true }));
  await sleep(200);
  const imported = JSON.parse(w3.localStorage.getItem('creator-hub-web.accounts.v1') || '[]');
  ok(imported.length === 2 && imported.every((a) => a.platform === 'wxch'),
     '导入 JSON 后账号写入本地', JSON.stringify(imported.map((a) => a.alias)));
  ok(text(dom3, '#toastRoot').indexOf('导入完成') !== -1, '导入给出结果反馈');

  /* ---------------- 15. 无异常 ---------------- */
  const realErrors = ERRORS.filter((e) => !/Not implemented|Could not load img|css/i.test(e));
  ok(realErrors.length === 0, '全流程无未捕获异常', realErrors.slice(0, 3).join(' | '));

  /* ---------------- 汇总 ---------------- */
  const failed = results.filter((r) => !r.pass);
  console.log('单文件网页版冒烟测试：%d/%d 通过', results.length - failed.length, results.length);
  console.log('-'.repeat(64));
  results.forEach((r) => {
    console.log('%s %s%s', r.pass ? '✓' : '✗', r.name, r.detail && !r.pass ? '  → ' + r.detail : '');
  });
  if (failed.length) {
    console.log('\n失败项：');
    failed.forEach((f) => console.log('  ✗ ' + f.name + '  → ' + f.detail));
    process.exit(1);
  }
  console.log('\n全部通过。');
  process.exit(0);
})().catch((e) => {
  console.error('冒烟测试崩溃：', e && e.stack || e);
  process.exit(2);
});
