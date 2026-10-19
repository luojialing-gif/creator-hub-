'use strict';

/**
 * 数据层：账号与设置只保存在本地 JSON 文件里。
 *
 * 存的东西：平台、别名、备注、登录入口 URL、登录后 URL、排序、状态标签、slot。
 * 不存的东西：第三方平台密码、Cookie、localStorage 内容。
 *   —— 登录态由 Electron 的 persist 分区自行落盘，本模块完全不碰，
 *      因此导出的 JSON 里天然不含任何登录凭据。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PLATFORM_IDS, isValidPlatform, getPlatform } = require('./shared/platforms');

const STATE_VERSION = 1;
const STATUSES = ['normal', 'pending', 'loggedout', 'disabled'];

/** 登录态巡检结果的合法状态。'unknown' 表示这次没测出来（超时/失败），不代表掉登录。 */
const HEALTH_STATES = ['ok', 'needs-login', 'unknown'];

/**
 * 规范化 health 字段。
 * 刻意只保留「状态 + 时间 + 去掉查询串的地址」——地址里的 ?ticket=... 之类的平台票据
 * 一律不进账号文件，避免把凭据写进可用文本编辑的 JSON。
 */
function normalizeHealth(input) {
  if (!input || typeof input !== 'object') return null;
  const state = HEALTH_STATES.indexOf(input.state) !== -1 ? input.state : null;
  if (!state) return null;
  const checkedAt = Number(input.checkedAt);
  const health = {
    state,
    checkedAt: Number.isFinite(checkedAt) && checkedAt > 0 ? Math.round(checkedAt) : 0,
    note: cleanString(input.note, 200),
    finalUrl: cleanString(String(input.finalUrl || '').split(/[?#]/)[0], 300),
    source: input.source === 'live' ? 'live' : 'probe'
  };
  return health;
}
const STATUS_LABEL = {
  normal: '正常',
  pending: '待发布',
  loggedout: '未登录',
  disabled: '停用'
};

let baseDir = null;
let statePath = null;
let backupPath = null;

function init(dir) {
  baseDir = dir;
  statePath = path.join(dir, 'accounts.json');
  backupPath = path.join(dir, 'accounts.backup.json');
}

function uid(prefix) {
  return prefix + '_' + crypto.randomBytes(5).toString('hex');
}

function now() {
  return Date.now();
}

function defaultSettings() {
  return {
    theme: 'system', // system | light | dark
    spoofChromeUA: true, // 去掉 UA 里的 Electron 标识，避免平台给出异常页面
    keepViewsAlive: true, // 切走账号后是否保留其后台视图（保持内存中的登录态与队列任务）
    // ---- 登录态持久化 ----
    persistSessionCookies: true, // 把「无过期时间」的会话型 Cookie 转为可落盘，避免重启就掉登录
    flushOnQuit: true, // 退出前等待 Cookie 写入磁盘
    keepAlive: true, // 定时静默访问各账号工作台：既续期，也顺便检测是否被踢
    keepAliveHours: 12, // 保活/巡检间隔（小时）
    patrolOnStart: true, // 启动约 3 分钟后自动巡检一次，开机即可看到各账号登录态
    lastPlatform: 'all',
    lastAccountId: null
  };
}

function defaultState() {
  return { version: STATE_VERSION, settings: defaultSettings(), accounts: [] };
}

/* ------------------------------------------------------------------ 校验 */

function cleanString(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/\s+/g, ' ').trim().slice(0, max || 200);
}

function cleanUrl(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) return null; // null = 非法
  try {
    const u = new URL(s);
    return u.toString();
  } catch (e) {
    return null;
  }
}

/**
 * 把任意来源（IPC / 导入 JSON）的账号对象规范化为可信结构。
 * existing 存在时表示这是更新，缺失字段沿用旧值。
 */
function normalizeAccount(input, existing, accounts) {
  const src = input || {};
  const base = existing || {};

  let platform = cleanString(src.platform, 32) || base.platform;
  if (!isValidPlatform(platform)) return { error: '平台不合法' };

  const alias = cleanString(src.alias, 60) || base.alias;
  if (!alias) return { error: '账号别名不能为空' };

  let entryUrl = base.url || (getPlatform(platform) || {}).entry || '';
  if (src.url !== undefined) {
    const cleaned = cleanUrl(src.url);
    if (cleaned === null) return { error: '登录入口 URL 必须以 http:// 或 https:// 开头' };
    entryUrl = cleaned || entryUrl;
  }

  let postLoginUrl = base.postLoginUrl || '';
  if (src.postLoginUrl !== undefined) {
    const cleaned = cleanUrl(src.postLoginUrl);
    if (cleaned === null) return { error: '登录后 URL 必须以 http:// 或 https:// 开头' };
    postLoginUrl = cleaned;
  }

  let status = cleanString(src.status, 16) || base.status || 'normal';
  if (STATUSES.indexOf(status) === -1) status = 'normal';

  let sort = base.sort;
  if (src.sort !== undefined && src.sort !== null && src.sort !== '') {
    const n = Number(src.sort);
    sort = Number.isFinite(n) ? Math.max(0, Math.round(n)) : base.sort;
  }
  // 新账号若未显式指定排序，则追加到该平台末尾。
  // （若一律取同一个默认值，后续「上移/下移」交换两个相同的 sort 会看起来毫无反应。）
  const selfId = base.id || cleanString(src.id, 64) || '';
  if (!Number.isFinite(sort)) sort = nextSort(platform, accounts, selfId);

  const account = {
    id: selfId || uid('acc'),
    platform,
    alias,
    note: src.note !== undefined ? cleanString(src.note, 500) : base.note || '',
    url: entryUrl,
    postLoginUrl,
    status,
    sort,
    slot: base.slot || 0,
    createdAt: base.createdAt || now(),
    lastOpenedAt: base.lastOpenedAt || null,
    // 登录态巡检结果。编辑账号时原样保留（它不是用户输入，而是本机探测出来的状态）。
    health: normalizeHealth(base.health || src.health)
  };

  if (!account.slot) account.slot = nextSlot(platform, accounts, account.id);
  return { account };
}

/** 分配一个平台内不重复的 slot；slot 一旦分配就不再变化（partition 名依赖它保持稳定）。 */
function nextSlot(platform, accounts, exceptId) {
  let max = 0;
  (accounts || []).forEach((a) => {
    if (a.platform !== platform) return;
    if (exceptId && a.id === exceptId) return;
    if (a.slot > max) max = a.slot;
  });
  return max + 1;
}

/** 平台内最大排序值 + 10，保证新账号排在同平台末尾。 */
function nextSort(platform, accounts, exceptId) {
  let max = 0;
  (accounts || []).forEach((a) => {
    if (a.platform !== platform) return;
    if (exceptId && a.id === exceptId) return;
    if (Number.isFinite(a.sort) && a.sort > max) max = a.sort;
  });
  return max + 10;
}

/** 把某平台的排序值规整为 10/20/30…（值重复时用于恢复可交换性）。 */
function normalizeSorts(state, platform) {
  state.accounts
    .filter((a) => a.platform === platform)
    .sort((a, b) => (a.sort - b.sort) || (a.createdAt - b.createdAt))
    .forEach((a, i) => {
      a.sort = (i + 1) * 10;
    });
}

/* ------------------------------------------------------------------ 读写 */

function readJSON(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : null;
  } catch (e) {
    return null;
  }
}

