const { app, BrowserWindow, dialog, ipcMain, shell, session } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let window, backend, workspace, stopFile;
let closing = false;
let ready = false;
let status = { title: '正在准备 MusicScope', detail: '首次运行会自动下载所需组件，请保持联网。', failed: false };
const loadingPage = pathToFileURL(path.join(__dirname, 'loading.html')).href;
const smoke = process.argv.includes('--smoke-test');

function publish(title, detail, failed = false) {
  status = { title, detail, failed };
  if (window && !window.isDestroyed()) window.webContents.send('startup-status', status);
}

function fail(error) {
  publish('准备未完成', '下载进度与资料已保留。可关闭后重新打开；详细原因：' + error.message, true);
  if (smoke) app.exit(1);
}

async function launch() {
  const source = app.isPackaged ? path.join(process.resourcesPath, 'project') : path.resolve(__dirname, '../..');
  workspace = smoke ? source : path.join(app.getPath('userData'), 'workspace');
  if (!smoke) {
    // Copy only the release's explicit source tree; never bundle personal state.
    fs.mkdirSync(workspace, { recursive: true });
    for (const name of ['apps', 'services', 'scripts', 'contracts', '.env.example', '.node-version', 'docker-compose.yml']) {
      fs.cpSync(path.join(source, name), path.join(workspace, name), { recursive: true,
        filter: (file) => !/(?:^|[\\/])(?:node_modules|\.venv|\.next|desktop)(?:[\\/]|$)/.test(path.relative(source, file)) });
    }
  }
  fs.mkdirSync(path.join(workspace, '.logs'), { recursive: true });
  stopFile = path.join(workspace, '.logs', 'desktop-stop');
  fs.rmSync(stopFile, { force: true });
  const output = fs.createWriteStream(path.join(workspace, '.logs', 'desktop.log'), { flags: 'a' });
  backend = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(workspace, 'scripts', 'dev.ps1'), '-NoOpen', '-StopFile', stopFile],
  { cwd: workspace, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' } });
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
        window.webContents.on('will-navigate', (event, url) => {
          if (new URL(url).origin !== origin) event.preventDefault();
        });
        window.loadURL(origin + '/studio').catch(fail);
        if (smoke) window.webContents.once('did-finish-load', () => {
          setTimeout(async () => {
            try {
              const screenshot = await window.webContents.capturePage();
              fs.writeFileSync(path.join(workspace, '.logs', 'desktop-preview.png'), screenshot.toPNG());
              fs.writeFileSync(path.join(workspace, '.logs', 'desktop-smoke-passed'), 'studio loaded');
              app.quit();
            } catch (error) { fail(error); }
          }, 3000);
        });
      }
    }
  });
  backend.stderr.on('data', (chunk) => output.write(chunk));
  backend.once('error', fail);
  backend.once('exit', (code) => {
    output.end();
    if (closing) return;
    if (code !== 0 || !ready) fail(new Error('启动进程已退出，请查看日志。'));
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
  if (closing || !backend || backend.exitCode !== null) return;
  event.preventDefault();
  closing = true;
  if (stopFile) fs.writeFileSync(stopFile, 'stop');
  backend.once('exit', () => app.quit());
  setTimeout(() => {
    if (backend.exitCode === null) spawn('taskkill', ['/PID', String(backend.pid), '/T', '/F'], { windowsHide: true });
    app.quit();
  }, 5000);
});
