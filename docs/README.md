# 项目文档索引

当前产品是本地六轨分离工作室，入口包括音频导入、网易云连接、资料库集合、播放器和混音导出。

- [项目说明与启动](../README.md)
- [架构与模块边界](ARCHITECTURE.md)
- [领域模型](DOMAIN_MODEL.md)：包含为已有数据库保留的历史表
- [桌面交付](DESKTOP_DELIVERY.md) 与 [发布记录](releases/desktop-0.1.0-beta.1.md)
- [界面截图来源](README_SHOWCASE.md)
- [本轮代码审查与验证](validation/project-review-2026-10-21.md)

`R0_*`、`R1_*`、`R4_*`、`RECOMMENDATIONS.md`、`LIVE_CONCERTS.md`、`GRADUATION_DEMO.md` 和 `DEFENSE_GUIDE.md` 是历史里程碑或设计记录，不构成当前功能承诺。推荐、演出和 Insights 的数据库迁移及已有数据继续保留。

本次检查前的本地截图、录像、日志、进度记录和临时探针已完整移到忽略目录 `.local/review-history/20261021/`，原相对目录保留在其中。部分材料依赖个人账号、硬编码端口和本机工具路径，不能作为可移植测试，也不随源码发布。仓库内 `docs/validation` 仅保留经过筛选的交付证据；自动化验证优先使用 `make check`、`make worker-check` 和独立桌面启动器检查。
