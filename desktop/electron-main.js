'use strict';
/*
 * electron-main.js —— 桌面端主进程
 *   - 用 Electron 自带的 Node 拉起零依赖 BFF（bff/server.js）作为子进程
 *   - 起一个本地静态服务托管构建后的前端 dist，并把 /api 反向代理到 BFF
 *   - 打开窗口加载本地页面；退出时关闭 BFF 子进程
 *
 * 体积优化要点（见 package.json 的 build 配置）：
 *   - 只打包 dist + bff 源码，不打包 node_modules / src / 移动端 / kmp
 *   - asar 压缩 + 仅 zh-CN 语言包 + NSIS 最大压缩
 */
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const isDev = !app.isPackaged;

const appRoot = app.getAppPath();
const distDir = path.join(appRoot, 'app', 'dist');
const bffDir = isDev
  ? path.join(appRoot, 'app', 'bff')
  : path.join(process.resourcesPath, 'app.asar.unpacked', 'app', 'bff');

const BFF_HOST = process.env.BFF_HOST || '127.0.0.1';
const PREFERRED_BFF_PORT = parseInt(process.env.BFF_PORT || '8787', 10);
const WEB_PORT = process.env.WEB_PORT || '5180';
const CANTEEN_ENV = process.env.CANTEEN_ENV || 'real';

/* 桌面端自带 BFF，数据目录放「用户数据区」：
 *   - 不跟安装目录走 —— 升级/重装不丢数据，也不受安装目录是否可写的影响；
 *   - 首启从包内 data.seed 播种一份「空快照」基线。没有快照时
 *     /api/snapshot/latest 会 404 → 前端 isMock → 所有写入口被禁（空库死锁：
 *     没有数据就建不了数据），播种后「新增原料 → 进货入库」这条线才走得通。 */
const BFF_DATA_DIR = isDev ? null : path.join(app.getPath('userData'), 'bff-data');
/* 桌面端没有店内消费器（store-node/consumer），审批「通过」后没人执行队列，
 * 动作会永远停在「待执行」。桌面端改为确认后由 BFF 直接落地（见 bff/routes/actions.js）。
 * 注意：开启后动作不再回店内消费器，故不可与真实店内节点并用；
 *       将来接上店内节点时，用环境变量 CANTEEN_LOCAL_APPLY=0 关闭即可。 */
const LOCAL_APPLY = isDev ? null : (process.env.CANTEEN_LOCAL_APPLY === '0' ? null : '1');

let bffPort = PREFERRED_BFF_PORT; // 实际使用端口（首选端口被占用时自动顺延）
let bffProc = null;
let mainWindow = null;

/* ------------------------------------------------------------------ */
/* 日志：打包后的 Windows GUI 进程没有控制台，往 stdout 写入会抛        */
/* EPIPE(broken pipe) 未捕获异常，把主进程直接打死，现场表现为          */
/* 「A JavaScript error occurred in the main process」。               */
/* 所以日志一律落盘（userData/logs/desktop.log），写 stdout 只是尽力。  */
/* ------------------------------------------------------------------ */
let _logFile = null;
function logFile() {
  if (_logFile) return _logFile;
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    _logFile = path.join(dir, 'desktop.log');
  } catch (e) {
    _logFile = path.join(process.cwd(), 'desktop.log');
  }
  return _logFile;
}
function log(line) {
  const text = `[${new Date().toISOString()}] ${line}`;
  try { fs.appendFileSync(logFile(), text + '\n'); } catch (e) {}
  try { process.stdout.write(text + '\n'); } catch (e) { /* 无控制台：EPIPE 丢弃 */ }
}
// 兜底：任何漏网异常只记日志，不再弹「主进程 JavaScript error」并杀掉进程
if (app.isPackaged) {
  try { process.removeAllListeners('uncaughtException'); } catch (e) {}
}
process.on('uncaughtException', (err) => {
  log('[desktop] uncaughtException: ' + ((err && err.stack) || err));
});

/* ------------------------------------------------------------------ */
/* 检查更新（electron-updater + GitHub Releases provider）              */
/*   - 仅打包版启用（app.isPackaged）；开发态无 app-update.yml 会报错，直接跳过 */
/*   - electron-updater 是桌面端唯一的第三方运行时依赖，require 失败时降级为「无更新检查」，*/
/*     绝不因它阻断 BFF / 页面启动                                             */
/* ------------------------------------------------------------------ */
let autoUpdater = null;
try {
  autoUpdater = require('electron-updater').autoUpdater;
} catch (e) {
  log('[desktop] 加载 electron-updater 失败（跳过检查更新）：' + ((e && e.message) || e));
}
let updateReady = false; // 已下载待安装

