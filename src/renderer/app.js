/* ===================================================================
   CreatorHub 渲染层
   约束：渲染层不直接接触账号数据以外的任何系统能力，
        所有落盘 / 视图 / 剪贴板操作都走 window.hub（preload 白名单）。
   架构约束：render* 之间互不调用，统一由 refreshAll() 按固定顺序调度。
   =================================================================== */

(function () {
  'use strict';

  var API = window.hub;

  var state = {
    platforms: [],
    accounts: [],
    settings: {},
    statuses: [],
    statusLabel: {},
    env: {},
    ui: {
      platform: 'all',
      q: '',
      mode: 'list', // list | browser
      activeId: null,
      viewState: null,
      viewError: null,
      modalOpen: false,
      dragId: null,
      drop: null,
      patrolling: false,
      patrolDone: 0,
      patrolTotal: 0,
      patrolSummary: null
    }
  };

  var STATUS_ORDER = ['normal', 'pending', 'loggedout', 'disabled'];

  /* 卡片「技术详情」展开状态：纯界面偏好，仅存在内存里，不落盘、不影响数据 */
  var extraOpen = {};

  /* ============================================================ 工具函数 */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function $(id) {
    return document.getElementById(id);
  }

  function platformOf(id) {
    for (var i = 0; i < state.platforms.length; i += 1) {
      if (state.platforms[i].id === id) return state.platforms[i];
    }
    return { id: id, name: id, abbr: '?', color: '#888', entry: '', note: '' };
  }

  function statusLabel(s) {
    return state.statusLabel[s] || s;
  }

  /* ---------------------------------------------------- 登录态巡检结果 */

  /**
   * 把 health 转成界面上好读的一行。
   * 注意：'unknown' 是「这次没测出来」，不等于掉登录；文案上必须区分，否则会造成误判和恐慌。
   */
  function healthInfo(a) {
    var h = a && a.health;
    if (!h || !h.checkedAt) {
      return { key: 'untested', label: '登录态未检测', tone: 'idle', when: '', tip: '点上方「巡检登录态」立即检测全部账号' };
    }
    var when = fmtAgo(h.checkedAt);
    if (h.state === 'ok') {
      return { key: 'ok', label: '登录态正常', tone: 'ok', when: when, tip: '检测于 ' + when + (h.note ? '；' + h.note : '') };
    }
    if (h.state === 'needs-login') {
      return {
        key: 'needs-login',
        label: '疑似需要重新登录',
        tone: 'warn',
        when: when,
        tip: '检测于 ' + when + '：' + (h.note || '访问时被跳转到了登录页') + '。点「打开工作台」重新扫码即可，该账号的其它账号不受影响。'
      };
    }
    return { key: 'unknown', label: '登录态未能确认', tone: 'idle', when: when, tip: '检测于 ' + when + '：' + (h.note || '这次没能判断出来，下次巡检会重试') };
  }

  function fmtAgo(ts) {
    if (!ts) return '未知时间';
    var diff = Date.now() - ts;
    if (diff < 60 * 1000) return '刚刚';
    if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前';
    return Math.floor(diff / 86400000) + ' 天前';
  }

  function healthCounts(list) {
    var c = { ok: 0, 'needs-login': 0, unknown: 0, untested: 0 };
    (list || []).forEach(function (a) {
      var k = a.health && a.health.checkedAt ? a.health.state : 'untested';
      if (c[k] === undefined) c.untested += 1;
      else c[k] += 1;
    });
    return c;
  }

  function fmtTime(ts) {
    if (!ts) return '从未打开';
    var d = new Date(ts);
    var diff = Date.now() - ts;
    if (diff < 60 * 1000) return '刚刚打开';
    if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前打开';
    if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前打开';
    function p(n) {
      return n < 10 ? '0' + n : String(n);
    }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function accountsOf(platformId) {
    return state.accounts.filter(function (a) {
      return platformId === 'all' ? true : a.platform === platformId;
    });
  }

  function filteredAccounts() {
    var q = state.ui.q.trim().toLowerCase();
    return accountsOf(state.ui.platform).filter(function (a) {
      if (!q) return true;
      var p = platformOf(a.platform);
      return (
        (a.alias || '').toLowerCase().indexOf(q) !== -1 ||
        (a.note || '').toLowerCase().indexOf(q) !== -1 ||
        (a.url || '').toLowerCase().indexOf(q) !== -1 ||
        (a.postLoginUrl || '').toLowerCase().indexOf(q) !== -1 ||
        p.name.toLowerCase().indexOf(q) !== -1
      );
    });
  }

  function findAccount(id) {
    for (var i = 0; i < state.accounts.length; i += 1) {
      if (state.accounts[i].id === id) return state.accounts[i];
    }
    return null;
  }

  function setAccountsFromResponse(res) {
    if (res && Array.isArray(res.accounts)) state.accounts = res.accounts;
  }

  /* ============================================================ 主题 */

  function resolvedTheme() {
    var t = state.settings.theme || 'system';
    if (t === 'system') return state.env.dark ? 'dark' : 'light';
    return t;
  }

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', resolvedTheme());
  }

  /** 把 shared/platforms.js 里的平台色注入 CSS 变量，深浅色各一套。 */
  function injectPlatformCSS() {
    var light = [];
    var dark = [];
    state.platforms.forEach(function (p) {
      light.push('[data-platform="' + p.id + '"]{--pc:' + p.color + '}');
      dark.push('html[data-theme="dark"] [data-platform="' + p.id + '"]{--pc:' + (p.colorDark || p.color) + '}');
    });
    var el = document.createElement('style');
    el.id = 'platform-colors';
    el.textContent = light.join('') + dark.join('');
    document.head.appendChild(el);
  }

  /* ============================================================ 渲染 */

  function renderSidebar() {
    var host = $('platformList');
    if (!host) return;
    var html = '';
    var total = state.accounts.length;
    html +=
      '<button class="side-item' +
      (state.ui.platform === 'all' ? ' active' : '') +
      '" data-act="pick-platform" data-platform="all">' +
      '<span class="side-dot" style="background:linear-gradient(135deg,#4356d6,#7a5cf0)"></span>' +
      '<span class="side-name">全部账号</span>' +
      '<span class="side-count">' +
      total +
      '</span></button>';

    state.platforms.forEach(function (p) {
      var n = state.accounts.filter(function (a) {
        return a.platform === p.id;
      }).length;
      html +=
        '<button class="side-item' +
        (state.ui.platform === p.id ? ' active' : '') +
        '" data-act="pick-platform" data-platform="' +
        p.id +
        '" data-platform-attr="' +
        p.id +
        '" style="--pc:' +
        (resolvedTheme() === 'dark' ? p.colorDark || p.color : p.color) +
        '">' +
        '<span class="side-dot"></span>' +
        '<span class="side-name">' +
        esc(p.name) +
        '</span>' +
        '<span class="side-count">' +
        n +
        '</span></button>';
    });
    host.innerHTML = html;
  }

  function renderHead() {
    var host = $('listHead');
    if (!host) return;
    var list = filteredAccounts();
    var title = state.ui.platform === 'all' ? '全部账号' : platformOf(state.ui.platform).name;
    var counts = { normal: 0, pending: 0, loggedout: 0, disabled: 0 };
    list.forEach(function (a) {
      if (counts[a.status] !== undefined) counts[a.status] += 1;
    });

    var html = '';
    html +=
      '<div class="panel-title"><h2>' +
      esc(title) +
      '</h2><span class="muted">' +
      list.length +
      ' 个账号' +
      (state.ui.q ? '（筛选自 ' + accountsOf(state.ui.platform).length + ' 个）' : '') +
      '</span></div>';
    html += '<div class="spacer"></div>';

    if (list.length) {
      html +=
        '<span class="badge-chip" title="状态标签统计">正常 ' +
        counts.normal +
        ' · 待发布 ' +
        counts.pending +
        ' · 未登录 ' +
        counts.loggedout +
        ' · 停用 ' +
        counts.disabled +
        '</span>';

      var hc = healthCounts(list);
      var hchipCls = hc['needs-login'] > 0 ? ' badge-chip warn' : '';
      html +=
        '<span class="badge-chip' + hchipCls + '" title="登录态巡检结果（本机检测，不代表平台端的真实有效期）">' +
        '登录态：正常 ' + hc.ok +
        (hc['needs-login'] ? ' · <b>需重登 ' + hc['needs-login'] + '</b>' : '') +
        (hc.unknown ? ' · 未确认 ' + hc.unknown : '') +
        (hc.untested ? ' · 未检测 ' + hc.untested : '') +
        '</span>';

      html +=
        '<div class="btn-group">' +
        '<button class="btn" data-act="patrol-all" title="静默访问每个账号的工作台，检测登录态是否还在（同时顺带续期会话）">' +
        (state.ui.patrolling
          ? '巡检中 ' + state.ui.patrolDone + '/' + state.ui.patrolTotal + '…'
          : '巡检登录态') +
        '</button>' +
        '<button class="btn" data-act="bulk-menu" data-scope="platform">一键打开…</button>' +
        '</div>';
    }
    host.innerHTML = html;
  }

  function renderCards() {
    var host = $('cards');
    if (!host) return;
    var list = filteredAccounts();

    if (!list.length) {
      var isAll = state.ui.platform === 'all';
      var noAccountAtAll = state.accounts.length === 0;
      host.style.display = 'block';
      host.innerHTML =
        '<div class="empty">' +
        '<div class="empty-mark">' +
        '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M3 7h18v13H3z"/><path d="M8 7V5h8v2"/></svg>' +
        '</div>' +
        '<h3>' +
        (state.ui.q ? '没有匹配的账号' : noAccountAtAll ? '先添加第一个账号' : '这个平台下还没有账号') +
        '</h3>' +
        '<p>' +
        (state.ui.q
          ? '换个关键词试试，或清空搜索框查看全部账号。'
          : noAccountAtAll
            ? '每个账号会获得一份独立的登录态分区，账号之间互不顶号。账号数据只保存在本机，不会上传。'
            : '可以为该平台添加多个账号，各自独立登录，随时切换。') +
        '</p>' +
        '<div style="display:flex;gap:8px;justify-content:center">' +
        '<button class="btn primary" data-act="add-account"' +
        (state.ui.platform === 'all' ? '' : ' data-platform="' + state.ui.platform + '"') +
        '>添加账号</button>' +
        (noAccountAtAll ? '<button class="btn" data-act="quick-seed">快速创建 3×4 个账号位</button>' : '') +
        '</div></div>';
      return;
    }

    host.style.display = 'grid';
    var html = '';
    list.forEach(function (a) {
      var p = platformOf(a.platform);
      var url = a.postLoginUrl || a.url || p.entry;
      html +=
        '<article class="card" data-platform="' +
        a.platform +
        '" data-id="' +
        a.id +
        '" draggable="true" title="按住卡片可拖动排序">' +
        '<div class="card-top">' +
        '<span class="plat-badge">' +
        esc(p.abbr) +
        '</span>' +
        '<span class="card-alias" title="' +
        esc(a.alias) +
        '">' +
        esc(a.alias) +
        '</span>' +
        '<span class="pill" data-status="' +
        esc(a.status) +
        '">' +
        esc(statusLabel(a.status)) +
        '</span>' +
        '</div>' +
        (a.note ? '<div class="card-note">' + esc(a.note) + '</div>' : '') +
        (function () {
          var hi = healthInfo(a);
          return (
            '<div class="kv"><b>登录态</b><span class="health-dot ' +
            hi.tone +
            '" title="' +
            esc(hi.tip) +
            '">' +
            esc(hi.label) +
            (hi.when ? ' · 检测于 ' + esc(hi.when) : '') +
            '</span></div>'
          );
        })() +
        '<button class="card-extra-toggle' +
        (extraOpen[a.id] ? ' open' : '') +
        '" data-act="toggle-extra" data-id="' +
        a.id +
        '" aria-expanded="' +
        (extraOpen[a.id] ? 'true' : 'false') +
        '" title="展开/收起该账号的技术信息（不影响任何功能）">' +
        '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><path d="M6 9l6 6 6-6"/></svg>' +
        '技术详情</button>' +
        '<div class="card-extra' +
        (extraOpen[a.id] ? ' open' : '') +
        '">' +
        '<div class="kv"><b>打开到</b><span title="' +
        esc(url) +
        '">' +
        esc(url) +
        '</span></div>' +
        '<div class="kv"><b>分区</b><span title="该账号的独立登录态分区，重启应用后由它还原登录">' +
        esc(a.partition || '') +
        '</span></div>' +
        '<div class="kv"><b>本地凭据</b><span class="plain">' +
        (a.partitionExists ? '已在本机落盘（' + esc(p.name) + '）' : '尚未产生（首次打开后生成）') +
        ' · ' +
        esc(fmtTime(a.lastOpenedAt)) +
        '</span></div>' +
        '<div class="card-actions extra-actions">' +
        '<button class="btn" data-act="open-window" data-id="' +
        a.id +
        '" title="用独立窗口打开（同样使用该账号的独立分区）">新窗口</button>' +
        '</div>' +
        '</div>' +
        '<div class="card-actions">' +
        '<button class="btn primary grow" data-act="open-account" data-id="' +
        a.id +
        '">打开工作台</button>' +
        '<div class="mini-actions">' +
        '<button class="icon-btn" data-act="move-up" data-id="' +
        a.id +
        '" title="上移">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><path d="M6 15l6-6 6 6"/></svg>' +
        '</button>' +
        '<button class="icon-btn" data-act="move-down" data-id="' +
        a.id +
        '" title="下移">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><path d="M6 9l6 6 6-6"/></svg>' +
        '</button>' +
        '<button class="icon-btn" data-act="copy-link" data-id="' +
        a.id +
        '" title="复制打开链接">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5h10"/></svg>' +
        '</button>' +
        '<button class="icon-btn" data-act="edit-account" data-id="' +
        a.id +
        '" title="编辑">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 20h4l10-10-4-4L4 16z"/></svg>' +
        '</button>' +
        '<button class="icon-btn danger" data-act="delete-account" data-id="' +
        a.id +
        '" title="删除">' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13"/></svg>' +
        '</button>' +
        '</div></div></article>';
    });
    host.innerHTML = html;
  }

  function renderBrowserBar() {
    var host = $('browserBar');
    if (!host) return;
    var acc = state.ui.activeId ? findAccount(state.ui.activeId) : null;
    if (!acc) {
      host.innerHTML = '';
      return;
    }
    var p = platformOf(acc.platform);
    var vs = state.ui.viewState || {};
    var url = vs.url || '';
    var postUrl = acc.postLoginUrl || '';

    host.innerHTML =
      '<span class="plat-badge" style="--pc:' +
      (resolvedTheme() === 'dark' ? p.colorDark || p.color : p.color) +
      '">' +
      esc(p.abbr) +
      '</span>' +
      '<b style="font-weight:620">' +
      esc(acc.alias) +
      '</b>' +
      '<span class="badge-chip" title="该账号的独立登录态分区">' +
      esc(acc.partition || '') +
      '</span>' +
      '<button class="btn icon" data-act="nav-back" title="后退"' +
      (vs.canGoBack ? '' : ' disabled') +
      '><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M15 5l-7 7 7 7"/></svg></button>' +
      '<button class="btn icon" data-act="nav-forward" title="前进"' +
      (vs.canGoForward ? '' : ' disabled') +
      '><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M9 5l7 7-7 7"/></svg></button>' +
      '<button class="btn icon" data-act="nav-reload" title="重新加载">' +
      (vs.loading
        ? '<span class="spinner"></span>'
        : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M20 11a8 8 0 10-2.3 5.7"/><path d="M20 5v6h-6"/></svg>') +
      '</button>' +
      '<input class="view-url" id="urlInput" type="text" spellcheck="false" value="' +
      esc(url) +
      '" placeholder="输入网址后回车（仅在该账号的登录态下访问）" data-act="url-input" />' +
      '<button class="btn" data-act="goto-post" title="' +
      (postUrl ? '前往该账号的登录后 URL：' + esc(postUrl) : '为该账号设置一个登录后 URL（例如视频号跳转后的工作台地址）') +
      '">登录后 URL</button>' +
      '<button class="btn" data-act="open-external" title="用系统默认浏览器打开当前地址">浏览器打开</button>' +
      '<button class="btn" data-act="open-window" data-id="' +
      acc.id +
      '" title="在独立窗口打开同一账号（同一分区）">新窗口</button>' +
      '<button class="btn" data-act="close-view">返回列表</button>';
  }

  function renderViewPanel() {
    var listView = $('listView');
    var browserView = $('browserView');
    if (!listView || !browserView) return;
    var isBrowser = state.ui.mode === 'browser' && !!state.ui.activeId;
    listView.classList.toggle('hidden', isBrowser);
    browserView.classList.toggle('hidden', !isBrowser);

    var host = $('viewHost');
    if (!host) return;

    if (!isBrowser) {
      host.innerHTML = '';
      return;
    }

    var acc = findAccount(state.ui.activeId);
    var p = acc ? platformOf(acc.platform) : { name: '' };
    var err = state.ui.viewError;
    var html = '';
    html += '<div class="view-placeholder"><div class="inner">';
    if (err) {
      html +=
        '<div class="empty-mark" style="background:var(--danger-soft);color:var(--danger)">' +
        '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v5M12 17.5v.01"/><circle cx="12" cy="12" r="9"/></svg></div>';
      html += '<h3>页面没能加载出来</h3>';
      html += '<p>' + esc(err.errorDescription || '加载失败') + '</p>';
      if (err.url) html += '<p><span class="badge-chip">' + esc(err.url) + '</span></p>';
      html +=
        '<p>常见原因：网络不通、平台临时风控、或该账号需要重新登录。' +
        '可以先点「重新加载」，或点「登录后 URL」跳回工作台首页。</p>';
      html +=
        '<div style="display:flex;gap:8px;justify-content:center;margin-top:14px">' +
        '<button class="btn primary" data-act="nav-reload">重新加载</button>' +
        '<button class="btn" data-act="nav-home">回到该账号入口</button>' +
        '<button class="btn" data-act="open-external">用浏览器打开</button>' +
        '</div>';
    } else {
      html +=
        '<div class="empty-mark">' +
        '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg></div>';
      html += '<h3>' + (state.ui.viewState && state.ui.viewState.loading ? '正在打开 ' : '已打开 ') + esc(acc ? acc.alias : '') + '</h3>';
      html += '<p>' + esc(p.name) + ' 的页面正在该账号自己的登录态下加载。若出现登录页，请直接在本区域内扫码或登录。</p>';
      html +=
        '<p><span class="badge-chip">' +
        esc(acc ? acc.partition : '') +
        '</span></p>';
      html += '</div>';
    }
    html += '</div>';
    host.innerHTML = html;
  }

  function refreshAll() {
    renderSidebar();
    renderHead();
    renderCards();
    renderBrowserBar();
    renderViewPanel();
    syncViewBounds();
    initGlassEffects();
  }

  /* ============================================================ 玻璃风外观增强（纯样式，不碰数据/事件） */
  // 只负责：① 给卡片注入光斑/边缘提亮/高光三个装饰层并绑定跟随光标与 3D 倾斜；
  //         ② 给侧栏当前项加玻璃胶囊滑动指示器。
  // 这些操作只读写 DOM 样式，不改变任何账号数据或交互逻辑。

  function initGlassEffects() {
    if (state.ui.mode !== 'list') return; // 只在列表视图生效

    // ---- 侧栏玻璃胶囊指示器：跟随当前 active 项滑动 ----
    var sideHost = $('platformList');
    if (sideHost) {
      var active = sideHost.querySelector('.side-item.active');
      // 用 CSS 变量记录指示器目标，动画交给 .side-item.active 的过渡
      if (active) {
        sideHost.querySelectorAll('.side-item').forEach(function (it) {
          it.classList.remove('glass-anim');
        });
        active.classList.add('glass-anim');
      }
    }

    // ---- 卡片光斑 + 3D 倾斜 ----
    var MAX_TILT = 4; // 度，不超过 4°
    document.querySelectorAll('#cards .card').forEach(function (card) {
      if (card.getAttribute('data-glass')) return; // 已处理过，避免重复绑定
      card.setAttribute('data-glass', '1');

      // 注入三个装饰层（若重复渲染导致已存在则跳过）
      if (!card.querySelector('.card-glow')) {
        var glow = document.createElement('div');
        glow.className = 'card-glow';
        card.insertBefore(glow, card.firstChild);
      }
      if (!card.querySelector('.card-rim')) {
        var rim = document.createElement('div');
        rim.className = 'card-rim';
        card.insertBefore(rim, card.firstChild);
      }
      if (!card.querySelector('.card-shine')) {
        var shine = document.createElement('div');
        shine.className = 'card-shine';
        card.insertBefore(shine, card.firstChild);
      }

      card.addEventListener('mousemove', function (e) {
        var r = card.getBoundingClientRect();
        var px = (e.clientX - r.left) / r.width;
        var py = (e.clientY - r.top) / r.height;
        card.style.setProperty('--mx', (px * 100).toFixed(2) + '%');
        card.style.setProperty('--my', (py * 100).toFixed(2) + '%');
        var rx = (0.5 - py) * MAX_TILT * 2;
        var ry = (px - 0.5) * MAX_TILT * 2;
        card.style.transform = 'perspective(900px) rotateX(' + rx.toFixed(2) + 'deg) rotateY(' + ry.toFixed(2) + 'deg) translateY(-2px)';
      });
      card.addEventListener('mouseleave', function () {
        card.style.transform = '';
      });
    });
  }

  /* ============================================================ 视图尺寸同步 */

  function hostBounds() {
    var host = $('viewHost');
    if (!host) return null;
    var r = host.getBoundingClientRect();
    if (r.width < 20 || r.height < 20) return null;
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  }

  function syncViewBounds() {
    if (state.ui.mode !== 'browser' || !state.ui.activeId) return;
    if (state.ui.modalOpen) return; // 弹层打开时视图已隐藏
    var b = hostBounds();
    if (!b) return;
    API.setViewBounds(b);
  }

  /* ============================================================ Toast */

  function toast(message, kind) {
    var root = $('toastRoot');
    if (!root) return;
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || 'info');
    el.textContent = message;
    root.appendChild(el);
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 3600);
  }

  /* ============================================================ 弹层 */

  function openModal(html, opts) {
    var root = $('modalRoot');
    if (!root) return;
    var wide = opts && opts.wide ? ' wide' : '';
    root.innerHTML = '<div class="modal' + wide + '">' + html + '</div>';
    root.classList.add('open');
    state.ui.modalOpen = true;
    API.hideView(); // 内嵌视图永远在最上层，弹层期间必须让位
  }

  function closeModal() {
    var root = $('modalRoot');
    if (!root) return;
    root.innerHTML = '';
    root.classList.remove('open');
    var wasOpen = state.ui.modalOpen;
    state.ui.modalOpen = false;
    if (wasOpen) syncViewBounds();
  }

  function confirmModal(opts) {
    var danger = opts.danger !== false;
    var html = '';
    html += '<div class="modal-head"><h3>' + esc(opts.title) + '</h3></div>';
    html += '<div class="modal-body">';
    html += '<div class="notice' + (danger ? ' warn' : '') + '">' + opts.body + '</div>';
    if (opts.extra) html += '<div style="margin-top:12px">' + opts.extra + '</div>';
    html += '</div>';
    html +=
      '<div class="modal-foot"><button class="btn" data-act="modal-close">取消</button>' +
      '<button class="btn ' +
      (danger ? 'danger' : 'primary') +
      '" data-act="modal-confirm">' +
      esc(opts.confirmText || '确定') +
      '</button></div>';
    openModal(html, { wide: !!opts.extra });
    pendingConfirm = function () {
      closeModal();
      if (opts.onConfirm) opts.onConfirm();
    };
  }

  var pendingConfirm = null;
  /** 当前正在编辑的账号 id（空字符串表示新建），供 ⌘S 使用。 */
  var currentEditId = '';

  /* -------------------------------------------------- 账号表单 */

  function platformOptions(selected) {
    return state.platforms
      .map(function (p) {
        return '<option value="' + p.id + '"' + (p.id === selected ? ' selected' : '') + '>' + esc(p.name) + '</option>';
      })
      .join('');
  }

  function statusOptionsField(selected) {
    return STATUS_ORDER.map(function (s) {
      if (state.statuses.length && state.statuses.indexOf(s) === -1) return '';
      return '<option value="' + s + '"' + (s === selected ? ' selected' : '') + '>' + esc(statusLabel(s)) + '</option>';
    }).join('');
  }

  function openAccountModal(id, presetPlatform) {
    var acc = id ? findAccount(id) : null;
    var isNew = !acc;
    var platform = acc ? acc.platform : presetPlatform || (state.ui.platform === 'all' ? state.platforms[0].id : state.ui.platform);
    var p = platformOf(platform);

    var html = '';
    html += '<div class="modal-head"><h3>' + (isNew ? '添加账号' : '编辑账号') + '</h3></div>';
    html += '<div class="modal-body">';
    html +=
      '<div class="field"><label>平台</label><select id="f-platform">' +
      platformOptions(platform) +
      '</select></div>';
    html +=
      '<div class="field"><label>账号别名 <span style="color:var(--danger)">*</span></label>' +
      '<input id="f-alias" type="text" maxlength="60" placeholder="例如：' +
      esc(p.name) +
      '·主号 / 矩阵号A" value="' +
      esc(acc ? acc.alias : '') +
      '" /></div>';
    html +=
      '<div class="field-row">' +
      '<div class="field"><label>状态标签</label><select id="f-status">' +
      statusOptionsField(acc ? acc.status : 'normal') +
      '</select></div>' +
      '<div class="field"><label>排序权重</label><input id="f-sort" type="text" value="' +
      esc(acc ? acc.sort : '') +
      '" placeholder="越小越靠前，留空自动" /></div>' +
      '</div>';
    html +=
      '<div class="field"><label>登录入口 URL</label><input id="f-url" type="text" spellcheck="false" value="' +
      esc(acc ? acc.url : p.entry) +
      '" /><div class="hint">点「打开工作台」时首先访问这个地址。</div></div>';
    html +=
      '<div class="field"><label>登录后 URL（可选）</label><input id="f-post" type="text" spellcheck="false" placeholder="例如视频号登录后跳转到的创作者工作台地址" value="' +
      esc(acc ? acc.postLoginUrl : '') +
      '" /><div class="hint">' +
      esc(p.loginHint || '填写后，打开该账号时会直接跳到这个地址，适合登录后会跳转的平台。') +
      '</div></div>';
    html +=
      '<div class="field"><label>备注</label><textarea id="f-note" maxlength="500" placeholder="账号用途、发布方向、注意事项…">' +
      esc(acc ? acc.note : '') +
      '</textarea></div>';

    if (acc) {
      html +=
        '<div class="notice">该账号的独立登录态分区：<br /><code style="font-family:var(--mono);font-size:11px">' +
        esc(acc.partition || '') +
        '</code><br />删除账号不会自动清除这个分区的登录态，需要时可在此单独清理。</div>';
    } else {
      html += '<div class="notice">保存后会为该账号分配一个独立的登录态分区（<code style="font-family:var(--mono);font-size:11px">persist:平台-账号编号</code>），与其他账号互不影响。</div>';
    }
    html += '</div>';

    html += '<div class="modal-foot">';
    if (acc) html += '<button class="btn danger" data-act="clear-data" data-id="' + acc.id + '">清理登录态</button>';
    html += '<div class="spacer"></div>';
    html += '<button class="btn" data-act="modal-close">取消</button>';
    html += '<button class="btn primary" data-act="save-account" data-id="' + (acc ? acc.id : '') + '">保存</button>';
    html += '</div>';

    openModal(html, { wide: false });
    currentEditId = acc ? acc.id : '';
    var aliasInput = $('f-alias');
    if (aliasInput) aliasInput.focus();

    var sel = $('f-platform');
    if (sel) {
      sel.addEventListener('change', function () {
        var np = platformOf(sel.value);
        var urlInput = $('f-url');
        if (urlInput && (!urlInput.value.trim() || state.platforms.some(function (x) {
          return x.entry === urlInput.value.trim();
        }))) {
          urlInput.value = np.entry;
        }
      });
    }
  }

  function submitAccountForm(id) {
    var platform = $('f-platform').value;
    var alias = $('f-alias').value.trim();
    var status = $('f-status').value;
    var sortRaw = $('f-sort').value.trim();
    var url = $('f-url').value.trim();
    var post = $('f-post').value.trim();
    var note = $('f-note').value;

    if (!alias) {
      toast('请填写账号别名', 'err');
      $('f-alias').focus();
      return;
    }
    if (url && !/^https?:\/\//i.test(url)) {
      toast('登录入口 URL 必须以 http:// 或 https:// 开头', 'err');
      return;
    }
    if (post && !/^https?:\/\//i.test(post)) {
      toast('登录后 URL 必须以 http:// 或 https:// 开头', 'err');
      return;
    }

    var payload = {
      platform: platform,
      alias: alias,
      status: status,
      url: url,
      postLoginUrl: post,
      note: note
    };
    if (id) payload.id = id;
    if (sortRaw !== '') payload.sort = Number(sortRaw);

    API.saveAccount(payload).then(function (res) {
      if (res && res.error) {
        toast(res.error, 'err');
        return;
      }
      setAccountsFromResponse(res);
      closeModal();
      refreshAll();
      toast((res.created ? '已添加账号：' : '已保存：') + alias, 'ok');
    });
  }

  /* -------------------------------------------------- 设置 */

  function openSettingsModal() {
    var s = state.settings;
    var html = '';
    html += '<div class="modal-head"><h3>设置与数据</h3></div>';
    html += '<div class="modal-body">';

    html +=
      '<div class="switch-row"><div class="txt"><b>外观</b><span>跟随系统 / 浅色 / 深色</span></div>' +
      '<select id="s-theme" style="width:104px;padding:5px 8px;border:1px solid var(--border);border-radius:7px;background:var(--bg-soft)">' +
      ['system', 'light', 'dark']
        .map(function (t) {
          var label = t === 'system' ? '跟随系统' : t === 'light' ? '浅色' : '深色';
          return '<option value="' + t + '"' + (s.theme === t ? ' selected' : '') + '>' + label + '</option>';
        })
        .join('') +
      '</select></div>';

    html +=
      '<div class="switch-row"><div class="txt"><b>模拟常规 Chrome 标识（推荐开启）</b>' +
      '<span>默认 UA 里带有 Electron 标识，个别平台会据此返回异常页面。开启后按普通 Chrome 呈现 —— 只改标识，不绕过任何验证、验证码或风控。</span></div>' +
      '<button class="switch' +
      (s.spoofChromeUA ? ' on' : '') +
      '" data-act="toggle-ua" aria-label="切换 UA 模拟"></button></div>';

    html +=
      '<div class="switch-row"><div class="txt"><b>切走的账号继续在后台运行</b>' +
      '<span>开启时，切换到别的账号不会销毁前一个页面（占用更多内存，但页面内的操作与内存态登录不会中断）。关闭后切走即释放页面，登录态仍保存在磁盘上。</span></div>' +
      '<button class="switch' +
      (s.keepViewsAlive ? ' on' : '') +
      '" data-act="toggle-keepalive" aria-label="切换后台保留"></button></div>';

    html +=
      '<div class="switch-row"><div class="txt"><b>数据位置</b><span>账号配置与各账号登录态都保存在本机；导出文件里不含任何登录凭据。</span></div></div>';

    /* ---------- 登录态持久化 ---------- */
    html += '<div class="section-label">登录态持久化</div>';

    html +=
      '<div class="switch-row"><div class="txt"><b>把会话型凭据转为可落盘（推荐开启）</b>' +
      '<span>浏览器默认不把「没有过期时间」的 Cookie 写入磁盘，而不少平台的登录凭据正好就是这种，于是重启应用必然掉登录。开启后会给它们补一个远期过期时间后重新写回<b>该账号自己的分区</b>。' +
      '这<b>不会</b>延长平台服务端的有效期——平台该让你重登还是会让你重登；它只让本机别自己把凭据丢掉。</span></div>' +
      '<button class="switch' +
      (s.persistSessionCookies !== false ? ' on' : '') +
      '" data-act="toggle-persist-cookies" aria-label="切换会话型凭据持久化"></button></div>';

    html +=
      '<div class="switch-row"><div class="txt"><b>退出前等待凭据写入磁盘（推荐开启）</b>' +
      '<span>Cookie 的写盘是延迟的，强制退出 / 崩溃会丢掉最后一段时间的写入。开启后退出时最多等 2.5 秒把它写完；关闭则退出更快，但极端情况下可能丢最近的登录刷新。</span></div>' +
      '<button class="switch' +
      (s.flushOnQuit !== false ? ' on' : '') +
      '" data-act="toggle-flush-quit" aria-label="切换退出前落盘"></button></div>';

    html +=
      '<div class="switch-row"><div class="txt"><b>定时保活 + 登录态巡检</b>' +
      '<span>按间隔静默访问每个账号的工作台一次：既让平台顺带续期自己的会话（长期不打开的账号更容易闲置失效），也顺便检测有没有被踢回登录页。已打开的账号直接读当前地址，不重复加载。串行执行、账号之间留白，不会并发冲击平台。</span></div>' +
      '<button class="switch' +
      (s.keepAlive !== false ? ' on' : '') +
      '" data-act="toggle-patrol" aria-label="切换保活巡检"></button></div>';

    html +=
      '<div class="switch-row"><div class="txt"><b>巡检间隔（小时）</b>' +
      '<span>默认 12 小时。账号越多、越在意「掉了马上知道」，可以调短；不建议短于 2 小时。</span></div>' +
      '<input id="s-patrol-hours" type="number" min="1" max="72" step="1" value="' +
      esc(String(s.keepAliveHours || 12)) +
      '" data-act="patrol-hours" style="width:74px;padding:5px 8px;border:1px solid var(--border);border-radius:7px;background:var(--bg-soft)" /></div>';

    html +=
      '<div class="switch-row"><div class="txt"><b>启动后自动巡检一次</b>' +
      '<span>打开应用约 3 分钟后自动跑一轮，这样一开机就能看到每个账号的登录态。</span></div>' +
      '<button class="switch' +
      (s.patrolOnStart !== false ? ' on' : '') +
      '" data-act="toggle-patrol-start" aria-label="切换启动巡检"></button></div>';

    html +=
      '<div style="display:flex;gap:8px;margin:10px 0 4px;flex-wrap:wrap">' +
      '<button class="btn primary" data-act="patrol-all">立即巡检全部账号</button>' +
      '<button class="btn" data-act="flush-now">立即写入磁盘</button>' +
      '</div>';
    html += '<div class="scroll-box" id="diagBox">正在读取…</div>';
    html +=
      '<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">' +
      '<button class="btn" data-act="open-data-dir">打开数据目录</button>' +
      '<button class="btn" data-act="open-state-file">打开账号配置文件</button>' +
      '<button class="btn" data-act="release-views">释放后台视图</button>' +
      '<button class="btn" data-act="quick-seed">快速创建 3×4 个账号位</button>' +
      '</div>';

    html +=
      '<div class="notice" style="margin-top:14px"><b>能力与边界</b><br />' +
      '· 本工具为每个账号分配独立的持久化分区，Cookie / localStorage 落盘在本机，重启应用后自动保持登录；<br />' +
      '· 不保存第三方账号密码，不读取、不上传、不导出第三方 Cookie；<br />' +
      '· 不绕过平台的登录校验、验证码与风控；<br />' +
      '· <b>登录态能维持多久最终由平台决定</b>。账号被平台判定异常、在别处重新登录、或平台主动缩短有效期，本工具都无法阻止，只能尽早告诉你并让你一键重登。</div>';

    html += '</div>';
    html += '<div class="modal-foot"><button class="btn primary" data-act="modal-close">完成</button></div>';

    openModal(html, { wide: true });
    loadDiagnostics();
  }

  function loadDiagnostics() {
    var box = $('diagBox');
    if (!box) return;
    API.diagnostics().then(function (d) {
      if (!box || !document.body.contains(box)) return;
      var html = '';
      html += '<div style="font-size:11.5px;line-height:1.9">';
      html += '<div>配置目录：<code>' + esc(d.dataDir) + '</code></div>';
      html += '<div>账号文件：<code>' + esc(d.stateFile) + '</code></div>';
      html +=
        '<div>运行环境：Electron ' +
        esc(d.versions.electron) +
        ' · Chromium ' +
        esc(d.versions.chrome) +
        ' · Node ' +
        esc(d.versions.node) +
        '</div>';
      html += '<div>正在运行的内嵌视图：' + (d.activeViews.length ? d.activeViews.length + ' 个' : '无') + '</div>';
      if (d.guard) {
        html +=
          '<div>登录态守护：巡检 ' +
          (d.guard.patrolRuns || 0) +
          ' 次（上次 ' +
          esc(d.guard.lastPatrolAt ? fmtAgo(d.guard.lastPatrolAt) : '还没跑过') +
          '）· 落盘 ' +
          (d.guard.flushRuns || 0) +
          ' 次（上次 ' +
          esc(d.guard.lastFlushAt ? fmtAgo(d.guard.lastFlushAt) : '还没跑过') +
          '）' +
          (d.guard.patrolling ? ' · <b>正在巡检</b>' : '') +
          '</div>';
      }
      if (d.health && d.health.length) {
        var bad = d.health.filter(function (h) {
          return h.state === 'needs-login';
        });
        html +=
          '<div>登录态汇总：' +
          (bad.length
            ? '<b style="color:var(--warn)">' +
              bad
                .map(function (h) {
                  return esc(h.alias);
                })
                .join('、') +
              ' 需要重新登录</b>'
            : '暂无账号被判定为掉登录') +
          '</div>';
      }
      html += '</div>';
      html += '<ul class="diag-list">';
      if (!d.partitions.length) {
        html += '<li style="color:var(--text-3)">还没有账号，添加账号后这里会列出各自的分区目录。</li>';
      }
      d.partitions.forEach(function (p) {
        html +=
          '<li><div style="flex:1 1 auto"><b>' +
          esc(p.alias) +
          '</b> <code>' +
          esc(p.partition) +
          '</code><div style="color:var(--text-3);font-size:11px">' +
          esc(p.dir) +
          '</div></div><span class="pill" data-status="' +
          (p.exists ? 'normal' : 'disabled') +
          '">' +
          (p.exists ? '已落盘' : '未生成') +
          '</span></li>';
      });
      html += '</ul>';
      box.innerHTML = html;
    });
  }

  /* -------------------------------------------------- 一键打开菜单 */

  function openBulkMenu(anchor) {
    var layer = $('menuLayer');
    if (!layer) return;
    var plat = state.ui.platform;
    var scopeName = plat === 'all' ? '全部平台' : platformOf(plat).name;
    var base = accountsOf(plat);
    var counts = {
      all: base.length,
      loggedout: base.filter(function (a) {
        return a.status === 'loggedout';
      }).length,
      pending: base.filter(function (a) {
        return a.status === 'pending';
      }).length,
      'needs-login': base.filter(function (a) {
        return a.health && a.health.state === 'needs-login';
      }).length
    };

    var html = '';
    html += '<div class="menu"><div class="label">' + esc(scopeName) + ' · 用独立窗口打开</div>';
    html += '<button data-act="bulk-run" data-filter="all">全部账号（' + counts.all + '）</button>';
    html += '<button data-act="bulk-run" data-filter="loggedout">仅未登录（' + counts.loggedout + '）</button>';
    html += '<button data-act="bulk-run" data-filter="pending">仅待发布（' + counts.pending + '）</button>';
    html += '<button data-act="bulk-run" data-filter="needs-login">仅巡检出的待重登（' + counts['needs-login'] + '）</button>';
    html += '<div class="sep"></div>';
    html += '<div class="label" style="font-weight:400;color:var(--text-3)">每个账号都在自己的分区里打开，窗口会错开 0.26 秒逐个加载</div></div>';

    layer.innerHTML = html;
    var menu = layer.firstElementChild;
    var r = anchor.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = Math.min(window.innerHeight - 220, r.bottom + 6) + 'px';
    menu.style.left = Math.max(10, Math.min(window.innerWidth - 220, r.right - 200)) + 'px';
  }

  function closeMenu() {
    var layer = $('menuLayer');
    if (layer) layer.innerHTML = '';
  }

  function runBulk(filter) {
    var list = accountsOf(state.ui.platform).filter(function (a) {
      if (filter === 'all') return true;
      if (filter === 'needs-login') return !!(a.health && a.health.state === 'needs-login');
      return a.status === filter;
    });
    if (!list.length) {
      toast(filter === 'needs-login' ? '没有巡检出需要重新登录的账号' : '没有符合条件的账号', filter === 'needs-login' ? 'ok' : 'warn');
      return;
    }
    var ids = list.map(function (a) {
      return a.id;
    });
    API.openMany(ids).then(function (res) {
      if (res && res.error) {
        toast(res.error, 'err');
        return;
      }
      toast('正在打开 ' + ids.length + ' 个账号，各自使用独立登录态', 'ok');
    });
  }

  /* ============================================================ 账号操作 */

  function openAccount(id) {
    var host = $('viewHost');
    if (!host) return;
    state.ui.mode = 'browser';
    state.ui.activeId = id;
    state.ui.viewError = null;
    state.ui.viewState = null;
    refreshAll();

    var b = hostBounds();
    API.openView(id, b || { x: 0, y: 0, width: 800, height: 600 }).then(function (res) {
      if (res && res.error) {
        toast(res.error, 'err');
        state.ui.mode = 'list';
        refreshAll();
        return;
      }
      if (res && res.state) {
        state.ui.viewState = res.state;
        renderBrowserBar();
      }
      state.settings.lastAccountId = id;
      API.updateSettings({ lastAccountId: id });
    });
  }

  function closeView() {
    API.closeView().then(function () {
      state.ui.mode = 'list';
      state.ui.activeId = null;
      state.ui.viewState = null;
      state.ui.viewError = null;
      refreshAll();
    });
  }

  function copyLink(id) {
    var a = findAccount(id);
    if (!a) return;
    API.copy(a.postLoginUrl || a.url || platformOf(a.platform).entry).then(function () {
      toast('链接已复制到剪贴板', 'ok');
    });
  }

  function removeAccount(id) {
    var a = findAccount(id);
    if (!a) return;
    confirmModal({
      title: '删除账号',
      confirmText: '删除',
      body:
        '将从列表中移除「<b>' +
        esc(a.alias) +
        '</b>」（' +
        esc(platformOf(a.platform).name) +
        '）。<br />账号配置会被删除，但它在磁盘上的登录态分区 <code style="font-family:var(--mono);font-size:11px">' +
        esc(a.partition || '') +
        '</code> 会保留 —— 以后用相同编号重建或需要彻底清理时，可在「编辑账号 → 清理登录态」里处理。',
      onConfirm: function () {
        API.deleteAccount(id).then(function (res) {
          if (res && res.error) {
            toast(res.error, 'err');
            return;
          }
          setAccountsFromResponse(res);
          if (state.ui.activeId === id) {
            state.ui.mode = 'list';
            state.ui.activeId = null;
          }
          refreshAll();
          toast('已删除账号', 'ok');
        });
      }
    });
  }

  function clearAccountData(id) {
    var a = findAccount(id);
    if (!a) return;
    confirmModal({
      title: '清理该账号的本地登录态',
      confirmText: '清理并登出',
      body:
        '将清空「<b>' +
        esc(a.alias) +
        '</b>」分区内的 Cookie、localStorage 与缓存，效果等同于在该平台退出登录，下次打开需要重新登录。<br />' +
        '只在本机执行，不会读取或外传任何数据。其他账号不受影响。',
      onConfirm: function () {
        API.clearAccountData(id).then(function (res) {
          if (res && res.error) {
            toast(res.error, 'err');
            return;
          }
          closeModal();
          refreshAll();
          toast('已清理本地登录态：' + (res.partition || ''), 'ok');
        });
      }
    });
  }

  function doReorder(platform, orderedIds) {
    API.reorder(platform, orderedIds).then(function (res) {
      if (res && res.error) {
        toast(res.error, 'err');
        return;
      }
      setAccountsFromResponse(res);
      refreshAll();
    });
  }

  /* ============================================================ 事件绑定 */

  function onDocumentClick(e) {
    var el = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!el) {
      if (!e.target.closest || !e.target.closest('.menu')) closeMenu();
      return;
    }
    var act = el.getAttribute('data-act');
    var id = el.getAttribute('data-id');

    switch (act) {
      case 'search':
        return; // 输入框自身
      case 'pick-platform': {
        var plat = el.getAttribute('data-platform');
        state.ui.platform = plat;
        state.settings.lastPlatform = plat;
        API.updateSettings({ lastPlatform: plat });
        if (state.ui.mode === 'browser') closeView();
        refreshAll();
        return;
      }
      case 'add-account':
        openAccountModal(null, el.getAttribute('data-platform') || null);
        return;
      case 'quick-seed':
        API.seedAccounts().then(function (res) {
          if (res && res.error) {
            toast(res.error, 'err');
            return;
          }
          setAccountsFromResponse(res);
          closeModal();
          refreshAll();
          toast('已创建 ' + res.created + ' 个账号位，可逐个改别名并登录', 'ok');
        });
        return;
      case 'edit-account':
        openAccountModal(id, null);
        return;
      case 'delete-account':
        removeAccount(id);
        return;
      case 'clear-data':
        clearAccountData(id);
        return;
      case 'save-account':
        submitAccountForm(id || '');
        return;
      case 'open-account':
        openAccount(id);
        return;
      case 'open-window':
        API.openWindow(id).then(function (res) {
          if (res && res.error) toast(res.error, 'err');
          else toast('已用独立窗口打开（同一账号分区）', 'ok');
        });
        return;
      case 'copy-link':
        copyLink(id);
        return;
      case 'toggle-extra':
        // 纯界面展开/收起，不触碰任何数据
        if (extraOpen[id]) delete extraOpen[id];
        else extraOpen[id] = true;
        refreshAll();
        return;
      case 'move-up':
        API.move(id, 'up').then(function (res) {
          setAccountsFromResponse(res);
          refreshAll();
        });
        return;
      case 'move-down':
        API.move(id, 'down').then(function (res) {
          setAccountsFromResponse(res);
          refreshAll();
        });
        return;
      case 'bulk-menu':
        openBulkMenu(el);
        return;
      case 'bulk-run':
        closeMenu();
        runBulk(el.getAttribute('data-filter'));
        return;
      case 'close-view':
        closeView();
        return;
      case 'nav-back':
        API.viewNav('back');
        return;
      case 'nav-forward':
        API.viewNav('forward');
        return;
      case 'nav-reload':
        state.ui.viewError = null;
        API.viewNav('reload');
        return;
      case 'nav-home':
        state.ui.viewError = null;
        API.viewNav('home');
        refreshAll();
        return;
      case 'open-external': {
        var a = state.ui.activeId ? findAccount(state.ui.activeId) : null;
        var target = (state.ui.viewState && state.ui.viewState.url) || (a ? a.postLoginUrl || a.url : '');
        if (!target) {
          toast('当前没有可打开的地址', 'warn');
          return;
        }
        API.openExternal(target);
        toast('已交给系统默认浏览器打开（该浏览器没有本工具的分区登录态）', 'info');
        return;
      }
      case 'goto-post': {
        var acc = state.ui.activeId ? findAccount(state.ui.activeId) : null;
        if (!acc) return;
        if (acc.postLoginUrl) {
          state.ui.viewError = null;
          API.viewLoad(acc.postLoginUrl);
          toast('正在打开登录后 URL', 'info');
        } else {
          openAccountModal(acc.id, null);
          toast('为该账号填写「登录后 URL」后即可一键跳转', 'info');
        }
        return;
      }
      case 'toggle-theme': {
        var order = ['system', 'light', 'dark'];
        var cur = state.settings.theme || 'system';
        var next = order[(order.indexOf(cur) + 1) % order.length];
        state.settings.theme = next;
        applyTheme();
        API.updateSettings({ theme: next });
        renderSidebar();
        renderBrowserBar();
        var label = next === 'system' ? '跟随系统' : next === 'light' ? '浅色' : '深色';
        toast('外观：' + label, 'info');
        return;
      }
      case 'toggle-ua': {
        var v = !state.settings.spoofChromeUA;
        state.settings.spoofChromeUA = v;
        API.updateSettings({ spoofChromeUA: v });
        el.classList.toggle('on', v);
        toast(v ? '已按常规 Chrome 标识访问' : '已恢复默认标识（部分平台可能出现异常页面）', v ? 'ok' : 'warn');
        return;
      }
      case 'toggle-keepalive': {
        var k = !state.settings.keepViewsAlive;
        state.settings.keepViewsAlive = k;
        API.updateSettings({ keepViewsAlive: k });
        el.classList.toggle('on', k);
        toast(k ? '切走的账号将在后台继续运行' : '切走即释放页面（登录态仍保留在磁盘）', 'info');
        return;
      }
      case 'toggle-persist-cookies': {
        var pc = state.settings.persistSessionCookies === false;
        state.settings.persistSessionCookies = pc;
        API.updateSettings({ persistSessionCookies: pc });
        el.classList.toggle('on', pc);
        toast(
          pc ? '已开启：会话型凭据会写入磁盘，重启后更容易保持登录' : '已关闭：会话型凭据不再转存（重启后可能需要重登）',
          pc ? 'ok' : 'warn'
        );
        return;
      }
      case 'toggle-flush-quit': {
        var fq = state.settings.flushOnQuit === false;
        state.settings.flushOnQuit = fq;
        API.updateSettings({ flushOnQuit: fq });
        el.classList.toggle('on', fq);
        toast(fq ? '退出前会等待凭据写入磁盘' : '退出时将不再等待写入（退出更快）', 'info');
        return;
      }
      case 'toggle-patrol': {
        var ka = state.settings.keepAlive === false;
        state.settings.keepAlive = ka;
        API.updateSettings({ keepAlive: ka });
        el.classList.toggle('on', ka);
        toast(ka ? '已开启定时保活与巡检' : '已关闭定时保活与巡检（账号长期不打开更容易闲置失效）', ka ? 'ok' : 'warn');
        return;
      }
      case 'toggle-patrol-start': {
        var ps = state.settings.patrolOnStart === false;
        state.settings.patrolOnStart = ps;
        API.updateSettings({ patrolOnStart: ps });
        el.classList.toggle('on', ps);
        toast(ps ? '启动约 3 分钟后会自动巡检一次' : '启动后不再自动巡检', 'info');
        return;
      }
      case 'flush-now':
        API.flushSession().then(function (res) {
          if (res && res.error) {
            toast(res.error, 'err');
            return;
          }
          var s = res.summary || {};
          toast('已写入磁盘：' + (s.flushed || 0) + ' 个分区' + (s.converted ? '，转存 ' + s.converted + ' 项会话型凭据' : ''), 'ok');
          loadDiagnostics();
        });
        return;
      case 'patrol-all':
        startPatrol();
        return;
      case 'settings':
        openSettingsModal();
        return;
      case 'release-views':
        API.releaseBackgroundViews().then(function (res) {
          loadDiagnostics();
          toast('已释放 ' + (res.released || 0) + ' 个后台视图（磁盘上的登录态未受影响）', 'ok');
        });
        return;
      case 'open-data-dir':
        API.diagnostics().then(function (d) {
          API.openPath(d.dataDir);
        });
        return;
      case 'open-state-file':
        API.diagnostics().then(function (d) {
          API.openPath(d.stateFile);
        });
        return;
      case 'import':
        API.importAccounts().then(function (res) {
          if (!res || res.canceled) return;
          if (res.error) {
            toast(res.error, 'err');
            return;
          }
          setAccountsFromResponse(res);
          if (res.settings) {
            state.settings = Object.assign({}, state.settings, res.settings);
            applyTheme();
          }
          refreshAll();
          toast('导入完成：新增 ' + res.added + ' · 更新 ' + res.updated + ' · 跳过 ' + res.skipped, 'ok');
        });
        return;
      case 'export':
        API.exportAccounts().then(function (res) {
          if (!res || res.canceled) return;
          if (res.error) {
            toast(res.error, 'err');
            return;
          }
          toast('已导出 ' + res.count + ' 个账号到 ' + res.filePath, 'ok');
        });
        return;
      case 'modal-close':
        closeModal();
        return;
      case 'modal-confirm':
        if (pendingConfirm) {
          var fn = pendingConfirm;
          pendingConfirm = null;
          fn();
        } else {
          closeModal();
        }
        return;
      default:
        return;
    }
  }

  function onDocumentInput(e) {
    var el = e.target;
    if (!el) return;
    if (el.id === 's-patrol-hours') {
      var n = Number(el.value);
      if (Number.isFinite(n) && n >= 1 && n <= 72) {
        state.settings.keepAliveHours = Math.round(n);
        API.updateSettings({ keepAliveHours: Math.round(n) });
      }
      return;
    }
    if (el.id === 'searchInput') {
      state.ui.q = el.value;
      renderHead();
      renderCards();
    }
  }

  /* ------------------------------------------------------- 巡检入口 */

  function startPatrol() {
    if (state.ui.patrolling) {
      toast('巡检正在进行中…', 'info');
      return;
    }
    var total = accountsOf(state.ui.platform).length;
    if (!total) {
      toast('还没有账号', 'warn');
      return;
    }
    state.ui.patrolling = true;
    state.ui.patrolDone = 0;
    state.ui.patrolTotal = total;
    renderHead();
    toast('开始巡检 ' + total + ' 个账号，会逐个静默访问，期间可以正常使用', 'info');
    API.patrol({}).then(function (res) {
      state.ui.patrolling = false;
      renderHead();
      if (res && res.error) {
        toast(res.error, 'err');
        return;
      }
      if (res && res.skipped) {
        toast('已有巡检在进行中', 'info');
        return;
      }
      var s = (res && res.summary) || {};
      if (s.needsLogin > 0) {
        toast('巡检完成：' + s.needsLogin + ' 个账号需要重新登录，可在「一键打开…」里只打开这些账号', 'warn');
      } else if (s.total) {
        toast('巡检完成：' + s.ok + '/' + s.total + ' 个账号登录态正常', 'ok');
      } else {
        toast('巡检完成', 'ok');
      }
    });
  }

  function onDocumentKeydown(e) {
    var el = e.target;

    if (e.key === 'Escape') {
      if (state.ui.modalOpen) {
        closeModal();
        return;
      }
      closeMenu();
      if (state.ui.mode === 'browser') closeView();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      var s = $('searchInput');
      if (s && state.ui.mode === 'list') s.focus();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && state.ui.modalOpen && $('f-alias')) {
      e.preventDefault();
      submitAccountForm(currentEditId);
      return;
    }
    if (e.key === 'Enter' && el && el.id === 'urlInput') {
      var v = el.value.trim();
      if (v) {
        state.ui.viewError = null;
        API.viewLoad(v);
      }
    }
  }

  /* ------------------------------ 拖拽排序 ------------------------------ */

  function onDragStart(e) {
    var card = e.target.closest ? e.target.closest('.card') : null;
    if (!card) return;
    state.ui.dragId = card.getAttribute('data-id');
    card.classList.add('dragging');
    try {
      e.dataTransfer.setData('text/plain', state.ui.dragId);
      e.dataTransfer.effectAllowed = 'move';
    } catch (err) {
      /* 忽略 */
    }
  }

  function onDragOver(e) {
    if (!state.ui.dragId) return;
    var card = e.target.closest ? e.target.closest('.card') : null;
    if (!card) return;
    var dragAcc = findAccount(state.ui.dragId);
    var overAcc = findAccount(card.getAttribute('data-id'));
    if (!dragAcc || !overAcc || dragAcc.platform !== overAcc.platform) return;
    e.preventDefault();

    document.querySelectorAll('.card.drop-before,.card.drop-after').forEach(function (c) {
      c.classList.remove('drop-before', 'drop-after');
    });
    if (overAcc.id === dragAcc.id) return;
    var r = card.getBoundingClientRect();
    var after = e.clientY > r.top + r.height / 2;
    card.classList.add(after ? 'drop-after' : 'drop-before');
    state.ui.drop = { id: overAcc.id, after: after, platform: overAcc.platform };
  }

  function onDrop(e) {
    var dragId = state.ui.dragId;
    var drop = state.ui.drop;
    document.querySelectorAll('.card').forEach(function (c) {
      c.classList.remove('drop-before', 'drop-after', 'dragging');
    });
    state.ui.dragId = null;
    state.ui.drop = null;
    if (!dragId || !drop || drop.id === dragId) return;
    e.preventDefault();

    var list = accountsOf(drop.platform).map(function (a) {
      return a.id;
    });
    var from = list.indexOf(dragId);
    if (from === -1) return;
    list.splice(from, 1);
    var to = list.indexOf(drop.id);
    if (to === -1) to = list.length;
    if (drop.after) to += 1;
    list.splice(to, 0, dragId);
    doReorder(drop.platform, list);
  }

  function onDragEnd() {
    document.querySelectorAll('.card').forEach(function (c) {
      c.classList.remove('drop-before', 'drop-after', 'dragging');
    });
    state.ui.dragId = null;
    state.ui.drop = null;
  }

  /* ============================================================ 初始化 */

  function bindEvents() {
    document.addEventListener('click', onDocumentClick);
    document.addEventListener('input', onDocumentInput);
    document.addEventListener('keydown', onDocumentKeydown);
    document.addEventListener('dragstart', onDragStart);
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('drop', onDrop);
    document.addEventListener('dragend', onDragEnd);

    window.addEventListener('resize', function () {
      syncViewBounds();
    });

    var host = $('viewHost');
    if (host && typeof ResizeObserver === 'function') {
      new ResizeObserver(function () {
        syncViewBounds();
      }).observe(host);
    }

    API.onViewState(function (vs) {
      state.ui.viewState = vs;
      renderBrowserBar();
    });

    API.onViewFailed(function (payload) {
      state.ui.viewError = payload;
      renderBrowserBar();
      renderViewPanel();
    });

    API.onViewActivated(function (payload) {
      if (payload && payload.accountId && payload.accountId !== state.ui.activeId) {
        state.ui.activeId = payload.accountId;
        renderBrowserBar();
        renderViewPanel();
      }
    });

    API.onViewClosed(function () {
      state.ui.mode = 'list';
      state.ui.activeId = null;
      refreshAll();
    });

    API.onNotice(function (n) {
      if (n && n.message) toast(n.message, n.kind || 'info');
    });

    API.onWindowResized(function () {
      syncViewBounds();
    });

    /* ---- 登录态巡检 ---- */
    API.onHealth(function (payload) {
      if (!payload || !payload.accountId) return;
      var acc = findAccount(payload.accountId);
      if (acc) acc.health = payload.health;
      if (state.ui.mode === 'list') {
        renderHead();
        renderCards();
      } else if (state.ui.viewState && state.ui.viewState.accountId === payload.accountId) {
        renderBrowserBar();
      }
    });

    API.onPatrolProgress(function (p) {
      if (!p || !p.total) return;
      state.ui.patrolling = true;
      state.ui.patrolDone = p.done;
      state.ui.patrolTotal = p.total;
      renderHead();
    });

    API.onPatrolDone(function (summary) {
      state.ui.patrolling = false;
      state.ui.patrolSummary = summary || null;
      renderHead();
      renderCards();
      if (state.ui.modalOpen) loadDiagnostics();
    });
  }

  function init() {
    API.boot().then(function (data) {
      state.platforms = data.platforms || [];
      state.accounts = data.accounts || [];
      state.settings = Object.assign({ theme: 'system' }, data.settings || {});
      state.statuses = data.statuses || [];
      state.statusLabel = data.statusLabel || {};
      state.env = data.env || {};
      state.guard = data.guard || {};
      state.ui.platform = state.settings.lastPlatform || 'all';
      state.ui.patrolling = !!(data.guard && data.guard.patrolling);

      if (state.env.platformLabel === 'darwin') document.body.classList.add('is-mac');

      injectPlatformCSS();
      applyTheme();
      bindEvents();
      refreshAll();

      if (!state.accounts.length) {
        toast('还没有账号：点「添加账号」，或先「快速创建 3×4 个账号位」体验多账号切换', 'info');
      }
    });
  }

  init();
})();
