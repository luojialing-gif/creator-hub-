/* 数据层单元测试：直接用 Node 跑 store.js（不依赖 Electron） */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require(path.join(__dirname, '..', 'src', 'store.js'));

const results = [];
function ok(pass, name, detail) {
  results.push({ pass: !!pass, name, detail: detail === undefined ? '' : String(detail) });
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorhub-store-'));
store.init(dir);

// 1. 空目录首次载入
let r = store.load();
ok(r.state.accounts.length === 0, '空目录首次载入不报错、账号为空', JSON.stringify(r.state.accounts));
ok(r.state.settings.theme === 'system', '默认主题为跟随系统');

// 2. 新增账号 + slot 分配
const a1 = store.upsertAccount(r.state, { platform: 'douyin', alias: '抖音1', url: 'https://creator.douyin.com/creator-micro/home' });
const a2 = store.upsertAccount(r.state, { platform: 'douyin', alias: '抖音2', url: 'https://creator.douyin.com/creator-micro/home' });
const a3 = store.upsertAccount(r.state, { platform: 'douyin', alias: '抖音3', url: 'https://creator.douyin.com/creator-micro/home' });
ok(!a1.error && !a2.error && !a3.error, '可为同一平台连续创建 3 个账号');
ok(a1.account.slot === 1 && a2.account.slot === 2 && a3.account.slot === 3,
  'slot 自增且互不重复（决定登录态分区名）',
  [a1.account.slot, a2.account.slot, a3.account.slot].join(','));

// 3. 校验
ok(!!store.upsertAccount(r.state, { platform: 'douyin', alias: '' }).error, '空别名被拒绝');
ok(!!store.upsertAccount(r.state, { platform: 'weibo', alias: 'x' }).error, '未知平台被拒绝');
ok(!!store.upsertAccount(r.state, { platform: 'douyin', alias: 'x', url: 'creator.douyin.com' }).error,
  '非法 URL 被拒绝');

// 4. 编辑账号时 slot 保持不变（否则登录态会丢）
const edited = store.upsertAccount(r.state, { id: a2.account.id, platform: 'douyin', alias: '抖音2-改名', note: '改过备注' });
ok(edited.account.slot === a2.account.slot && edited.account.alias === '抖音2-改名',
  '编辑账号后别名更新且 slot 保持稳定', 'slot=' + edited.account.slot);
ok(r.state.accounts.length === 3, '编辑不会新建账号', r.state.accounts.length);

// 5. 落盘 + 重新载入
store.save(r.state);
const reload = store.load();
ok(reload.state.accounts.length === 3, '落盘后重新载入账号数量一致', reload.state.accounts.length);
ok(reload.state.accounts.find((a) => a.alias === '抖音2-改名'),
  '重载后别名与备注被正确还原');

// 6. 排序
const before = store.listAccounts(reload.state).map((a) => a.alias).join('>');
store.move(reload.state, a1.account.id, 'down');
const after = store.listAccounts(reload.state).map((a) => a.alias).join('>');
ok(before !== after, '下移改变顺序', before + ' → ' + after);

store.reorder(reload.state, 'douyin', [a3.account.id, a1.account.id, a2.account.id]);
const reordered = store.listAccounts(reload.state).map((a) => a.alias).join('>');
ok(reordered === '抖音3>抖音1>抖音2-改名', '整组重排生效', reordered);

// 6b. 新建账号的排序值递增（否则「上移/下移」静默失效）
ok(a1.account.sort === 10 && a2.account.sort === 20 && a3.account.sort === 30,
  '同平台新建账号的排序值递增（10/20/30）',
  [a1.account.sort, a2.account.sort, a3.account.sort].join(','));

// 6c. 历史脏数据：sort 全相同时，「上移/下移」也要真的改变顺序
const equalState = { version: 1, settings: store.defaultSettings(), accounts: [] };
['A', 'B', 'C'].forEach((n) => {
  equalState.accounts.push({ id: 'eq_' + n, platform: 'xhs', alias: n, url: 'https://creator.xiaohongshu.com/', slot: 0, sort: 100, createdAt: 1, status: 'normal' });
});
store.move(equalState, 'eq_B', 'up');
ok(store.listAccounts(equalState).map((a) => a.alias).join('') === 'BAC',
  'sort 全部相同时上移依然生效（历史数据自动规整）',
  store.listAccounts(equalState).map((a) => a.alias).join(''));

// 7. 导出不含凭据
const payload = store.exportPayload(reload.state);
const accountFields = Array.from(new Set(payload.accounts.flatMap((a) => Object.keys(a))));
ok(!accountFields.some((f) => /cookie|password|passwd|token|session|auth/i.test(f)),
  '导出字段里没有 cookie/password/token 之类的凭据字段', accountFields.join(','));
ok(JSON.stringify(payload.accounts).indexOf('cookie=') === -1 &&
   JSON.stringify(payload.accounts).indexOf('sessionid') === -1,
  '导出内容里不出现任何会话串');
ok(payload.accounts.length === 3 && payload.accounts[0].slot !== undefined,
  '导出包含 slot（保证导入后登录态仍能对上）');

// 8. 导入：同平台同别名 → 更新而不重复建号，且 slot 保留
const snapshot = JSON.parse(JSON.stringify(payload));
snapshot.accounts[0].alias = payload.accounts[0].alias;
snapshot.accounts[0].note = '通过导入更新';
snapshot.accounts.push({ platform: 'wxch', alias: '视频号1', url: 'https://channels.weixin.qq.com/login.html', status: 'loggedout' });
const imp = store.importPayload(reload.state, snapshot);
ok(imp.added === 1 && imp.updated === 3 && reload.state.accounts.length === 4,
  '导入按「平台+别名」去重：新增 1、更新 3', JSON.stringify(imp));
const keptSlot = reload.state.accounts.find((a) => a.alias === payload.accounts[0].alias).slot;
ok(keptSlot === payload.accounts[0].slot, '导入更新时保留原 slot（登录态不丢）', keptSlot);

// 9. 删除
store.deleteAccount(reload.state, a1.account.id);
ok(reload.state.accounts.length === 3, '删除账号生效', reload.state.accounts.length);

// 10. 数据文件损坏 → 从备份恢复，不抛异常
store.save(reload.state);                 // 产生一份备份
store.save(reload.state);                 // 备份 = 当前内容
fs.writeFileSync(store.paths.statePath, '{ 这不是 JSON', 'utf8');
const recovered = store.load();
ok(recovered.recovered !== null || recovered.state.accounts.length > 0,
  '主文件损坏时回退到备份 / 空状态且不抛异常',
  'recovered=' + recovered.recovered + ' accounts=' + recovered.state.accounts.length);

// 11. slot 冲突的脏数据（手工改坏文件）也能被修正
const dirty = JSON.parse(JSON.stringify(store.exportPayload(reload.state)));
dirty.accounts.push({ platform: 'douyin', alias: '手工加的', url: 'https://creator.douyin.com/', slot: 1, sort: 5 });
fs.writeFileSync(store.paths.statePath, JSON.stringify({ version: 1, settings: {}, accounts: dirty.accounts }), 'utf8');
const fixed = store.load();
const douyinSlots = fixed.state.accounts.filter((a) => a.platform === 'douyin').map((a) => a.slot);
ok(new Set(douyinSlots).size === douyinSlots.length,
  '同平台 slot 冲突会被自动重新分配', douyinSlots.join(','));

// 12. load 不依赖 this（脱离实例调用也能工作）
ok(typeof store.load.call(null) === 'object', 'load 不依赖 this，可被独立调用');

// 13. 异常输入不崩
let threw = false;
try {
  store.importPayload(reload.state, null);
  store.importPayload(reload.state, { accounts: 'not-array' });
  store.upsertAccount(reload.state, null);
  store.reorder(reload.state, 'nope', []);
} catch (e) {
  threw = e.message;
}
ok(!threw, '非法入参不抛异常，只返回 error', threw);

fs.rmSync(dir, { recursive: true, force: true });

const failed = results.filter((x) => !x.pass);
console.log('数据层测试：%d/%d 通过', results.length - failed.length, results.length);
results.forEach((x) => console.log('%s %s%s', x.pass ? '✓' : '✗', x.name, !x.pass && x.detail ? '  → ' + x.detail : ''));
if (failed.length) process.exit(1);
console.log('\n数据层全部通过。');
