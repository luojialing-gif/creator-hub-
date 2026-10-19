'use strict';

/**
 * 预加载脚本：渲染层唯一的能力出口。
 * 渲染层不接触 Node / fs / session，只能调用这里显式暴露的白名单方法。
 */

const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Map();

function on(channel, handler) {
  const wrapped = (event, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  listeners.set(channel + ':' + (handler.name || Math.random()), wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('hub', {
  /* ---- 数据 ---- */
  boot: () => ipcRenderer.invoke('hub:boot'),
  saveAccount: (payload) => ipcRenderer.invoke('hub:saveAccount', payload),
  deleteAccount: (id) => ipcRenderer.invoke('hub:deleteAccount', id),
  reorder: (platform, orderedIds) => ipcRenderer.invoke('hub:reorder', { platform, orderedIds }),
  move: (id, dir) => ipcRenderer.invoke('hub:move', { id, dir }),
  updateSettings: (patch) => ipcRenderer.invoke('hub:updateSettings', patch),
  exportAccounts: () => ipcRenderer.invoke('hub:export'),
  importAccounts: () => ipcRenderer.invoke('hub:import'),
  seedAccounts: () => ipcRenderer.invoke('hub:seed'),
  diagnostics: () => ipcRenderer.invoke('hub:diagnostics'),

  /* ---- 登录态守护 ---- */
  patrol: (payload) => ipcRenderer.invoke('hub:patrol', payload),
  flushSession: () => ipcRenderer.invoke('hub:flushSession'),

  /* ---- 视图 ---- */
  openView: (id, bounds) => ipcRenderer.invoke('view:open', { id, mode: 'embedded', bounds }),
  openWindow: (id) => ipcRenderer.invoke('view:open', { id, mode: 'window' }),
  openMany: (ids) => ipcRenderer.invoke('view:openMany', { ids }),
  closeView: () => ipcRenderer.invoke('view:close'),
  setViewBounds: (bounds) => ipcRenderer.invoke('view:bounds', bounds),
  hideView: () => ipcRenderer.invoke('view:hide'),
  showView: (bounds) => ipcRenderer.invoke('view:show', bounds),
  viewNav: (action) => ipcRenderer.invoke('view:nav', action),
  viewLoad: (url) => ipcRenderer.invoke('view:load', url),
  releaseBackgroundViews: () => ipcRenderer.invoke('view:releaseBackground'),

  /* ---- 本地数据清理（把某账号登出，只清本地） ---- */
  clearAccountData: (id) => ipcRenderer.invoke('hub:clearData', id),

  /* ---- 系统能力 ---- */
  copy: (text) => ipcRenderer.invoke('hub:copy', text),
  openExternal: (url) => ipcRenderer.invoke('hub:openExternal', url),
  openPath: (target) => ipcRenderer.invoke('hub:openPath', target),

  /* ---- 主进程 → 渲染层 ---- */
  onViewState: (cb) => on('view:state', cb),
  onViewFailed: (cb) => on('view:failed', cb),
  onViewActivated: (cb) => on('view:activated', cb),
  onViewClosed: (cb) => on('view:closed', cb),
  onNotice: (cb) => on('hub:notice', cb),
  onHealth: (cb) => on('hub:health', cb),
  onPatrolProgress: (cb) => on('hub:patrolProgress', cb),
  onPatrolDone: (cb) => on('hub:patrolDone', cb),
  onWindowResized: (cb) => on('window:resized', cb)
});