function writeJSON(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file); // 原子替换，避免写一半断电留下坏文件
}

/**
 * 载入状态。任何异常都不抛出，而是回退到备份 / 空状态，
 * 保证应用永远不会因为数据文件损坏而白屏。
 */
function load() {
  let raw = readJSON(statePath);
  let recovered = null;

  if (!raw || !Array.isArray(raw.accounts)) {
    const backup = readJSON(backupPath);
    if (backup && Array.isArray(backup.accounts)) {
      raw = backup;
      recovered = '主数据文件不可读，已从备份恢复';
    } else {
      raw = defaultState();
    }
  }

  const accounts = [];
  const seenIds = new Set();
  const seenSlots = new Set();

  (raw.accounts || []).forEach((a) => {
    const res = normalizeAccount(a, null, accounts);
    if (res.error) return;
    const acc = res.account;
    if (seenIds.has(acc.id)) acc.id = uid('acc');
    // 同一平台内 slot 冲突时重新分配，保证 partition 唯一
    const slotKey = acc.platform + ':' + acc.slot;
    if (seenSlots.has(slotKey)) acc.slot = nextSlot(acc.platform, accounts, acc.id);
    seenSlots.add(acc.platform + ':' + acc.slot);
    seenIds.add(acc.id);
    accounts.push(acc);
  });

  const settings = normalizeSettings(raw.settings || {}, defaultSettings());
  if (!['system', 'light', 'dark'].includes(settings.theme)) settings.theme = 'system';

  return { state: { version: STATE_VERSION, settings, accounts }, recovered };
}

