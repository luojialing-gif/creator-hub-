'use strict';

/**
 * 平台元数据 —— 全项目唯一来源。
 * 主进程与渲染层（通过 IPC）都使用这份定义，新增平台只需在这里加一条。
 *
 * color         : 浅色主题下的平台主色
 * colorDark     : 深色主题下的平台主色（浅色主题下偏暗的品牌色在深色背景上会看不清）
 * restrict      : 该平台用于「尝试内嵌」时的已知限制说明（纯网页版使用）
 * loginHints    : 登录态巡检用。静默加载工作台后，若最终地址（小写）命中其中任一子串，
 *                 判为「疑似已被踢回登录页」。只做本地地址判断，不注入脚本、不读取页面数据。
 *                 （用子串而非正则，是为了能安全地随 IPC 传给渲染层。）
 * healthProbe   : 巡检时加载哪种地址，'post' = 该账号自定义的「登录后 URL」，'entry' = 登录入口。
 *                 视频号登录入口本身就是 login.html，必须优先用「登录后 URL」才判得准。
 */
const PLATFORMS = [
  {
    id: 'douyin',
    name: '抖音',
    abbr: '抖',
    color: '#20232E',
    colorDark: '#9AA3B8',
    entry: 'https://creator.douyin.com/creator-micro/home',
    origin: 'https://creator.douyin.com',
    note: '抖音创作者中心',
    loginHint: '',
    embedBlocked: true,
    healthProbe: 'entry',
    loginHints: ['sso.douyin.com', '/login', 'passport']
  },
  {
    id: 'xhs',
    name: '小红书',
    abbr: '书',
    color: '#FF2442',
    colorDark: '#FF5C70',
    entry: 'https://creator.xiaohongshu.com/publish/publish?source=&published=true',
    origin: 'https://creator.xiaohongshu.com',
    note: '小红书创作服务平台',
    loginHint: '',
    embedBlocked: true,
    healthProbe: 'entry',
    loginHints: ['/login', 'passport', 'sso.']
  },
  {
    id: 'wxch',
    name: '视频号',
    abbr: '视',
    color: '#07C160',
    colorDark: '#2FD07F',
    entry: 'https://channels.weixin.qq.com/login.html',
    origin: 'https://channels.weixin.qq.com',
    note: '微信视频号助手',
    loginHint: '通常需要微信扫码登录；登录成功后会跳转到工作台，建议为该账号填写「登录后 URL」以免每次落到登录页。',
    embedBlocked: true,
    healthProbe: 'post',
    loginHints: ['login.html', '/login', 'passport', 'sso.']
  },
  {
    id: 'kuaishou',
    name: '快手',
    abbr: '快',
    color: '#FF6A00',
    colorDark: '#FF8A3D',
    entry: 'https://cp.kuaishou.com/article/manage/video?status=1&from=publish',
    origin: 'https://cp.kuaishou.com',
    note: '快手创作服务平台',
    loginHint: '',
    embedBlocked: true,
    healthProbe: 'entry',
    loginHints: ['/login', 'passport', 'sso.']
  }
];

const PLATFORM_IDS = PLATFORMS.map((p) => p.id);

function getPlatform(id) {
  return PLATFORMS.find((p) => p.id === id) || null;
}

function isValidPlatform(id) {
  return PLATFORM_IDS.indexOf(id) !== -1;
}

function platformName(id) {
  const p = getPlatform(id);
  return p ? p.name : id;
}

module.exports = { PLATFORMS, PLATFORM_IDS, getPlatform, isValidPlatform, platformName };
