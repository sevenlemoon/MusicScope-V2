// Source-distribution bootstrap for Apple silicon. The running application uses
// the same supervisor as the packaged Windows app, without Docker or next dev.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { runtimeEnvironment, assertFreePort, supervise } = require('../apps/desktop/runtime.cjs');

const root = path.resolve(__dirname, '..');
const say = (message) => process.stdout.write(`[MusicScope] ${message}\n`);

function fingerprint(directory, ignored = new Set()) {
  const hash = crypto.createHash('sha256');
  function visit(relative) {
    const full = path.join(directory, relative);
    for (const entry of fs.readdirSync(full, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ignored.has(entry.name) || entry.name.endsWith('.tsbuildinfo')) continue;
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) { hash.update(child); hash.update(fs.readFileSync(path.join(directory, child))); }
    }
  }
  visit('');
  hash.update(`${process.platform}/${process.arch}/${process.versions.node}`);
  return hash.digest('hex');
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function acquireLock(file) {
  const token = crypto.randomUUID();
  // Reclaim only a demonstrably dead owner. Never terminate a process to get a lock.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token, root }), { flag: 'wx', mode: 0o600 });
      return () => {
        try { if (JSON.parse(fs.readFileSync(file)).token === token) fs.unlinkSync(file); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let previous;
      try { previous = JSON.parse(fs.readFileSync(file)); }
      catch { throw new Error('启动锁尚未写完或已损坏，请稍后重试。'); }
      if (alive(previous.pid)) throw new Error('MusicScope 已在运行或准备中，请使用原窗口：http://127.0.0.1:3100/studio');
      fs.unlinkSync(file);
    }
  }
  throw new Error('另一份 MusicScope 正在启动。');
}

function executable(name) {
  const result = spawnSync('/usr/bin/which', [name], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`缺少 ${name}。首次准备需要 Node 24、uv 和 FFmpeg（包含 ffprobe）。`);
  return result.stdout.trim();
}

function listenerPids(port) {
  const result = spawnSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
  if (result.status !== 0 && result.status !== 1) throw new Error(`无法检查端口 ${port} 的监听进程。`);
  return [...new Set((result.stdout || '').split(/\s+/).filter((value) => /^\d+$/.test(value)).map(Number))];
}

function processDetails(pid) {
  const command = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).stdout.trim();
  const cwd = spawnSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' }).stdout
    .split('\n').find((line) => line.startsWith('n'))?.slice(1) || '';
  return { command, cwd };
}

function serviceProcessBelongsToInstall(service, { command, cwd }) {
  if (service === 'web') {
    return cwd === path.join(root, '.tools/mac/web') && /(?:next-server|server\.js)/.test(command);
  }
  if (service === 'api') {
    return cwd === path.join(root, 'apps/api') && /-m uvicorn app\.main:app(?:\s|$)/.test(command);
  }
  return false;
}

function serviceProcessBelongsToWorker({ command, cwd }) {
  return cwd === path.join(root, 'apps/audio-worker') && command.includes('-m audio_worker');
}

function workerStatus(data) {
  let health;
  try { health = JSON.parse(fs.readFileSync(path.join(data, '.logs', 'desktop-worker-health.json'), 'utf8')); }
  catch { return { pid: null, owned: false, healthy: false }; }
  const pid = health?.pid;
  if (!Number.isSafeInteger(pid) || pid < 2) return { pid: null, owned: false, healthy: false };
  const details = processDetails(pid);
  const owned = serviceProcessBelongsToWorker(details);
  if (!owned || !alive(pid)) return { pid, owned: false, healthy: false };
  const stateIsActive = ['idle', 'processing'].includes(health.state);
  const updatedAt = Date.parse(health.updated_at || '');
  const idleIsFresh = health.state !== 'idle' ||
    (Number.isFinite(updatedAt) && Date.now() - updatedAt >= -30_000 && Date.now() - updatedAt <= 30_000);
  return { pid, owned: true, healthy: stateIsActive && idleIsFresh };
}

function belongsToInstall(pid, service) {
  return serviceProcessBelongsToInstall(service, processDetails(pid));
}

async function probe(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1200) });
    if (!response.ok) return null;
    return response;
  } catch { return null; }
}

