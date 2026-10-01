const { app, BrowserWindow, dialog, ipcMain, shell, session } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { runtimeEnvironment, runtimePaths } = require('./runtime.cjs');

app.setName('MusicScope');
const smoke = process.argv.includes('--smoke-test');
// CI uses an isolated profile, but the exact same launch and data path as users.
if (smoke && process.env.MUSICSCOPE_SMOKE_DATA_DIR) app.setPath('userData', path.resolve(process.env.MUSICSCOPE_SMOKE_DATA_DIR));
else app.setPath('userData', path.join(app.getPath('appData'), 'MusicScope'));

let window, backend, workspace, stopFile;
let closing = false;
let ready = false;
let smokeFailed = false;
let status = { title: '正在启动 MusicScope', detail: '正在检查内置组件与本地资料，无需安装开发环境。', failed: false };
const loadingPage = pathToFileURL(path.join(__dirname, 'loading.html')).href;

function publish(title, detail, failed = false) {
  status = { title, detail, failed };
  if (window && !window.isDestroyed()) window.webContents.send('startup-status', status);
}

function fail(error) {
  publish('启动或运行中断', '本地资料已保留。详细原因：' + error.message, true);
  if (ready && window && !window.isDestroyed()) {
    ready = false;
    window.loadFile(path.join(__dirname, 'loading.html')).catch(() => {});
  }
  if (smoke) { smokeFailed = true; app.quit(); }
}

async function launch() {
  if (smoke && !process.env.MUSICSCOPE_SMOKE_DATA_DIR) throw new Error('冒烟测试必须指定独立资料目录。');
  const source = app.isPackaged ? path.join(process.resourcesPath, 'project') : path.resolve(__dirname, '../..');
  runtimePaths(source);
  workspace = path.join(app.getPath('userData'), 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const identity = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
  const permissions = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe'),
    [workspace, '/inheritance:r', '/grant:r', `${identity}:(OI)(CI)F`], { windowsHide: true });
  if (permissions.status !== 0) throw new Error('无法保护本地资料目录权限，未创建账号密钥。');
  fs.mkdirSync(path.join(workspace, '.logs'), { recursive: true });
  stopFile = path.join(workspace, '.logs', 'desktop-stop');
  fs.rmSync(stopFile, { force: true });
  const output = fs.createWriteStream(path.join(workspace, '.logs', 'desktop.log'), { flags: 'a' });
  backend = spawn(path.join(source, 'runtime', 'node', 'node.exe'), [
    path.join(__dirname, 'runtime.cjs'), source, workspace],
  { cwd: workspace, windowsHide: true, env: runtimeEnvironment(source, workspace) });
  let pending = '';
  backend.stdout.on('data', (chunk) => {
    output.write(chunk);
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) {
      if (line.includes('[MusicScope]')) publish('正在启动', line.replace('[MusicScope] ', ''));
      const match = line.match(/APPLICATION READY: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match && !ready) {
        ready = true;
        const origin = match[1];
        if (smoke) window.webContents.once('did-finish-load', () => {
          setTimeout(async () => {
            try {
              const valid = await window.webContents.executeJavaScript(
                `Boolean(document.querySelector('.studio-page') && document.querySelector('.studio-mode-switch'))`);
              if (!valid) throw new Error('分轨界面未正常渲染。');
              const response = await fetch(origin.replace(':3100', ':8100') + '/api/v1/studio/jobs');
              if (!response.ok || !Array.isArray((await response.json()).items)) throw new Error('任务接口不可用。');
              const screenshot = await window.webContents.capturePage();
              fs.writeFileSync(path.join(workspace, '.logs', 'desktop-preview.png'), screenshot.toPNG());
              fs.writeFileSync(path.join(workspace, '.logs', 'desktop-smoke-passed'), 'studio loaded');
              app.quit();
            } catch (error) { fail(error); }
          }, 3000);
        });
        window.loadURL(origin + '/studio').catch(fail);
      }
    }
  });
  backend.stderr.on('data', (chunk) => output.write(chunk));
  backend.once('error', fail);
  backend.once('exit', (code) => {
    output.end();
    if (closing) return;
    fail(new Error(`运行进程已退出（${code ?? 'interrupted'}），请查看日志。`));
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
    if (process.platform !== 'win32') {
      await dialog.showMessageBox({ message: '此预览版本面向 Windows x64。macOS 请使用仓库启动器。' });
      return app.quit();
    }
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window = new BrowserWindow({ width: 1320, height: 900, minWidth: 960, minHeight: 680,
      title: 'MusicScope', backgroundColor: '#090c0e', autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false,
        contextIsolation: true, sandbox: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.on('close', (event) => {
      if (!closing && backend && backend.exitCode === null) {
        event.preventDefault();
        app.quit();
      }
    });
    window.webContents.on('will-navigate', (event, url) => {
      if (url !== loadingPage && new URL(url).origin !== 'http://127.0.0.1:3100') event.preventDefault();
    });
    ipcMain.handle('startup-status', (event) => event.senderFrame.url === loadingPage ? status : null);
    ipcMain.handle('open-logs', (event) => {
      if (event.senderFrame.url === loadingPage && workspace) return shell.openPath(path.join(workspace, '.logs'));
    });
    await window.loadFile(path.join(__dirname, 'loading.html'));
    launch().catch(fail);
  });
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (closing || !backend || backend.exitCode !== null) {
    if (smokeFailed) app.exit(1);
    return;
  }
  event.preventDefault();
  if (!smoke && ready) {
    const choice = dialog.showMessageBoxSync(window, { type: 'question',
      title: '退出 MusicScope？', message: '退出会停止当前分轨任务。',
      detail: '已完成的结果会保留；未完成的任务下次打开后可重试，但不能从中间续算。',
      buttons: ['继续使用', '停止并退出'], defaultId: 0, cancelId: 0 });
    if (choice !== 1) return;
  }
  closing = true;
  if (stopFile) fs.writeFileSync(stopFile, 'stop');
  backend.once('exit', () => app.quit());
  setTimeout(() => {
    if (backend.exitCode === null) spawn('taskkill', ['/PID', String(backend.pid), '/T', '/F'], { windowsHide: true });
    app.quit();
  }, 5000);
});