function initAutoUpdate() {
  if (!autoUpdater || !app.isPackaged) return;

  // 允许用 CANTEEN_UPDATE_URL 覆盖更新源（自建静态服务器 / 内网镜像），否则走 app-update.yml 的 GitHub 配置
  const feedUrl = String(process.env.CANTEEN_UPDATE_URL || '').trim();
  if (feedUrl) {
    try { autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl }); }
    catch (e) { log('[desktop] 设置自定义更新源失败：' + ((e && e.message) || e)); }
  }

  autoUpdater.autoDownload = false; // 先询问，用户确认后再下载
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    log('[desktop] 发现新版本 v' + info.version);
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '发现新版本',
      message: '发现新版本 v' + info.version,
      detail: '是否立即下载更新？（下载完成后重启安装）',
      buttons: ['立即下载', '稍后再说'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }).then(({ response }) => {
      if (response === 0) {
        autoUpdater.downloadUpdate().catch((e) => log('[desktop] 下载更新失败：' + ((e && e.message) || e)));
      }
    }).catch((e) => log('[desktop] 更新提示弹窗失败：' + ((e && e.message) || e)));
  });

  autoUpdater.on('update-not-available', () => log('[desktop] 已是最新版本'));

  autoUpdater.on('update-downloaded', (info) => {
    log('[desktop] 新版本已下载 v' + info.version);
    updateReady = true;
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '更新已就绪',
      message: '新版本 v' + info.version + ' 已下载完成',
      detail: '立即重启以完成安装？（数据在用户目录，升级不会丢失）',
      buttons: ['立即重启安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    }).catch((e) => log('[desktop] 更新提示弹窗失败：' + ((e && e.message) || e)));
  });

  autoUpdater.on('error', (err) => {
    log('[desktop] 检查更新出错：' + ((err && err.message) || err));
  });

  // 等窗口与 BFF 起来后，静默检查一次
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((e) => log('[desktop] 检查更新失败：' + ((e && e.message) || e)));
  }, 8000);
}

// 供前端「检查更新」按钮手动触发（预留；当前 dist 未接，不影响启动自动检查）
ipcMain.handle('app:check-update', () => {
  if (!autoUpdater || !app.isPackaged) return { ok: false, error: 'update check unavailable (dev/unpackaged)' };
  return autoUpdater.checkForUpdates()
    .then((r) => ({ ok: true, version: r && r.updateInfo && r.updateInfo.version }))
    .catch((e) => ({ ok: false, error: (e && e.message) || String(e) }));
});
ipcMain.handle('app:version', () => ({ version: app.getVersion() }));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

/**
 * 首启播种：把包内出厂快照（空快照基线）复制到 BFF 数据目录。
 * 已有 snapshot.json 时一律不动 —— 不覆盖店内节点推来的真实快照。
 */
function seedBffData(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    log('[desktop] 创建 BFF 数据目录失败: ' + (e && e.message));
    return;
  }
  const target = path.join(dir, 'snapshot.json');
  if (fs.existsSync(target)) return;
  const src = path.join(bffDir, 'data.seed', 'snapshot.json');
  try {
    if (!fs.existsSync(src)) {
      log('[desktop] 未找到出厂种子快照: ' + src);
      return;
    }
    fs.copyFileSync(src, target);
    log('[desktop] 已写入出厂空快照基线 → ' + target);
  } catch (e) {
    log('[desktop] 播种出厂快照失败: ' + (e && e.message));
  }
}

