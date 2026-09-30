# MusicScope Windows 桌面预览版

下载 `MusicScope-0.1.0-beta.1-windows-x64.zip`，完整解压后打开 `MusicScope.exe`。不要下载下面自动生成的 Source code 作为应用安装包。

分轨界面直接显示在应用窗口中，支持本地音频导入、网易云账号连接与选歌、六轨分离、独奏/静音、混音试听和导出。

- 无需 Docker、WSL2、虚拟化设置或独立数据库，资料库使用本地 SQLite。
- 首次启动自动联网准备 Node、Python、FFmpeg 和音频引擎，窗口显示进度；模型首次分轨时下载。这不是全离线安装包。
- 数据保存在 `%APPDATA%/MusicScope/workspace`，更新或重新解压应用时请保留该目录。已有源码版或 Docker 资料不会自动迁入。
- 下载中断可重新打开应用续传。Windows x64 建议预留至少 10 GB 空间。

验证范围：Linux 回归、Windows 依赖准备、首次与重复启动、API/后台工作进程/页面就绪，以及打包后的桌面应用加载分轨页。尚未覆盖每种 Windows 硬件或 GPU 的真实分轨实测。本预览版没有 MusicScope 自有代码签名证书。

关闭应用会停止它启动的处理服务，请等待分轨任务结束后退出。仅处理自己拥有使用权的音频；账号歌曲能否导入取决于账号的播放权限。

![Windows 桌面应用启动实测](https://github.com/sevenlemoon/MusicScope-V2/releases/download/v0.1.0-beta.1/desktop-preview.png)
