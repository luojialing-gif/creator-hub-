'use strict';

/**
 * session-guard 离线测试。
 * 这块逻辑决定两件要紧的事：
 *   ① 会不会「误报掉登录」——误报比不报更糟，会让人白白重登一遍；
 *   ② 第三方凭据会不会被写进我们自己的文件——这是红线，必须自动化守住。
 * 运行：npm run test:guard
 */

const path = require('path');
const fs = require('fs');

const { createSessionGuard, classifyProbeResult, stripQuery } = require(path.join(__dirname, '..', 'src', 'session-guard.js'));
const { PLATFORMS, getPlatform } = require(path.join(__dirname, '..', 'src', 'shared', 'platforms.js'));
const store = require(path.join(__dirname, '..', 'src', 'store.js'));

let pass = 0;
let fail = 0;
function ok(cond, name, detail) {
  if (cond) {
    pass += 1;
    console.log('  ✓ ' + name);
  } else {
    fail += 1;
    console.log('  ✗ ' + name + (detail === undefined ? '' : '  → ' + detail));
  }
}
function section(t) {
  console.log('\n' + t);
}

/** 造一个假的 Electron session，只实现守护用到的几个方法 */
function fakeSession(initial) {
  const jar = initial.slice();
  const self = {
    jar,
    flushed: 0,
    cookies: {
      get: async () => jar.slice(),
      set: async (c) => {
        const i = jar.findIndex((x) => x.name === c.name && x.domain === c.domain);
        if (i >= 0) jar[i] = Object.assign({}, jar[i], c);
        else jar.push(Object.assign({}, c));
      },
      flushStore: async () => {}
    },
    flushStorageData() {
      self.flushed += 1;
    }
  };
  return self;
}

/** 造一个会「加载完成」的假探针窗口；finalUrl 决定巡检结论 */
function fakeProbe(finalUrl, counter) {
  return {
    webContents: {
      getURL: () => finalUrl,
      on: () => {},
      once: (ev, cb) => {
        if (ev === 'did-stop-loading') setTimeout(cb, 0);
      },
      loadURL: () => {},
      isDestroyed: () => false
    },
    isDestroyed: () => false,
    destroy: () => {
      if (counter) counter.destroyed += 1;
    }
  };
}