/** 端口是否可监听（先占位再释放，避免直接用 EADDRINUSE 硬碰） */
function probePort(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

/**
 * 选一个空闲端口：首选端口被占用则顺延 20 个，再不行由系统随机分配。
 * BFF（8787）与页面静态服务（5180）都走这里。
 * 说明：前端通过主进程的 /api 反向代理访问 BFF，不依赖固定端口，
 *       所以顺延端口对页面无感；8787/5180 常被开发环境占着，是安装包
 *       「BFF 未就绪 / 打开白屏」的高发原因。
 */
async function pickFreePort(preferred, host) {
  const base = Number.isFinite(preferred) ? preferred : 0;
  for (let p = base; p < base + 20; p++) {
    if (await probePort(p, host)) return p;
  }
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, host, () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

/* BFF 子进程输出（滚动保留最后 100 行，失败时回显给用户） */
const bffOutput = [];
function pushBffOutput(chunk) {
  for (const raw of chunk.toString().split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const line = raw; // BFF 自身输出已带 [BFF] 前缀，这里不再重复加
    bffOutput.push(line);
    if (bffOutput.length > 100) bffOutput.shift();
    log(line);
  }
}

function startBff() {
  return new Promise(async (resolve, reject) => {
    bffPort = await pickFreePort(PREFERRED_BFF_PORT, BFF_HOST);
    if (bffPort !== PREFERRED_BFF_PORT) {
      log(`[desktop] 端口 ${PREFERRED_BFF_PORT} 已被占用，BFF 改用 ${bffPort}`);
    }
    if (BFF_DATA_DIR) {
      seedBffData(BFF_DATA_DIR);
      log('[desktop] BFF 数据目录: ' + BFF_DATA_DIR);
    }

    bffProc = spawn(process.execPath, [path.join(bffDir, 'server.js')], {
      cwd: bffDir,
      windowsHide: true,
      env: {
        ...process.env,
        BFF_PORT: String(bffPort),
        BFF_HOST,
        CANTEEN_ENV,
        // 以「纯 Node」模式跑子进程：不初始化 Chromium/GUI，行为等同 node server.js
        ELECTRON_RUN_AS_NODE: '1',
        ...(BFF_DATA_DIR ? { BFF_DATA_DIR, CANTEEN_LOCAL_APPLY: LOCAL_APPLY } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    bffProc.stdout.on('data', pushBffOutput);
    bffProc.stderr.on('data', pushBffOutput);

    let exited = null;
    bffProc.on('error', (e) => {
      log('[desktop] BFF 子进程启动失败: ' + e.message);
      exited = { code: 'spawn-error', detail: e.message };
    });
    bffProc.on('exit', (code, signal) => {
      log(`[desktop] BFF 子进程退出 code=${code} signal=${signal || ''}`);
      exited = { code, signal };
    });

    const deadline = Date.now() + 30000;
    let settled = false;
    const tail = () => bffOutput.slice(-12).join('\n');
    const tick = () => {
      if (settled) return;
      http
        .get(`http://${BFF_HOST}:${bffPort}/api/health`, (res) => {
          if (res.statusCode === 200) {
            settled = true;
            log(`[desktop] BFF 就绪 http://${BFF_HOST}:${bffPort}`);
            return resolve();
          }
          res.resume();
          retry();
        })
        .on('error', retry);
    };
    const retry = () => {
      if (settled) return;
      // fail-fast：子进程已退出就别再空等 30 秒，直接把它的输出带出来
      if (exited) {
        settled = true;
        return reject(new Error(
          `BFF 进程已退出（code=${exited.code}${exited.detail ? '，' + exited.detail : ''}）\n` + tail()
        ));
      }
      if (Date.now() > deadline) {
        settled = true;
        return reject(new Error('BFF 在 30 秒内未就绪（/api/health 无响应）\n' + tail()));
      }
      setTimeout(tick, 500);
    };
    tick();
  });
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  let filePath = path.join(distDir, urlPath);
  if (!filePath.startsWith(distDir)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) filePath = path.join(distDir, 'index.html');
    fs.readFile(filePath, (e, data) => {
      if (e) {
        res.writeHead(404);
        return res.end('not found');
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  });
}

function proxyApi(req, res) {
  const opts = {
    host: BFF_HOST,
    port: bffPort,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `${BFF_HOST}:${bffPort}` },
  };
  const p = http.request(opts, (pres) => {
    res.writeHead(pres.statusCode, pres.headers);
    pres.pipe(res);
  });
  p.on('error', (e) => {
    res.writeHead(502);
    res.end('BFF proxy error: ' + e.message);
  });
  req.pipe(p);
}

function createServer() {
  return http.createServer((req, res) => {
    if ((req.url || '').startsWith('/api/')) return proxyApi(req, res);
    return serveStatic(req, res);
  });
}

function stopBff() {
  if (!bffProc) return;
  const pid = bffProc.pid;
  try { bffProc.kill(); } catch (e) {}
  bffProc = null;
  // Windows 下 kill() 只结束父进程，残留的 Electron 子进程会继续占着端口
  if (process.platform === 'win32' && pid) {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch (e) {}
  }
}

/* 单实例：第二次双击只聚焦已有窗口。
 * 两个实例会抢同一个 BFF 端口 / 同一份数据目录 / 同一个页面端口，
 * 必须挡掉，否则第二个实例会页面白屏（端口被占）。 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

app.whenReady().then(async () => {
  try {
    await startBff();
  } catch (e) {
    const detail = [
      'BFF 后端未能启动：',
      String((e && e.message) || e),
      '',
      `日志文件：${logFile()}`,
      '',
      '排查提示：若日志里出现 EADDRINUSE，说明端口被其它程序占用，',
      '关闭旧的 BFF/后台进程后重开即可。',
    ].join('\n');
    log('[desktop] 启动失败：' + ((e && e.message) || e));
    dialog.showErrorBox('启动失败', detail);
    app.quit();
    return;
  }

  const server = createServer();
  const webPref = parseInt(WEB_PORT, 10);
  const webPort = await pickFreePort(webPref, '127.0.0.1');
  if (webPort !== webPref) {
    log(`[desktop] 端口 ${WEB_PORT} 已被占用，页面服务改用 ${webPort}`);
  }
  await new Promise((r) => server.listen(webPort, '127.0.0.1', r));

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 720,
    title: '熊猫五福餐厅 · 管理后台',
    backgroundColor: '#f5f5f5',
    webPreferences: {
      preload: path.join(__dirname, 'electron-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${webPort}/`);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  initAutoUpdate();

  const cleanup = () => stopBff();
  app.on('before-quit', cleanup);
  mainWindow.on('close', cleanup);
});

app.on('window-all-closed', () => {
  stopBff();
  if (process.platform !== 'darwin') app.quit();
});
} /* end: 单实例锁分支 */
