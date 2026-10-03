# macOS 启动与验证

适用 Apple silicon（arm64）。当前仍是仓库双击启动器，不是已签名的 macOS `.app` 或 DMG。

## 使用

1. 准备 Node.js 24.21.0 或更新的 24.x、uv 和 FFmpeg（含 ffprobe）。使用 nvm 时可在仓库运行 `nvm install`；Finder 启动会尝试激活仓库指定版本。
2. 双击 `MusicScope.command`。首次下载 Python 依赖并构建界面，后续复用；不需要 Docker。
3. 浏览器打开本地 Studio。关闭浏览器可继续后台处理；退出启动终端或按 Ctrl+C 会停止服务和当前分轨。

依赖与生产界面位于仓库 `.venv` / `.tools/mac` 等忽略目录；正常启动不运行开发服务器。
资料、密钥和日志位于 `~/Library/Application Support/MusicScope/workspace`。
模型默认位于 `~/Library/Caches/MusicScope/models`。模型准备与分轨计算使用独立超时；下载校验通过后加载本地文件。

## 旧资料和参数

- 旧 Docker/PostgreSQL 数据、仓库 `.env`、源码版音频均保留；不会自动转换成 SQLite。
- 继续使用旧资料：`./MusicScope.command --legacy-docker`，仍需 Docker Desktop。
- 仅准备依赖/界面：`./MusicScope.command --setup`。
- 只读状态：`./MusicScope.command --status`，不会创建资料目录或触发安装。
- 不打开浏览器：`./MusicScope.command --no-open`。
- 临时指定隔离目录：设置 `MUSICSCOPE_DATA_DIR`；不会覆盖仓库 `.env`。
- CPU 回退：`AUDIO_WORKER_DEVICE=cpu ./MusicScope.command`。

同一个资料目录只允许一份启动器。8100/3100 端口被占用时明确报错，不连接或终止未知服务。
网易云服务使用动态本地端口，失败不阻塞本地分轨。准备失败详情见资料目录 `.logs/mac-setup.log`，
服务日志分别写入同目录的 `desktop-*.log`。日志可能含私人路径，不要原样公开。

## 验收边界

本轮使用隔离中文/空格目录测试真实 Apple silicon macOS，不读取或修改用户的旧库。
离线测试通过 macOS `sandbox-exec` 阻止该启动器及其子进程访问外网，保留本机通信，
同时用外部 TCP 探针验证阻断。它不会更改系统全局防火墙。

生成信号可以验证模型执行、六轨文件、界面播放进度和导出完整性，不能评价歌曲分离听感，
也不能代表人工听音或所有声卡、Intel Mac 的兼容性。
