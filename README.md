# Arithmetic-Mahjong-Online

算术麻将网页联机版。这个私有仓库负责浏览器多人牌桌、朋友邀请和云端部署；原仓库继续维护可下载的单机游戏。

沿用现有网页与 FastAPI 后端，支持四人普通/血战牌局、房间密码、观战、结算与手动下一局。首阶段采用 **Docker + Render、单实例、单 Uvicorn worker**。牌局与临时身份保存在内存中，重启或重新部署后清空。

## 手牌整理与 Bot

所有未胡玩家在 t1～t4 都能拖动、分组和拆组，包括别人回合、已提交响应后，以及自己的吃牌选择阶段。整理不消耗动作、不刷新倒计时；暂停、托管和结算时禁用。手动吃牌高亮跟随实体牌，拖动不会替换已选择的同值牌。

房主在“房主设置”中选择“新增 Bot 策略”并点击“添加 Bot”，再安排四个座位即可开局。每房最多三位 Bot，支持一人配三 Bot、两位朋友配两 Bot，以及三位朋友配一 Bot。开局后锁定本局配置，安排下一局时可更换策略、移除 Bot 或换真人。

云端默认启用无需模型的九种策略：摸切、随机、先胡随机、数学、搜索，以及速胡、做大、稳守、牵制四种启发式风格。NN、RL、CFR 与抽象 CFR 需要额外训练模型，当前云端配置不加载这些模型，相关选项会禁用。血战可使用现有策略，但尚无血战专用训练。

多个房间共用一个有计算预算的 CPU Bot 子进程，按房间轮流调度，不占用额外 Web worker。纯真人房间不启动 Bot 进程。策略故障或计算超时会使用保底动作，不阻塞服务；房主可在下一局开局时重新准备进程。

## 本地开发

推荐 Python 3.13，在仓库根目录运行：

```powershell
py -3.13 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r multiplayer/requirements.txt
.\.venv\Scripts\python.exe -m multiplayer.web --port 8771
```

打开 <http://127.0.0.1:8771>。本地默认仅监听本机；独立浏览器窗口可以分别创建临时玩家。设置 `INVITE_CODE` 后，本地也可验收邀请入口。真人联机服务无需 Bot 模型、NumPy、Torch 或 GPU。

## 部署到 Render

已提供 [Dockerfile](Dockerfile)、[render.yaml](render.yaml) 和 [环境变量示例](.env.example)。

1. 提交并推送改动。在 Render 连接有权读取此私有仓库的 GitHub 账号，创建 Blueprint，选择本仓库的 `render.yaml`。
2. 检查创建预览：一个 Docker Web Service、`numInstances: 1`、`WEB_CONCURRENCY=1`、健康检查 `/healthz`。当前配置为 `0.5c-512mb` 付费计算方案，费用以创建页为准。
3. 首次部署自动读取平台的 `PORT` 和 `RENDER_EXTERNAL_URL`。`INVITE_CODE` 由平台生成，在控制台查看并私下发给朋友。
4. 朋友打开 HTTPS 网站，输入邀请码进入大厅，再凭房间名与房间密码加入同桌。
5. 自定义域名绑定并启用 HTTPS 后，设置 `PUBLIC_ORIGIN=https://你的域名`，重新部署。地址不能带路径或末尾 `/`。

提交触发的自动部署已关闭，避免打牌途中推送代码导致重启。字段按 [Render 文档](https://render.com/docs/blueprint-spec)配置。详细操作、Docker 启动和异地验收见 [云端部署与联机验收](design_docs/cloud_deployment.md)。**配置就绪不等于已上线；真实异地验收仍需部署后执行。**

## 云端配置

| 变量 | 默认值/用途 |
| --- | --- |
| `HOST` | 本地 `127.0.0.1`；检测到平台端口或 Render 地址时为 `0.0.0.0` |
| `PORT` | 本地 `8771`；云端读取平台端口 |
| `PUBLIC_ORIGIN` | 正式网站精确 HTTPS 来源；未设置时使用 `RENDER_EXTERNAL_URL` |
| `INVITE_CODE` | 16～128 字符站点邀请码，公网必须配置 |
| `WEB_CONCURRENCY` | 必须为 `1`，内存房间尚未跨进程共享 |
| `DISCONNECT_SECONDS` | `10`，最后连接消失后的交接容错 |
| `GRACE_SECONDS` | `300`，非房主每席每局累计重连宽限 |
| `SESSION_TTL_SECONDS` | `3600`，离线身份与全员离线房间保留时间，至少覆盖断线容错与重连宽限之和 |

命令行 `--host`、`--port`、`--public-origin` 等覆盖对应环境变量。程序不会自动读取 `.env` 文件。缺少正式来源、缺少邀请码、非法端口或配置多个 worker 时，公网启动报错退出。

## 邀请、身份与断线

- 邀请码控制站点进入权限，房间名和密码控制加入哪一桌。邀请码经同源 HTTPS 提交，不放在链接里，也不保存到浏览器中。
- 随机临时凭证存于当前标签页的 `sessionStorage`，刷新可重连；关窗口、清数据或换设备后不保证认回原席。当前没有实名账户或跨设备找回，邀请码持有者可以创建多个临时玩家。
- 未连接的大厅身份、离线观众和局间成员到期回收；在线 WebSocket 身份持续有效。正在对局的离线席位保留原凭证，支持原玩家回来查看托管状态；本局结束后正常回收。
- 普通参赛者掉线全桌暂停，宽限耗尽后只过牌、摸切；本局回来仍托管，下一局可恢复真人。房主个人掉线关闭房间；全员同时断链先保护暂停，超过保留时间后关闭回收。
- 游戏 API 校验精确 Host/Origin 和身份，不信任转发身份头。匿名 `/healthz` 允许平台内部探测；tick 线程异常或停滞时返回 503。
- 轮换邀请码需重新部署，当前内存身份随重启失效。每次部署应安排在牌局结束后。

## 验证

自动化测试脚本与开发测试依赖仅在本地保留，不随部署源码上传。部署后请按 [真实异地验收步骤](design_docs/cloud_deployment.md#真实异地验收) 检查邀请、入房、四席开局、操作同步和断线重连。本地接口测试不能替代真实浏览器与异地网络验收。

## 代码与设计

- [网页与 API](multiplayer/web.py)、[启动配置](multiplayer/hosting.py)、[断线与身份运行层](multiplayer/runtime.py)。
- [联机设计](design_docs/multiplayer_design.md)、[血战规则](design_docs/blood_battle_design.md)。
- [早期电脑开服设计](design_docs/hosting_design.md)保留为历史背景；当前部署以本 README 和云端部署文档为准。
- 原有独立 Bot 试玩入口保留；云端房间支持朋友与 Bot 混合入座，不运行训练任务。
