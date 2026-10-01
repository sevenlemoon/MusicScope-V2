// Production supervisor. No package manager, downloader, or development server.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

function runtimePaths(project) {
  const paths = {
    python: path.join(project, 'runtime', 'python-api', 'python.exe'),
    workerPython: path.join(project, 'runtime', 'python-audio-worker', 'python.exe'),
    node: path.join(project, 'runtime', 'node', 'node.exe'),
    ffmpeg: path.join(project, 'runtime', 'ffmpeg', 'bin', 'ffmpeg.exe'),
    ffprobe: path.join(project, 'runtime', 'ffmpeg', 'bin', 'ffprobe.exe'),
    web: path.join(project, 'apps', 'web', 'server.js'),
    api: path.join(project, 'apps', 'api'),
    worker: path.join(project, 'apps', 'audio-worker'),
    sidecar: path.join(project, 'services', 'netease-api', 'server.cjs'),
  };
  for (const [name, file] of Object.entries(paths)) {
    if (!fs.existsSync(file)) throw new Error(`安装包缺少 ${name}，请重新完整解压发布包。`);
  }
  return paths;
}

function runtimeEnvironment(project, data, parent = process.env) {
  // Do not let developer/host configuration select another database or interpreter.
  const env = { ...parent };
  for (const key of Object.keys(env)) {
    if (/^(PYTHON|VIRTUAL_ENV|UV_|DATABASE_URL$|SECRET_ENCRYPTION_KEY|NODE_OPTIONS$|NODE_PATH$)/i.test(key)) delete env[key];
  }
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path');
  const inheritedPath = pathKey ? env[pathKey] : '';
  if (pathKey) delete env[pathKey];
  return { ...env,
    PATH: [path.join(project, 'runtime', 'ffmpeg', 'bin'), path.join(project, 'runtime', 'node'), inheritedPath].join(path.delimiter),
    PYTHONUTF8: '1', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1',
    MUSICSCOPE_DATA_DIR: data,
    DATABASE_URL: 'sqlite+pysqlite:///' + path.join(data, 'storage', 'library.sqlite3').replaceAll('\\', '/'),
    AUDIO_STORAGE_DIR: path.join(data, 'storage', 'audio'),
    NETEASE_API_BASE_URL: 'http://127.0.0.1:36531', MUSICSCOPE_NETEASE_PORT: '36531',
    WEB_ORIGINS: 'http://127.0.0.1:3100',
    NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
    HOSTNAME: '127.0.0.1', PORT: '3100',
  };
}

async function assertFreePort(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error(`端口 ${port} 已被占用。请关闭另一份 MusicScope 后重试；不会连接或结束未知服务。`)));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}

async function choosePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function supervise(project, data) {
  const paths = runtimePaths(project);
  const env = runtimeEnvironment(project, data);
  const sidecarPort = await choosePort();
  env.MUSICSCOPE_NETEASE_PORT = String(sidecarPort);
  env.NETEASE_API_BASE_URL = `http://127.0.0.1:${sidecarPort}`;
  const logs = path.join(data, '.logs');
  fs.mkdirSync(logs, { recursive: true });
  const stopFile = path.join(logs, 'desktop-stop');
  const healthFile = path.join(logs, 'desktop-worker-health.json');
  const children = [];
  let stopping = false;
  const say = (message) => process.stdout.write(`[MusicScope] ${message}\n`);
  const start = (name, executable, args, cwd) => {
    const fd = fs.openSync(path.join(logs, `${name}.log`), 'a');
    let child;
    try { child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ['ignore', fd, fd] }); }
    finally { fs.closeSync(fd); }
    child.on('error', (error) => { child.launchError = error; });
    children.push(child);
    return child;
  };
  const check = (child, name) => {
    if (stopping || fs.existsSync(stopFile)) throw new Error('启动已停止。');
    if (child.launchError || child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${name} 启动失败，详情见 ${name}.log。`);
    }
  };
  const command = async (name, args, cwd) => {
    const child = start(name, paths.python, args, cwd);
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    if (code !== 0) throw new Error(`${name} 失败；原资料已保留，请查看 ${name}.log。`);
  };
  const ready = async (child, name, probe) => {
    for (let i = 0; i < 120; i++) {
      check(child, name);
      if (await probe().catch(() => false)) { check(child, name); return; }
      await delay(500);
    }
    throw new Error(`${name} 启动超时，请查看 ${name}.log。`);
  };
  const stop = async () => {
    stopping = true;
    await Promise.all(children.map(async (child) => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform === 'win32') {
        await new Promise((resolve) => {
          const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
            ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
          killer.once('error', resolve); killer.once('exit', resolve);
        });
      } else child.kill('SIGTERM');
    }));
  };
  process.once('SIGTERM', () => { stopping = true; });
  process.once('SIGINT', () => { stopping = true; });
  try {
    await assertFreePort(8100);
    await assertFreePort(3100);
    say('正在检查本地资料（无需安装开发环境）');
    await command('desktop-data', [path.join(project, 'scripts', 'desktop_prepare.py')], project);
    await command('desktop-migrations', ['-m', 'alembic', 'upgrade', 'head'], paths.api);
    if (fs.existsSync(healthFile)) fs.unlinkSync(healthFile);
    say('正在启动音频引擎');
    const api = start('desktop-api', paths.python, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8100'], paths.api);
    await ready(api, 'desktop-api', async () => {
      const response = await fetch('http://127.0.0.1:8100/health', { signal: AbortSignal.timeout(1000) });
      return response.ok && (await response.json()).service === 'musicscope-v2-api';
    });
    const worker = start('desktop-worker', paths.workerPython, ['-m', 'audio_worker', '--health-file', healthFile], paths.worker);
    await ready(worker, 'desktop-worker', async () => {
      const health = JSON.parse(fs.readFileSync(healthFile, 'utf8'));
      return health.pid === worker.pid && ['idle', 'processing'].includes(health.state);
    });
    // Account service failure must not prevent local-file separation.
    let sidecar;
    try {
      await assertFreePort(sidecarPort);
      sidecar = start('desktop-netease', paths.node, [paths.sidecar], path.dirname(paths.sidecar));
    } catch { say('账号连接服务暂不可用，本地文件分轨不受影响。'); }
    const web = start('desktop-web', paths.node, [paths.web], path.dirname(paths.web));
    await ready(web, 'desktop-web', async () => (await fetch('http://127.0.0.1:3100/studio', { signal: AbortSignal.timeout(1000) })).ok);
    say('APPLICATION READY: http://127.0.0.1:3100');
    while (!stopping && !fs.existsSync(stopFile)) {
      check(api, 'desktop-api'); check(worker, 'desktop-worker'); check(web, 'desktop-web');
      if (sidecar && (sidecar.launchError || sidecar.exitCode !== null)) {
        say('账号连接服务已停止，本地文件分轨仍可使用。'); sidecar = undefined;
      }
      await delay(500);
    }
  } finally { await stop(); }
}

module.exports = { runtimePaths, runtimeEnvironment, assertFreePort, supervise };
if (require.main === module) {
  supervise(path.resolve(process.argv[2]), path.resolve(process.argv[3])).catch((error) => {
    process.stderr.write(`${error.message}\n`); process.exitCode = 1;
  });
}
