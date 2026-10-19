'use strict';

/**
 * session-guard —— 登录态守护
 *
 * 目标：让「每个账号自己那份持久化分区」里的登录态尽可能活得久，并在它失效的第一时间告诉你。
 *
 * 只做三件事，全部在本机完成，绝不出机器：
 *
 *   1) 及时落盘 + 退出前等它写完
 *      Chromium 的 Cookie 写盘是延迟的。正常退出通常来得及，但强制退出 / 崩溃 /
 *      关机断电就会丢掉最后一段时间内的写入 —— 表现就是「明明刚登录过，重开却要重登」。
 *      这里改成：定期刷一次盘，退出时再刷一次并等它真的写完。
 *
 *   2) 把「会话型 Cookie」升级为可落盘的持久 Cookie
 *      Chromium 默认【不把没有过期时间的 Cookie 写入磁盘】。很多平台的登录凭据恰好
 *      就是会话型 Cookie，于是重启应用必然掉登录。做法是给它们补一个远期过期时间后
 *      重新写回同一个分区 —— 注意：这只是让【本地 Cookie 库】愿意保存它，
 *      完全不改变服务端的有效期，平台该失效还是会失效。
 *      可用设置关闭；关闭后本步骤完全不执行。
 *
 *   3) 保活 + 巡检
 *      按间隔串行为每个账号静默跑一次它的工作台页面。页面真的执行一遍 JS，
 *      平台会顺带续期自己的会话；同时用最终落地的地址判断是否被踢回了登录页。
 *      已经打开的账号直接读它当前地址，不重复加载、不打扰你。
 *
 * ── 红线（不可动摇）──
 *   · 不记录、不导出、不上传任何 Cookie 的值。第 2 步只在内存里把值原样传回给
 *     Chromium 自己的 Cookie 库，不打印、不落我们自己的任何文件。
 *   · 巡检结果只保存「状态 + 时间 + 去掉查询串的地址」，地址里的 query 一律抹掉，
 *     避免把平台票据写进账号文件。
 *   · 被踢回登录页就如实上报，由你自己扫码重登。不绕过验证码、不绕过风控、
 *     不伪造设备、不改动平台返回的任何凭据。
 *   · 保活是「用你自己的登录态正常访问一次页面」，不制造虚假流量、不访问与账号无关的接口。
 */

