# README 实机预览与设计记录

## 截图来源

截图日期：2026-10-21（Asia/Shanghai）。图片通过 Chrome 实际运行的 `http://127.0.0.1:3100` 前台拍摄，未使用设计稿、合成界面或模拟 API 数据。

拍摄工作区基于 `codex/windows-bundled-runtime` 的 `92caf1d`，并包含当时尚未提交的播放器、歌词、频谱、资料库与工作台界面改动。因此这些截图展示开发进度，不代表 `master` 或 `v0.1.0-beta.1` 已包含全部界面与能力。此次文档更新没有合并这些功能改动，也没有发布新的桌面安装包。

| 文件 | 实际页面与拍摄状态 |
| --- | --- |
| [studio-mixer.jpg](screenshots/readme/studio-mixer.jpg) | 已完成的六轨任务；实际播放时拍摄，六条时间波形、混音频谱、增益、独奏、静音与 FLAC 入口均可见。 |
| [studio-import.jpg](screenshots/readme/studio-import.jpg) | `/studio` 本地音频导入入口，包含已有最近任务。 |
| [library.jpg](screenshots/readme/library.jpg) | `/library` 已同步的真实歌曲列表，包含搜索、排序、播放和分轨入口。 |
| [player.jpg](screenshots/readme/player.jpg) | 实际播放的展开播放器，展示封面、纯音乐歌词状态与实时 FFT 频谱。 |

截图仅展示界面，不分发源音频或分轨文件；未包含登录二维码、Cookie、密钥或个人联系方式。图中歌曲、专辑封面与艺人署名属于对应权利人。

本轮检查确认本地 API 和数据库健康端点返回 `ok`，现有六轨任务可进入播放状态，播放器可进入播放并显示频谱。拍摄后已暂停播放。本轮没有重新运行模型分离，也没有执行全量代码测试；这是文档与图片更新。

## 参考项目

2026-10-21 查阅以下项目的公开 README，并通过 GitHub API 读取 Star 数。数字是当时快照，不会自动更新。

| 项目 | 当日 Star | 本次采用的文档组织思路 |
| --- | ---: | --- |
| [Nuclear](https://github.com/nukeop/nuclear) | 18,749 | 用实机截图先展示产品，将下载、功能与开发入口分别组织。 |
| [Ultimate Vocal Remover GUI](https://github.com/Anjok07/ultimatevocalremovergui) | 26,710 | 将各平台安装方式、首次环境准备和使用条件写清楚。 |
| [RSSHub](https://github.com/DIYgod/RSSHub) | 46,599 | 使用简短定位、轻量徽章和直接的文档、反馈导航。 |

本次仅参考信息层级与阅读路径，没有复制这些项目的图片、品牌资产或产品承诺。MusicScope README 的截图、功能和启动要求均来自自身工作区、默认分支代码与已发布版本。
