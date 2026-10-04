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

module.exports = { fingerprint, acquireLock, alive, launch };
if (require.main === module) launch().catch((error) => { process.stderr.write(`[MusicScope] ${error.message}\n`); process.exitCode = 1; });