async function handleExistingServices(data) {
  const apiPids = listenerPids(8100), webPids = listenerPids(3100);
  const worker = workerStatus(data);
  if (!apiPids.length && !webPids.length && !worker.owned) return false;

  const unknown = [
    ...apiPids.filter((pid) => !belongsToInstall(pid, 'api')).map((pid) => [pid, 'API']),
    ...webPids.filter((pid) => !belongsToInstall(pid, 'web')).map((pid) => [pid, 'Web']),
  ];
  if (unknown.length) {
    const occupied = unknown.map(([pid]) => {
      const { command, cwd } = processDetails(pid);
      return `PID ${pid}: ${command || '命令不可读'}${cwd ? `（${cwd}）` : ''}`;
    }).join('\n');
    const ports = [...new Set(unknown.map(([pid, service]) => service === 'API' ? '8100' : '3100'))].join('、');
    throw new Error(`端口 ${ports} 已被占用，但无法确认是 MusicScope 的生产服务；不会连接或结束未知服务。\n${occupied}`);
  }

  const webResponse = webPids.length ? await probe('http://127.0.0.1:3100/studio') : null;
  const apiResponse = apiPids.length ? await probe('http://127.0.0.1:8100/health') : null;
  let apiHealthy = false;
  if (apiResponse) {
    try { apiHealthy = (await apiResponse.json()).service === 'musicscope-v2-api'; } catch { apiHealthy = false; }
  }
  if (apiPids.length && webPids.length && webResponse && apiHealthy && worker.healthy) {
    say('MusicScope 已在运行：http://127.0.0.1:3100/studio');
    say('API、网页和音频引擎均健康；请在浏览器中使用现有窗口。');
    return true;
  }

  const ownedPids = [...new Set([...apiPids, ...webPids, ...(worker.owned ? [worker.pid] : [])])];
  say('发现本项目残留或不健康的服务，正在安全停止并重新启动。');
  for (const pid of ownedPids) {
    try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  for (let attempt = 0; attempt < 50; attempt++) {
    const portsClear = listenerPids(8100).length === 0 && listenerPids(3100).length === 0;
    const workerStopped = !worker.owned || !alive(worker.pid) ||
      !serviceProcessBelongsToWorker(processDetails(worker.pid));
    if (portsClear && workerStopped) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (listenerPids(8100).length || listenerPids(3100).length ||
      (worker.owned && alive(worker.pid) && serviceProcessBelongsToWorker(processDetails(worker.pid)))) {
    throw new Error('MusicScope 的残留服务未能退出。已确认身份的进程收到正常停止请求；请检查本项目日志后重试。');
  }
  say('已清理确认属于本项目的残留服务，继续启动完整服务组。');
  return false;
}

async function launch(args = process.argv.slice(2)) {
  for (const arg of args) if (!['--setup', '--status', '--no-open', '--help', '-h'].includes(arg)) throw new Error(`未知参数：${arg}`);
  if (args.includes('--help') || args.includes('-h')) {
    say('双击启动本地版；--setup 仅准备；--status 只读状态；--no-open 不打开浏览器；--legacy-docker 打开旧 Docker 资料（交给 start_mac.sh）。');
    return;
  }
  const data = path.resolve(process.env.MUSICSCOPE_DATA_DIR || path.join(os.homedir(), 'Library/Application Support/MusicScope/workspace'));
  const logs = path.join(data, '.logs');
  const lock = path.join(logs, 'mac-launcher.json');
  if (args.includes('--status')) {
    let owner;
    try { owner = JSON.parse(fs.readFileSync(lock)); } catch { /* absent or incomplete */ }
    say(`资料目录：${data}`);
    say(`启动进程：${alive(owner?.pid) ? '正在运行或准备' : '未运行'}`);
    say(`本地资料库：${fs.existsSync(path.join(data, 'storage/library.sqlite3')) ? '已建立' : '尚未建立'}`);
    return;
  }
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor < 21) throw new Error('需要 Node.js 24.21.0 或更新的 24.x；请用 nvm install 安装仓库固定版本。');
  const uv = executable('uv'), npm = executable('npm');
  const paths = {
    node: process.execPath, ffmpeg: executable('ffmpeg'), ffprobe: executable('ffprobe'),
    python: path.join(root, 'apps/api/.venv/bin/python'),
    workerPython: path.join(root, 'apps/audio-worker/.venv/bin/python'),
    api: path.join(root, 'apps/api'), worker: path.join(root, 'apps/audio-worker'),
    sidecar: path.join(root, 'services/netease-api/server.cjs'),
    web: path.join(root, '.tools/mac/web/server.js'),
  };
  fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
  fs.chmodSync(data, 0o700);
  const unlock = acquireLock(lock);
  const setupLog = path.join(logs, 'mac-setup.log');
  const env = runtimeEnvironment(root, data, process.env, paths);
  const markers = path.join(root, '.tools/mac');
  let active;
  let interrupted = false;
  const checkInterrupted = () => { if (interrupted) throw new Error('启动已取消。'); };
  const interrupt = () => {
    interrupted = true;
    if (active) { try { process.kill(-active.pid, 'SIGTERM'); } catch {} }
  };
  const run = (exe, argv, cwd = root) => new Promise((resolve, reject) => {
    checkInterrupted();
    const fd = fs.openSync(setupLog, 'a', 0o600);
    const child = spawn(exe, argv, { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
    fs.closeSync(fd);
    active = child;
    child.once('error', reject);
    child.once('exit', (code) => { active = null; code === 0 && !interrupted ? resolve() : reject(new Error(`组件准备中断，请查看 ${setupLog}`)); });
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, interrupt);
  try {
    if (await handleExistingServices(data)) return;
    await assertFreePort(8100); await assertFreePort(3100);
    fs.mkdirSync(markers, { recursive: true });
    say(`本地资料：${data}（无需 Docker）。首次准备会下载依赖，后续按版本复用。`);
    if (fs.existsSync(path.join(root, '.env'))) say('仓库中的旧资料和配置已保留；打开旧 Docker 资料请用 MusicScope.command --legacy-docker。');
    for (const [name, python, imports] of [
      ['api', paths.python, 'import fastapi, uvicorn, alembic, cryptography'],
      ['audio-worker', paths.workerPython, 'import torch, demucs, sphn, numpy'],
    ]) {
      const project = path.join(root, 'apps', name);
      const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(project, 'pyproject.toml')))
        .update(fs.readFileSync(path.join(project, 'uv.lock'))).digest('hex');
      const marker = path.join(markers, `${name}.sha256`);
      const valid = fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === digest &&
        spawnSync(python, ['-c', imports], { env, stdio: 'ignore' }).status === 0;
      if (!valid) {
        say(`正在准备 ${name}，详情记录在 mac-setup.log`);
        await run(uv, ['sync', '--project', project, '--python', '3.12', '--locked', '--no-dev', '--inexact']);
        if (spawnSync(python, ['-c', imports], { env, stdio: 'ignore' }).status !== 0) throw new Error(`${name} 依赖校验失败。`);
        fs.writeFileSync(marker, digest);
      } else say(`复用 ${name} 依赖`);
    }
    for (const [relative, name] of [['apps/web', 'web'], ['services/netease-api', 'netease']]) {
      const project = path.join(root, relative);
      const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(project, 'package-lock.json')))
        .update(fs.readFileSync(path.join(project, 'package.json'))).digest('hex');
      const marker = path.join(markers, `${name}.sha256`);
      if (!fs.existsSync(path.join(project, 'node_modules')) || !fs.existsSync(marker) || fs.readFileSync(marker, 'utf8') !== digest) {
        say(`正在准备 ${name} 依赖`);
        try {
          await run(npm, ['ci', '--no-audit', '--no-fund', name === 'netease' ? '--omit=dev' : '--include=dev'], project);
          fs.writeFileSync(marker, digest);
        } catch (error) {
          if (interrupted || name !== 'netease') throw error;
          say('网易云组件准备失败，本地文件分轨仍可使用；下次启动会重试。');
        }
      } else say(`复用 ${name} 依赖`);
    }
    const webSource = path.join(root, 'apps/web');
    const digest = fingerprint(webSource, new Set(['node_modules', '.next', 'next-env.d.ts', 'coverage', 'AGENTS.md', '.DS_Store']));
    const webMarker = path.join(markers, 'production-web.sha256');
    if (!fs.existsSync(paths.web) || !fs.existsSync(webMarker) || fs.readFileSync(webMarker, 'utf8') !== digest) {
      say('正在构建生产界面；源码未变时，下次启动会直接复用。');
      env.NEXT_PUBLIC_API_URL = 'http://127.0.0.1:8100';
      await run(npm, ['run', 'build'], webSource);
      const staged = path.join(markers, `web-${crypto.randomUUID()}`);
      try {
        fs.cpSync(path.join(webSource, '.next/standalone'), staged, { recursive: true, dereference: true,
          filter: (file) => !path.basename(file).startsWith('.env') });
        fs.cpSync(path.join(webSource, '.next/static'), path.join(staged, '.next/static'), { recursive: true });
        if (fs.existsSync(path.join(webSource, 'public'))) fs.cpSync(path.join(webSource, 'public'), path.join(staged, 'public'), { recursive: true });
        if (!fs.existsSync(path.join(staged, 'server.js'))) throw new Error('生产界面入口缺失。');
        fs.rmSync(path.dirname(paths.web), { recursive: true, force: true });
        fs.renameSync(staged, path.dirname(paths.web));
        fs.writeFileSync(webMarker, digest);
      } finally { fs.rmSync(staged, { recursive: true, force: true }); }
    } else say('复用已构建的生产界面');
    checkInterrupted();
    if (args.includes('--setup')) { say('组件准备完成。'); return; }
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(signal, interrupt);
    fs.rmSync(path.join(logs, 'desktop-stop'), { force: true });
    say('关闭此终端或按 Ctrl+C 会停止分轨服务；关闭浏览器不会停止后台任务。');
    await supervise(root, data, { paths, onReady: async () => {
      if (!args.includes('--no-open')) spawn('/usr/bin/open', ['http://127.0.0.1:3100/studio'], { stdio: 'ignore' }).on('error', () => {});
    } });
  } finally {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(signal, interrupt);
    unlock();
  }
}

module.exports = { fingerprint, acquireLock, alive, listenerPids, belongsToInstall, serviceProcessBelongsToInstall,
  serviceProcessBelongsToWorker, workerStatus, handleExistingServices, launch };
if (require.main === module) launch().catch((error) => { process.stderr.write(`[MusicScope] ${error.message}\n`); process.exitCode = 1; });