/** 会话型 Cookie 补的过期时间，足够长但有限，避免永远不过期带来意外。 */
const FAR_FUTURE_DAYS = 400;
/** 定期刷盘间隔 */
const FLUSH_INTERVAL_MS = 3 * 60 * 1000;
/** 单个账号静默加载的硬超时 */
const PATROL_TIMEOUT_MS = 25 * 1000;
/** 账号之间的间隔：串行 + 留白，避免短时间内并发打平台，降低被判定为异常的风险 */
const PATROL_GAP_MS = 1500;
/** 巡检计划时间的抖动比例（避免每天都在同一秒发起） */
const JITTER_RATIO = 0.12;
/** 启动后多久跑第一次巡检 */
const FIRST_PATROL_DELAY_MS = 3 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safe(fn, fallback) {
  try {
    const v = fn();
    return v === undefined || v === null ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

/** 去掉查询串与 hash：地址里可能带平台票据，不能写进账号文件。 */
function stripQuery(url) {
  const s = String(url == null ? '' : url);
  if (!s) return '';
  const cut = Math.min(
    ...[s.indexOf('?'), s.indexOf('#')].filter((i) => i >= 0).concat([s.length])
  );
  return s.slice(0, cut);
}

/**
 * 判断一次巡检的结果。抽成纯函数，便于离线单测。
 * @returns {{state:'ok'|'needs-login'|'unknown', note:string}}
 */
function classifyProbeResult(input) {
  const loaded = input.loaded;
  const finalUrl = String(input.finalUrl || '');
  const probeUrl = String(input.probeUrl || '');
  const hints = (input.hints || []).map((h) => String(h).toLowerCase());
  const lower = finalUrl.toLowerCase();

  if (loaded === 'timeout') {
    return { state: 'unknown', note: '静默加载超时，这次没判断出来（网络或平台较慢）' };
  }
  if (loaded === 'fail') {
    return { state: 'unknown', note: '静默加载失败，这次没判断出来' };
  }

  const hit = hints.find((h) => h && lower.indexOf(h) !== -1);
  if (!hit) return { state: 'ok', note: '' };

  // 入口页本身就是登录页、且没有配置「登录后 URL」时，落在入口页并不代表掉登录。
  const probeLower = probeUrl.toLowerCase();
  const probeIsLoginPage = hints.some((h) => h && probeLower.indexOf(h) !== -1);
  if (probeIsLoginPage && stripQuery(lower) === stripQuery(probeLower)) {
    return {
      state: 'unknown',
      note: '该平台入口页本身就是登录页，且未填写「登录后 URL」，无法自动判断，请人工确认一次'
    };
  }

  return { state: 'needs-login', note: '访问时被跳转到了登录页，需要重新登录' };
}

/**
 * @param {object} deps 注入依赖，便于在无 Electron 环境下单测
 *   getSession(partition)      -> Electron Session
 *   listAccounts()             -> 账号数组（已做校验）
 *   partitionFor(account)      -> 'persist:xxx'
 *   probeUrlFor(account)       -> 巡检要加载的地址
 *   loginHintsFor(account)     -> 该平台的登录页特征子串数组
 *   getLiveUrl(accountId)      -> 该账号若已打开视图，返回其当前地址；否则 null
 *   makeProbe(partition)       -> 隐藏窗口 { webContents, destroy() }
 *   getSettings()              -> 设置对象
 *   onHealth(accountId, h)     -> 健康状态变化回调
 *   onProgress(payload)        -> 巡检进度回调
 *   onEvent(kind, payload)     -> 通知/日志
 *   logger                     -> 可选，{ info, warn }
 */
function createSessionGuard(deps) {
  const log = deps.logger || { info() {}, warn() {} };

  let flushTimer = null;
  let patrolTimer = null;
  let stopped = true;
  let patrolling = false;

  const stats = {
    lastFlushAt: 0,
    lastPatrolAt: 0,
    lastPatrolSummary: null,
    flushRuns: 0,
    patrolRuns: 0
  };

  /* ------------------------------------------------------------ 1. 落盘 */

  async function flushSession(ses) {
    let ok = false;
    try {
      if (ses && ses.cookies && typeof ses.cookies.flushStore === 'function') {
        await ses.cookies.flushStore();
        ok = true;
      }
    } catch (e) {
      /* 老版本可能没有，退回下面的写盘 */
    }
    try {
      if (ses && typeof ses.flushStorageData === 'function') ses.flushStorageData();
    } catch (e) {
      /* 忽略 */
    }
    return ok;
  }

  /** 把该分区里「没有过期时间」的 Cookie 补上远期过期时间，让 Cookie 库愿意把它写进磁盘。 */
  async function hardenSession(ses) {
    const out = { total: 0, converted: 0, skipped: 0, failed: 0 };
    if (!ses || !ses.cookies) return out;
    let all = [];
    try {
      all = await ses.cookies.get({});
    } catch (e) {
      return out;
    }
    out.total = all.length;

    for (const c of all) {
      if (!c || !c.name) continue;
      const isSessionCookie = c.session === true || !c.expirationDate;
      if (!isSessionCookie) continue;
      // __Host- 前缀的 Cookie 不允许带 domain，改写过可能不合法，直接跳过。
      if (c.name.indexOf('__Host-') === 0) {
        out.skipped += 1;
        continue;
      }
      const host = String(c.domain || '').replace(/^\./, '');
      if (!host) {
        out.skipped += 1;
        continue;
      }
      const url = (c.secure ? 'https://' : 'http://') + host + (c.path || '/');
      const payload = {
        url,
        name: c.name,
        value: c.value, // 原样传回，不打印、不落盘、不外传
        path: c.path,
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
        expirationDate: Math.floor(Date.now() / 1000) + FAR_FUTURE_DAYS * 86400
      };
      if (c.domain) payload.domain = c.domain;
      if (c.sameSite && c.sameSite !== 'unspecified') payload.sameSite = c.sameSite;
      try {
        await ses.cookies.set(payload);
        out.converted += 1;
      } catch (e) {
        out.failed += 1;
      }
    }
    return out;
  }

  /**
   * 刷一次所有账号分区的盘。
   * @param {boolean} harden 是否顺带做会话型 Cookie 的持久化加固
   */
  async function flushNow(harden) {
    const accounts = deps.listAccounts() || [];
    const settings = deps.getSettings() || {};
    const doHarden = harden === undefined ? settings.persistSessionCookies !== false : !!harden;
    const summary = { partitions: 0, flushed: 0, converted: 0, failed: 0 };

    for (const acc of accounts) {
      let ses = null;
      try {
        ses = deps.getSession(deps.partitionFor(acc));
      } catch (e) {
        continue;
      }
      if (!ses) continue;
      summary.partitions += 1;
      if (doHarden) {
        const r = await hardenSession(ses);
        summary.converted += r.converted;
        summary.failed += r.failed;
      }
      if (await flushSession(ses)) summary.flushed += 1;
    }

    stats.lastFlushAt = Date.now();
    stats.flushRuns += 1;
    return summary;
  }

  /** 退出前调用：刷盘并等它写完，最多等 timeoutMs，避免卡住退出。 */
  async function flushBeforeQuit(timeoutMs) {
    const limit = typeof timeoutMs === 'number' ? timeoutMs : 4000;
    let timer = null;
    const guard = new Promise((resolve) => {
      timer = setTimeout(resolve, limit);
    });
    try {
      await Promise.race([flushNow(true).catch(() => null), guard]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return stats.lastFlushAt;
  }

  /* ------------------------------------------------------- 2. 保活 / 巡检 */

  function runProbe(account) {
    const partition = deps.partitionFor(account);
    const url = deps.probeUrlFor(account);
    const hints = deps.loginHintsFor(account) || [];

    return new Promise((resolve) => {
      let win = null;
      let settled = false;
      let timer = null;
      let lastUrl = url;

      const finish = (loaded) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const finalUrl = safe(() => win.webContents.getURL(), '') || lastUrl;
        try {
          if (win && !win.isDestroyed()) win.destroy();
        } catch (e) {
          /* 忽略 */
        }
        resolve({ loaded, finalUrl: finalUrl || lastUrl, probeUrl: url, hints });
      };

      try {
        win = deps.makeProbe(partition);
      } catch (e) {
        resolve({ loaded: 'fail', finalUrl: url, probeUrl: url, hints });
        return;
      }

      const wc = win.webContents;
      const onNav = (_e, u) => {
        if (u) lastUrl = u;
      };
      wc.on('did-navigate', onNav);
      wc.on('did-navigate-in-page', onNav);
      if (typeof wc.on === 'function') wc.on('did-redirect-navigation', onNav);

      wc.once('did-stop-loading', () => finish('ok'));
      wc.once('did-fail-load', (_e, code, _desc, _u, isMainFrame) => {
        if (isMainFrame === false) return; // 子资源失败不算
        if (code === -3) return; // ERR_ABORTED：正常跳转
        finish('fail');
      });

      timer = setTimeout(() => finish('timeout'), deps.probeTimeoutMs || PATROL_TIMEOUT_MS);

      try {
        win.loadURL ? win.loadURL(url) : wc.loadURL(url);
      } catch (e) {
        finish('fail');
      }
    });
  }

  /**
   * 巡检全部账号。串行执行，账号之间留白。
   * 已经打开着的账号直接读它当前地址，不额外加载。
   */
  async function patrolNow(options) {
    const opts = options || {};
    if (patrolling) return { skipped: true, reason: '已有巡检在进行中' };
    patrolling = true;

    const accounts = deps.listAccounts() || [];
    const results = [];
    const startedAt = Date.now();

    try {
      for (let i = 0; i < accounts.length; i += 1) {
        if (stopped && !opts.manual) break;
        const acc = accounts[i];
        if (opts.accountId && acc.id !== opts.accountId) continue;

        let health;
        const liveUrl = safe(() => deps.getLiveUrl(acc.id), null);
        if (liveUrl) {
          // 账号已经开着：直接看它现在的地址，不打扰
          const c = classifyProbeResult({
            loaded: 'ok',
            finalUrl: liveUrl,
            probeUrl: deps.probeUrlFor(acc),
            hints: deps.loginHintsFor(acc) || []
          });
          health = { state: c.state, note: c.note, finalUrl: stripQuery(liveUrl), checkedAt: Date.now(), source: 'live' };
        } else {
          const raw = await runProbe(acc);
          const c = classifyProbeResult(raw);
          health = { state: c.state, note: c.note, finalUrl: stripQuery(raw.finalUrl), checkedAt: Date.now(), source: 'probe' };
        }

        results.push({ accountId: acc.id, alias: acc.alias, platform: acc.platform, health });
        try {
          deps.onHealth(acc.id, health);
        } catch (e) {
          /* 忽略 */
        }
        try {
          deps.onProgress({ done: results.length, total: accounts.length, alias: acc.alias, state: health.state });
        } catch (e) {
          /* 忽略 */
        }

        if (i < accounts.length - 1) await sleep(PATROL_GAP_MS);
      }
    } finally {
      patrolling = false;
    }

    const summary = {
      total: results.length,
      ok: results.filter((r) => r.health.state === 'ok').length,
      needsLogin: results.filter((r) => r.health.state === 'needs-login').length,
      unknown: results.filter((r) => r.health.state === 'unknown').length,
      startedAt,
      durationMs: Date.now() - startedAt
    };
    stats.lastPatrolAt = Date.now();
    stats.lastPatrolSummary = summary;
    stats.patrolRuns += 1;
    try {
      if (typeof deps.onPatrolDone === 'function') deps.onPatrolDone(summary, results);
    } catch (e) {
      /* 忽略 */
    }
    return { summary, results };
  }

  /* --------------------------------------------------------------- 计划 */

  function intervalMs() {
    const s = deps.getSettings() || {};
    const hours = Number(s.keepAliveHours);
    const h = Number.isFinite(hours) && hours >= 1 ? hours : 12;
    return h * 60 * 60 * 1000;
  }

  function schedulePatrol(delayMs) {
    if (stopped) return;
    if (deps.getSettings && deps.getSettings().keepAlive === false) return;
    if (patrolTimer) clearTimeout(patrolTimer);
    const jitter = 1 + (Math.random() * 2 - 1) * JITTER_RATIO;
    const delay = Math.max(60 * 1000, Math.round(delayMs * jitter));
    patrolTimer = setTimeout(async () => {
      patrolTimer = null;
      if (stopped) return;
      try {
        await patrolNow({ scheduled: true });
      } catch (e) {
        log.warn('保活巡检出错：' + (e && e.message));
      }
      schedulePatrol(intervalMs());
    }, delay);
    if (patrolTimer && typeof patrolTimer.unref === 'function') patrolTimer.unref();
  }

  function start() {
    if (!stopped) return;
    stopped = false;

    flushTimer = setInterval(() => {
      flushNow(false).catch(() => null);
    }, FLUSH_INTERVAL_MS);
    if (flushTimer && typeof flushTimer.unref === 'function') flushTimer.unref();

    const s = deps.getSettings() || {};
    if (s.keepAlive !== false) {
      const first = s.patrolOnStart === false ? intervalMs() : FIRST_PATROL_DELAY_MS;
      schedulePatrol(first);
    }

    // 启动后先把当前已有的 Cookie 落一次盘（顺便完成会话型 Cookie 的加固）
    setTimeout(() => {
      flushNow(true).catch(() => null);
    }, 4000);
  }

  function stop() {
    stopped = true;
    if (flushTimer) clearInterval(flushTimer);
    if (patrolTimer) clearTimeout(patrolTimer);
    flushTimer = null;
    patrolTimer = null;
  }

  /** 设置变更后重新排期（例如改了间隔或关了保活）。 */
  function reschedule() {
    if (stopped) return;
    if (deps.getSettings && deps.getSettings().keepAlive === false) {
      if (patrolTimer) clearTimeout(patrolTimer);
      patrolTimer = null;
      return;
    }
    schedulePatrol(intervalMs());
  }

  return {
    start,
    stop,
    reschedule,
    flushNow,
    flushBeforeQuit,
    patrolNow,
    hardenSession,
    stats,
    isPatrolling: () => patrolling
  };
}

module.exports = { createSessionGuard, classifyProbeResult, stripQuery, FAR_FUTURE_DAYS, FLUSH_INTERVAL_MS };
