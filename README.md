# MusicScope

**把喜欢的歌，拆成可以聆听、练习和再创作的六条音轨。**

A local-first six-stem studio for the music already in your library.

## Windows 桌面预览版

[下载桌面预览版](https://github.com/sevenlemoon/MusicScope-V2/releases/tag/v0.1.0-beta.1)：选择 `MusicScope-0.1.0-beta.1-windows-x64.zip`，完整解压到可写目录，再打开 `MusicScope.exe`。分轨界面直接显示在应用窗口中，无需命令行、Docker 或 WSL2。

首次打开会联网下载 Node、Python、FFmpeg 和音频引擎，并在窗口显示准备进度；模型在首次分轨时下载。资料库使用内置 SQLite，无需安装数据库。因此这是**联网初始化的桌面预览版，不是全离线安装包**。关闭后重新打开会复用组件，网络下载中断可续传。资料保存在 `%APPDATA%/MusicScope/workspace`，更新时保留该目录。原仓库或 Docker 资料库不会自动迁入桌面版。

当前提供 Windows x64 预览包，尚未购买代码签名证书，Windows 可能显示未知发布者提示；macOS 继续使用下面的源码启动方式。关闭应用会停止它启动的分轨服务，请等待当前任务完成后退出。

**先看实际界面：** [六轨混音与导出](https://github.com/sevenlemoon/MusicScope-V2/blob/master/docs/screenshots/studio-mixer.jpg) · [网易云扫码连接](https://github.com/sevenlemoon/MusicScope-V2/blob/master/docs/screenshots/netease-login.jpg) · [账号选歌](https://github.com/sevenlemoon/MusicScope-V2/blob/master/docs/screenshots/studio-account.jpg) · [本地文件导入](https://github.com/sevenlemoon/MusicScope-V2/blob/master/docs/screenshots/studio-local.jpg)

![六轨试听与导出界面，展示人声、鼓组、贝斯、吉他、钢琴和其他声音的独立波形](docs/screenshots/studio-mixer.jpg)

上图是完成分轨后的真实界面：每条音轨都能单独调音量、静音、独奏和下载。截图已避开私人曲名。

MusicScope 专注于一件事：从自己的音频文件，或网易云账号“我喜欢的音乐”中的**可播放歌曲**，直接生成同步的 **人声、鼓、贝斯、吉他、钢琴、其他** 六条音轨。界面围绕选曲、分离、试听和导出设计，不需要先经过推荐或数据洞察页面。

## 网易云扫码连接

在连接页点击“生成二维码”，用网易云音乐官方手机应用扫码并确认，然后只读同步资料库。MusicScope 不要求输入网易云密码。

![网易云账号扫码连接入口，展示生成二维码按钮和手机确认流程](docs/screenshots/netease-login.jpg)

[在 GitHub 打开扫码连接截图](https://github.com/sevenlemoon/MusicScope-V2/blob/master/docs/screenshots/netease-login.jpg)

这是登录前界面的演示截图；出于账号安全，文档不包含有效登录二维码或个人账号信息。

## 两种分轨入口

进入项目就是分轨页面，按音源选择一种入口。图片下方也提供了文字链接，方便图片未加载时查看。

### 1. 网易云账号选歌

扫码连接后，从资料库挑选当前账号可取得可播放音源的歌曲，直接在本机分轨。

![账号歌曲直接分轨：从资料库选取可播放歌曲](docs/screenshots/studio-account.jpg)

[在 GitHub 打开账号选歌截图](https://github.com/sevenlemoon/MusicScope-V2/blob/master/docs/screenshots/studio-account.jpg)

### 2. 独立导入本地文件

导入自己的 MP3、WAV、FLAC 或 M4A/AAC 音频，不需要登录账号。

![独立导入文件：选择本地音频开始六轨分离](docs/screenshots/studio-local.jpg)

[在 GitHub 打开本地导入截图](https://github.com/sevenlemoon/MusicScope-V2/blob/master/docs/screenshots/studio-local.jpg)

选歌与本地导入截图均裁去了最近任务，避免公开私人歌名。

## 为什么用它

- **两种入口**：拖入本地音频；或扫码连接网易云，从“我喜欢的音乐”选择歌曲。账号曲目只有在当前账号可取得可播放音源时才能分离。
- **六轨而非笼统的伴奏**：Demucs 将人声、鼓、贝斯、吉他、钢琴和其他声音分别导出为 FLAC；各轨保持同步。
- **边听边练**：逐轨调音量、静音或独奏，调速、循环、拖动波形；新任务还会在鼓轨节奏足够稳定时显示**估算 BPM 和节拍标记**。
- **本机优先**：音频处理、资料库和账号连接在本机运行；登录会话留在服务端，不交给浏览器。提供中英文界面。

资料库中的曲目来自“我喜欢的音乐”；歌单显示账号自己创建的，专辑显示账号明确收藏的，不会把所有喜欢歌曲涉及的专辑误算成收藏。资料库页可单独更新收藏专辑，无需重扫所有歌单。艺人仅作为曲目和专辑的署名信息显示，不提供独立分类；资料库也不推断播放次数。推荐、演唱会、Insights 和空白个人资料页已移除，项目围绕分轨与资料库维护。

## 在本机运行

| 平台 | 启动方式 | 必需软件 |
| --- | --- | --- |
| macOS（Apple silicon） | 双击 `MusicScope.command`，或运行 `./scripts/dev.sh` | Docker Desktop、[uv](https://docs.astral.sh/uv/)、Node.js 24.21.0+（24.x）；首次在仓库中运行 `nvm install` |
| Windows 10/11 x64 | 解压项目后双击 `MusicScope.cmd` | 可联网；无需 Docker、WSL2 或开启虚拟化，工具由脚本准备 |

### Windows：双击启动

1. 下载并完整解压项目，双击 `MusicScope.cmd`。
2. 首次启动自动准备 Node.js、uv、Python 3.12、FFmpeg/ffprobe、前后端依赖和音频引擎；资料库直接使用本地 SQLite 文件。
3. 等待终端显示 `APPLICATION READY`；浏览器会自动打开。以后仍然双击同一个文件，已安装的工具和前端依赖会复用。

无需预先安装 Node、Python、uv、FFmpeg，也无需手动修改 PATH。项目工具放在忽略的 `.tools/` 中并校验 SHA-256；FFmpeg 使用 [Gyan Windows essentials 构建](https://www.gyan.dev/ffmpeg/builds/)。网络中断会自动重试，失败后再次双击即可利用下载缓存继续依赖安装。安装细节记录在 `.logs/setup-windows.log`。

**首次系统条件：** Windows x64、网络连接和足够的磁盘空间（建议至少 10 GB）。默认启动不安装 Docker、不要求 WSL2、虚拟化、独立数据库或管理员权限。首次下载需要能访问 Node.js、GitHub、PyPI、npm 和 FFmpeg 下载服务。下载中断后保留进度，再次双击可续传。

**已有 Docker 资料库：** Windows 默认资料库保存在 `storage/library.sqlite3`，与旧 PostgreSQL 数据独立。旧 Docker 卷不会删除，也不会自动迁移；若要继续使用旧 Docker 数据库，请运行 `MusicScope.cmd -LegacyDocker`。默认模式会建立独立资料库，不代表旧资料丢失。

Windows 和 macOS 的启动器都会准备隔离的 Python 环境。Windows 默认初始化本地 SQLite，macOS 保留 PostgreSQL；旧 PostgreSQL 模式仍执行前向迁移。Demucs 模型在首次分轨时自动下载。长音频的 CPU 分离可能很慢；macOS 优先使用 MPS，Windows 在检测到可用 CUDA 时使用 CUDA，否则使用 CPU。可在本地 `.env` 中设置 `AUDIO_WORKER_DEVICE=cpu` 重试。

可选启动参数：macOS 为 `./scripts/dev.sh --status|--setup|--no-open`；Windows 为 `./scripts/dev.ps1 -Status|-Setup|-NoOpen`。状态模式只读取状态。关闭启动窗口会停止由该窗口启动的应用进程，资料保留。启动器不会自动同步网易云或删除资料库。

若双击被 Windows 安全提示拦截，可在 PowerShell 中从已检查的仓库目录启动 `./MusicScope.cmd`；不需要修改全局执行策略。更新已有安装时保留 `.env`、`.tools`、`storage` 和数据库卷，它们包含本地配置、工具缓存和工作资料。

## 技术结构

```text
Next.js / React / TypeScript
          → FastAPI / SQLAlchemy → SQLite（Windows 默认）/ PostgreSQL
          → 网易云连接服务（仅本机）
          → 独立 Python 音频 worker → Demucs → 六条 FLAC 音轨
```

本机 `.env` 会生成独一份数据库密码和加密密钥，且已被 Git 忽略。Windows 启动器会收紧该文件的 ACL；macOS 使用仅文件所有者可读写的权限。请勿提交或分享 `.env`、账号会话、分轨源文件和模型缓存。更多设计见 [架构](docs/ARCHITECTURE.md) 与 [领域模型](docs/DOMAIN_MODEL.md)。

## 验证与边界

macOS/Linux 开发验证：`make check`。GitHub Actions 运行 Linux 全量检查与 Windows 原生 Python、前端和启动器检查。Windows 自动化检查不能替代所有 Windows 硬件、声卡或 GPU 上的完整模型分离实测。

节拍/BPM 是从新分离任务的鼓轨**估算**，不是乐谱级精确转录；节奏证据不足时不会显示数字，旧任务也不会凭空补出节拍。分离结果可能有串音或伪影。账号选曲取决于该账号是否能取得合法可播放音源；请只处理自己有权使用的音乐。

MusicScope 当前仅支持**单机本地使用**：服务绑定 `127.0.0.1`，不应直接开放到局域网或公网。开发用的 `X-MusicScope-User-ID` 不是身份验证；共享部署需要重新设计认证、TLS 与安全边界。
