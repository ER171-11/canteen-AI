'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// 桥接主进程能力：业务数据仍走 /api 代理访问后端，这里只暴露桌面端特有的能力。
contextBridge.exposeInMainWorld('canteenDesktop', {
  version: process.versions.electron,
  // 应用版本号（package.json 的 version）
  appVersion: () => ipcRenderer.invoke('app:version'),
  // 手动触发「检查更新」（返回 {ok, version?} | {ok:false, error}）；启动时主进程会自动检查一次
  checkUpdate: () => ipcRenderer.invoke('app:check-update'),
});