(async function main() {
  section('1. 地址清洗（平台票据不能进账号文件）');
  ok(stripQuery('https://a.com/x?ticket=abc#frag') === 'https://a.com/x', '去掉 query 与 hash', stripQuery('https://a.com/x?ticket=abc#frag'));
  ok(stripQuery('https://a.com/x') === 'https://a.com/x', '无 query 时原样保留');
  ok(stripQuery('') === '' && stripQuery(null) === '', '空值安全');

  section('2. 巡检结果判定（假阳性最容易出在这里）');
  const douyin = getPlatform('douyin');
  const xhs = getPlatform('xhs');
  const wxch = getPlatform('wxch');

  const judgement = (finalUrl, probeUrl, p, loaded) =>
    classifyProbeResult({ loaded: loaded || 'ok', finalUrl, probeUrl, hints: p.loginHints });

  ok(judgement('https://creator.douyin.com/creator-micro/home', douyin.entry, douyin).state === 'ok',
    '停在抖音工作台 → 正常');

  ok(judgement('https://sso.douyin.com/login/?next=/creator-micro/home', douyin.entry, douyin).state === 'needs-login',
    '被跳到抖音 sso → 需重登');

  ok(judgement('https://creator.xiaohongshu.com/login', 'https://creator.xiaohongshu.com/publish/publish', xhs).state === 'needs-login',
    '被跳到小红书登录页 → 需重登');

  ok(judgement('https://sso.douyin.com/login/', douyin.entry, douyin, 'timeout').state === 'unknown',
    '超时 → 判为「未确认」而不是「需重登」（不凭猜测报警）');

  ok(judgement('', douyin.entry, douyin, 'fail').state === 'unknown',
    '加载失败 → 判为「未确认」');

  ok(judgement('https://cp.kuaishou.com/article/manage/video', 'https://cp.kuaishou.com/article/manage/video', getPlatform('kuaishou')).state === 'ok',
    '快手工作台 → 正常');

  // 视频号：入口页本身就叫 login.html，不能因为停在入口页就报「需重登」
  ok(judgement(wxch.entry, wxch.entry, wxch).state === 'unknown',
    '视频号未填「登录后 URL」且停在入口页 → 不给结论（不误报）');
  ok(judgement(wxch.entry, 'https://channels.weixin.qq.com/platform', wxch).state === 'needs-login',
    '视频号填了「登录后 URL」却被打回 login.html → 需重登');
  ok(judgement('https://channels.weixin.qq.com/platform/home', 'https://channels.weixin.qq.com/platform', wxch).state === 'ok',
    '视频号在工作台 → 正常');

  section('3. 每个平台都配齐巡检参数（新品台漏配会静默失效）');
  PLATFORMS.forEach((p) => {
    ok(Array.isArray(p.loginHints) && p.loginHints.length > 0, p.name + ' 配了登录页特征');
    ok(p.healthProbe === 'entry' || p.healthProbe === 'post', p.name + ' 配了巡检地址类型');
  });

  section('4. 落盘与凭据加固');
  const sA = fakeSession([
    // 会话型：无 expirationDate、session: true —— 这正是「重启就掉登录」的元凶
    { name: 'sessionid', value: 'SECRET-A', domain: '.douyin.com', path: '/', secure: true, httpOnly: true, session: true },
    // 已经是持久型：不该动它
    { name: 'persisted', value: 'SECRET-B', domain: '.douyin.com', path: '/', secure: true, expirationDate: 1893456000, session: false },
    // __Host- 前缀不允许带 domain，必须跳过
    { name: '__Host-x', value: 'SECRET-C', domain: '.douyin.com', path: '/', secure: true, session: true }
  ]);
  const sB = fakeSession([{ name: 'did', value: 'SECRET-D', domain: '.kuaishou.com', path: '/', secure: true, session: true }]);

  // 分区名形如 persist:douyin-account-1。务必按分区精确取，不能模糊匹配，
  // 否则两个账号会拿到同一个假 session，测出来的是假象（踩过一次）。
  const sessions = { 'persist:douyin-account-1': sA, 'persist:kuaishou-account-1': sB };

  const baseDeps = {
    getSession: (partition) => sessions[partition] || null,
    listAccounts: () => [
      { id: 'a1', alias: 'A', platform: 'douyin', slot: 1 },
      { id: 'a2', alias: 'B', platform: 'kuaishou', slot: 1 }
    ],
    partitionFor: (acc) => 'persist:' + acc.platform + '-account-' + acc.slot,
    probeUrlFor: (acc) => (getPlatform(acc.platform) || {}).entry || '',
    loginHintsFor: (acc) => (getPlatform(acc.platform) || {}).loginHints || [],
    getLiveUrl: () => null,
    makeProbe: () => {
      throw new Error('本用例不应创建探针');
    },
    getSettings: () => ({ persistSessionCookies: true }),
    probeTimeoutMs: 300,
    onHealth: () => {},
    onProgress: () => {},
    onPatrolDone: () => {}
  };

  const guard = createSessionGuard(baseDeps);
  const summary = await guard.flushNow(true);

  ok(summary.partitions === 2, '两个分区都处理了', JSON.stringify(summary));
  ok(summary.converted === 2, '两个分区各转存 1 项会话型凭据', JSON.stringify(summary));
  ok(summary.failed === 0, '没有写入失败');
  ok(sA.flushed === 1 && sB.flushed === 1, '两个分区都做了 flushStorageData', sA.flushed + '/' + sB.flushed);

  const hardened = sA.jar.find((c) => c.name === 'sessionid');
  ok(!!hardened.expirationDate && hardened.expirationDate > Date.now() / 1000 + 300 * 86400,
    '会话型凭据被补上远期过期时间', String(hardened.expirationDate));
  ok(hardened.value === 'SECRET-A', '凭据值原样回写（不改写内容）');
  ok(sA.jar.find((c) => c.name === 'persisted').expirationDate === 1893456000, '本来就是持久型的不被动过');
  ok(!sA.jar.find((c) => c.name === '__Host-x').expirationDate, '__Host- 前缀的安全跳过');

  ok(!/SECRET-[A-D]/.test(JSON.stringify(summary)), '返回值里只有计数，不含任何凭据值', JSON.stringify(summary));
  ok(!fs.existsSync(path.join(__dirname, '..', 'accounts.json')), '加固过程不会在项目目录里产生账号文件');

  section('5. 关掉开关后完全不动凭据');
  const sC = fakeSession([{ name: 'sid', value: 'Z', domain: '.douyin.com', path: '/', secure: true, session: true }]);
  const guard2 = createSessionGuard(Object.assign({}, baseDeps, {
    getSession: () => sC,
    listAccounts: () => [{ id: 'b1', platform: 'douyin', slot: 1 }]
  }));
  const sum2 = await guard2.flushNow(false);
  ok(!sC.jar[0].expirationDate && sum2.converted === 0, 'persistSessionCookies 关闭时一个字都不改');
  ok(sC.flushed === 1, '但仍然会刷盘（刷盘不碰内容，只是让它落盘）');

  section('6. 巡检：开着的账号读当前地址，没开的才建探针');
  const probeStat = { created: 0, destroyed: 0 };
  const liveUrls = {
    a1: 'https://creator.douyin.com/creator-micro/home', // 已打开且正常
    a2: null // 未打开 → 需要探针
  };

  const guard3 = createSessionGuard(Object.assign({}, baseDeps, {
    getLiveUrl: (id) => liveUrls[id],
    makeProbe: () => {
      probeStat.created += 1;
      return fakeProbe('https://sso.douyin.com/login/', probeStat);
    }
  }));

  const r1 = await guard3.patrolNow({ manual: true });
  ok(probeStat.created === 1, '只为「未打开」的那 1 个账号建探针', 'created=' + probeStat.created);
  ok(probeStat.destroyed === 1, '探针用完即销毁（不残留后台进程）');
  ok(r1.results.length === 2, '两个账号都出了结果');
  ok(r1.results[0].health.state === 'ok' && r1.results[0].health.source === 'live', '已打开的账号直接读当前地址判定');
  ok(r1.results[1].health.state === 'needs-login', '未打开的账号靠探针判定');

  section('7. 探针只判定、不注入（超时与失败都不冤枉账号）');
  const guard4 = createSessionGuard(Object.assign({}, baseDeps, {
    listAccounts: () => [{ id: 't1', alias: 'T', platform: 'douyin', slot: 1 }],
    getLiveUrl: () => null,
    makeProbe: () => ({
      webContents: {
        getURL: () => '',
        on: () => {},
        once: () => {}, // 永远不回调 → 只能靠超时收尾
        loadURL: () => {},
        isDestroyed: () => false
      },
      isDestroyed: () => false,
      destroy: () => {}
    })
  }));
  const r4 = await guard4.patrolNow({ manual: true });
  ok(r4.results[0].health.state === 'unknown', '探针超时 → unknown（不是 needs-login）', r4.results[0].health.state);
  ok(r4.summary.unknown === 1 && r4.summary.needsLogin === 0, '超时不会被算进「需重登」', JSON.stringify(r4.summary));

  const badProbe = createSessionGuard(Object.assign({}, baseDeps, {
    listAccounts: () => [{ id: 't2', alias: 'T2', platform: 'douyin', slot: 1 }],
    getLiveUrl: () => null,
    makeProbe: () => {
      throw new Error('窗口创建失败');
    }
  }));
  const r5 = await badProbe.patrolNow({ manual: true });
  ok(r5.results[0].health.state === 'unknown', '探针创建失败 → unknown，不瞎报');

  section('8. 巡检结果落盘后依然干净');
  const st = { version: 1, settings: store.defaultSettings(), accounts: [] };
  const created = store.upsertAccount(st, { platform: 'douyin', alias: '测试号', url: douyin.entry });
  store.setHealth(st, created.account.id, {
    state: 'needs-login',
    checkedAt: Date.now(),
    note: '被跳转到登录页',
    finalUrl: 'https://sso.douyin.com/login/?ticket=SHOULD_NOT_PERSIST#x',
    source: 'probe'
  });
  const acc = st.accounts[0];
  ok(acc.health.state === 'needs-login', 'health 写入成功');
  ok(acc.health.finalUrl === 'https://sso.douyin.com/login/', 'health 里的地址去掉了 query', acc.health.finalUrl);
  ok(JSON.stringify(acc).indexOf('SHOULD_NOT_PERSIST') === -1, '票据值没有进账号文件');
  ok(store.setHealth(st, created.account.id, { state: '瞎写' }).error, '非法状态被拒绝');

  const payload = store.exportPayload(st);
  ok(!('health' in payload.accounts[0]), '导出里不含巡检结果（换台机器没意义）');
  ok(JSON.stringify(payload).indexOf('SHOULD_NOT_PERSIST') === -1, '导出里不含票据');

  section('9. 编辑账号不会把巡检结果弄丢');
  const edited = store.upsertAccount(st, { id: created.account.id, alias: '改个名', platform: 'douyin', status: 'pending' });
  ok(!edited.error && edited.account.health && edited.account.health.state === 'needs-login', '改别名后 health 仍在');

  section('10. 设置在加载时被收敛到合法范围');
  ok(store.normalizeSettings({ keepAliveHours: 999 }, store.defaultSettings()).keepAliveHours === 72, '过大间隔夹到 72');
  ok(store.normalizeSettings({ keepAliveHours: 0 }, store.defaultSettings()).keepAliveHours === 1, '过小间隔夹到 1');
  ok(store.normalizeSettings({ keepAlive: false }, store.defaultSettings()).keepAlive === false, '布尔开关生效');
  ok(store.normalizeSettings({ 乱来: 1 }, store.defaultSettings()).乱来 === undefined, '未知字段被丢弃');
  ok(store.defaultSettings().persistSessionCookies === true, '会话型凭据持久化默认开启');

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项。');
  console.log(fail === 0 ? '守护模块测试全部通过。' : fail + ' 项失败。');
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('测试异常：', err && err.stack);
  process.exit(2);
});
