# MusicScope Windows 0.1.0-beta.2

下载 `MusicScope-0.1.0-beta.2-windows-x64.zip`，完整解压后打开
`MusicScope.exe`。不要下载自动生成的 Source code 作为 Windows 应用。

- 内置 Python、Node、FFmpeg 和生产界面。普通启动无需安装开发依赖、Docker 或 WSL。
- 首次分轨需要联网准备模型；下载有独立超时、校验和断点重试。准备完成后使用本地模型。
- 资料仍保存在 `%APPDATA%/MusicScope/workspace`，更新时保留该目录。
- 修复播放结束后的按钮状态，以及首次播放前设置的静音、独奏和增益。
- 退出有确认提示；本地文件分轨不依赖网易云连接服务成功启动。

自动验收覆盖中文安装路径、两次启动、真实 CPU 六轨处理、断网后新任务、
已完成任务的播放器进度和结束状态。测试使用生成信号，不代表音乐听感、
真实声卡或所有 Windows/GPU 配置都已验证。模型首次准备仍需网络，
本版本不是完全离线安装包；MusicScope 尚无自己的代码签名。