function save(state) {
  // 每次保存前留一份上一版备份，作为数据文件损坏时的兜底
  try {
    if (fs.existsSync(statePath)) fs.copyFileSync(statePath, backupPath);
  } catch (e) {
    /* 备份失败不影响主流程 */
  }
  writeJSON(statePath, state);
}

/* -------------------------------------------------------------- 业务操作 */

function listAccounts(state) {
  return state.accounts.slice().sort((a, b) => {
    const pi = PLATFORM_IDS.indexOf(a.platform) - PLATFORM_IDS.indexOf(b.platform);
    if (pi !== 0) return pi;
    if (a.sort !== b.sort) return a.sort - b.sort;
    return a.createdAt - b.createdAt;
  });
}

function upsertAccount(state, payload) {
  const existing = payload && payload.id ? state.accounts.find((a) => a.id === payload.id) : null;
  const res = normalizeAccount(payload, existing, state.accounts);
  if (res.error) return { error: res.error };

  const acc = res.account;
  if (existing) {
    const idx = state.accounts.indexOf(existing);
    state.accounts[idx] = acc;
  } else {
    state.accounts.push(acc);
  }
  save(state);
  return { account: acc, created: !existing };
}

function deleteAccount(state, id) {
  const idx = state.accounts.findIndex((a) => a.id === id);
  if (idx === -1) return { error: '账号不存在' };
  const [removed] = state.accounts.splice(idx, 1);
  save(state);
  return { account: removed };
}

/** 整组重排：orderedIds 是该平台下的完整顺序。 */
function reorder(state, platform, orderedIds) {
  if (!isValidPlatform(platform) || !Array.isArray(orderedIds)) return { error: '参数不合法' };
  const samePlatform = state.accounts.filter((a) => a.platform === platform);
  const map = new Map(samePlatform.map((a) => [a.id, a]));
  let seq = 10;
  orderedIds.forEach((id) => {
    const acc = map.get(id);
    if (acc) {
      acc.sort = seq;
      seq += 10;
      map.delete(id);
    }
  });
  // 没出现在 orderedIds 里的账号追加到末尾，避免排序时凭空丢账号
  Array.from(map.values())
    .sort((a, b) => a.sort - b.sort)
    .forEach((acc) => {
      acc.sort = seq;
      seq += 10;
    });
  save(state);
  return { ok: true };
}

function move(state, id, dir) {
  const acc = state.accounts.find((a) => a.id === id);
  if (!acc) return { error: '账号不存在' };
  let list = state.accounts.filter((a) => a.platform === acc.platform).sort((a, b) => (a.sort - b.sort) || (a.createdAt - b.createdAt));
  const i = list.indexOf(acc);
  const j = dir === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= list.length) return { ok: true, moved: false };
  const other = list[j];

  if (acc.sort === other.sort) {
    // 历史数据里可能存在 sort 相同的账号，先规整成 10/20/30… 再交换，否则顺序看起来不会变
    normalizeSorts(state, acc.platform);
    list = state.accounts.filter((a) => a.platform === acc.platform).sort((a, b) => (a.sort - b.sort) || (a.createdAt - b.createdAt));
  }
  const tmp = acc.sort;
  acc.sort = other.sort;
  other.sort = tmp;
  save(state);
  return { ok: true, moved: true };
}

/**
 * 写入某账号的登录态巡检结果。
 * 只接受规范化后的 health（状态 / 时间 / 去 query 的地址），其它一律丢弃。
 */
function setHealth(state, id, health) {
  const acc = state.accounts.find((a) => a.id === id);
  if (!acc) return { error: '账号不存在' };
  const next = normalizeHealth(health);
  if (!next) return { error: 'health 不合法' };
  acc.health = next;
  save(state);
  return { account: acc };
}

/** 把设置收敛到允许的范围，避免手工改 JSON 或旧数据带来离谱的值。 */
function normalizeSettings(patch, base) {
  const out = Object.assign({}, base || {});
  const src = patch || {};
  if (['system', 'light', 'dark'].indexOf(src.theme) !== -1) out.theme = src.theme;
  ['spoofChromeUA', 'keepViewsAlive', 'persistSessionCookies', 'flushOnQuit', 'keepAlive', 'patrolOnStart'].forEach((k) => {
    if (typeof src[k] === 'boolean') out[k] = src[k];
  });
  if (src.keepAliveHours !== undefined) {
    const n = Number(src.keepAliveHours);
    if (Number.isFinite(n)) out.keepAliveHours = Math.min(72, Math.max(1, Math.round(n)));
  }
  ['lastPlatform', 'lastAccountId'].forEach((k) => {
    if (typeof src[k] === 'string') out[k] = src[k];
  });
  return out;
}

/** 导出：只导出账号配置与外观设置，绝不含任何第三方登录凭据。 */
function exportPayload(state) {
  return {
    kind: 'creator-hub-accounts',
    version: STATE_VERSION,
    exportedAt: new Date().toISOString(),
    note: '仅包含账号配置（别名/备注/URL/排序/状态）。不包含任何第三方平台密码或登录 Cookie。',
    settings: {
      theme: state.settings.theme,
      spoofChromeUA: state.settings.spoofChromeUA,
      keepViewsAlive: state.settings.keepViewsAlive,
      persistSessionCookies: state.settings.persistSessionCookies,
      keepAlive: state.settings.keepAlive,
      keepAliveHours: state.settings.keepAliveHours
    },
    accounts: listAccounts(state).map((a) => ({
      platform: a.platform,
      alias: a.alias,
      note: a.note,
      url: a.url,
      postLoginUrl: a.postLoginUrl,
      status: a.status,
      sort: a.sort,
      slot: a.slot
    }))
  };
}

/** 导入：按「平台 + 别名」去重，已存在的更新配置但保留原 slot（即保留原登录态）。 */
function importPayload(state, payload) {
  if (!payload || !Array.isArray(payload.accounts)) return { error: '文件格式不正确，缺少 accounts 数组' };

  let added = 0;
  let updated = 0;
  let skipped = 0;

  payload.accounts.forEach((item) => {
    const platform = cleanString(item && item.platform, 32);
    const alias = cleanString(item && item.alias, 60);
    if (!isValidPlatform(platform) || !alias) {
      skipped += 1;
      return;
    }
    const existing = state.accounts.find((a) => a.platform === platform && a.alias === alias);
    if (existing) {
      const res = upsertAccount(state, Object.assign({}, item, { id: existing.id, slot: existing.slot }));
      if (res.error) skipped += 1;
      else updated += 1;
    } else {
      const res = upsertAccount(state, item);
      if (res.error) skipped += 1;
      else added += 1;
    }
  });

  if (payload.settings && typeof payload.settings === 'object') {
    if (['system', 'light', 'dark'].includes(payload.settings.theme)) state.settings.theme = payload.settings.theme;
    if (typeof payload.settings.spoofChromeUA === 'boolean') state.settings.spoofChromeUA = payload.settings.spoofChromeUA;
    if (typeof payload.settings.keepViewsAlive === 'boolean') state.settings.keepViewsAlive = payload.settings.keepViewsAlive;
  }

  save(state);
  return { added, updated, skipped };
}

module.exports = {
  init,
  load,
  save,
  listAccounts,
  upsertAccount,
  deleteAccount,
  reorder,
  move,
  setHealth,
  normalizeHealth,
  normalizeSettings,
  exportPayload,
  importPayload,
  defaultSettings,
  nextSlot,
  uid,
  STATUSES,
  STATUS_LABEL,
  HEALTH_STATES,
  get paths() {
    return { statePath, backupPath, baseDir };
  }
};
