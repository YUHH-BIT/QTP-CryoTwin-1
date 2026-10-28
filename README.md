# 青藏高原冰冻圈灾害数字孪生系统（Cryo-floods）

基于 Flask + OpenLayers 的 WebGIS 数字孪生系统，面向青藏高原冰冻圈灾害（洪水、融雪、冰川、冻土）的**数据库管理、灾害过程模拟、风险评估与决策支持**。

## 功能模块

| 页面 | 文件 | 说明 |
| --- | --- | --- |
| 首页地图 | `index.html` | 多图层可视化：流域、河流、湖泊、冰川、冻土、铁路/公路、居民地、行政界线、能源站点、水坝、水库、GDP 等 |
| 灾害数据查询 | `query.html` | 冰冻圈灾害事件（降雨型洪水 PFs / 融雪型洪水 SFs / 冰湖溃决 GLOFs / 滑坡堰塞湖 LLOFs / 冰川跃动 / 热融滑塌 RTS / 风吹雪 / 雪崩）浏览、缓冲分析 |
| 模拟预测 | `simulate.html` | LSTM 径流模拟（/api/simulate/runoff）、洪水淹没分析（/api/simulate/flood-inundation）、融雪洪水识别（/api/snowmelt/identify），支持导出淹没统计CSV与结果GeoTIFF |
| 风险评估 | `alert.html` | 栅格像元级洪水风险评估 R = 危险性 × 暴露度 × 脆弱性（/api/alert/risk_assessment），输出 5 级分级 GeoTIFF，支持导出统计CSV / 下载GeoTIFF / 保存图表PNG |
| 决策支持 | `decision.html` | 决策支持智能体（/api/llm/chat，SSE 流式，**检索增强**：回答自动引用系统真实灾害案例/县域数据/方法学并标注 [数据源]）+ **院士专家名录**（/api/expert/profiles）+ **防灾实例 / 工程措施 / 非工程措施**（/api/decision/content），密钥仅存后端 |
| 三维地形 | `terrain3d.html` | **雅鲁藏布江流域三维地形**（Three.js 引擎）：按流域边界裁剪的立体地形块 + 贴合地形的边界线；Terrarium 公开高程 + 三维卫星影像 / 地形明暗图双贴图，可垂直夸张、切贴图、自动旋转；数据由 `scripts/build_terrain_page.py --basin 雅鲁藏布江 --region-id yarlung --zoom 10 --mesh 700` 生成（4.4MB），渲染完全本地。入口：各页「决策支持」下拉第一项「三维示范区」 |
| 系统管理 | `admin.html` | 用户 / 角色 / 权限 CRUD、操作日志与图表统计、系统状态、数据文件管理（阈值/模型/上传数据）、决策智能体提示词设置，需登录 |

## 技术栈

- 后端：Flask（蓝图 + 会话认证）、SQLite（`admin.db` 用户/角色/日志；`TibetanPlateau_index.db` / `era5_index.db` 数据索引）
- 计算：rasterio / geopandas / shapely / scipy / numpy / torch（LSTM）/ matplotlib（出图与 GIF）
- 前端：原生 HTML/JS/CSS，OpenLayers / ECharts / Font Awesome / Google Fonts 均本地托管（js/lib、css/lib、css/fonts），可离线运行（在线高德底图瓦片除外）；三维示范区用 Cesium 1.146（`webgis_frontend/cesium/` 自托管，quantized-mesh 地形瓦片本地生成）
- 外部服务：高德地理编码 API（`/modules/geocode`）、DeepSeek API（决策智能体）

## 快速开始

1. 准备 Python 3.10+，创建虚拟环境并安装依赖：

   ```bash
   python -m venv .venv
   .venv\Scripts\activate          # Windows
   pip install -r requirements.txt
   ```

2. 配置环境变量：复制 `.env.example` 为 `.env`，填写 `SECRET_KEY`、`AMAP_KEY`、`DEEPSEEK_API_KEY` 与三个内置账号密码（admin/operator/viewer）。

3. 启动：

   ```bash
   # 方式一：脚本一键启动（自动选用 venv 或系统 python）
   powershell -ExecutionPolicy Bypass -File .\run.ps1
   # 方式二：直接运行
   python webgis_backend\app.py
   ```

4. 浏览器访问 <http://127.0.0.1:5000/>。系统管理页 <http://127.0.0.1:5000/admin.html> 需登录。

> 生产部署建议使用 `waitress`（Windows）或 `gunicorn`（Linux）托管，并通过反向代理启用 HTTPS；`FLASK_CONFIG=production` 切换生产配置。

## 换机器运行（硬盘随身版）

Python 运行时内嵌在项目目录内（`.runtime/`），因此**整块硬盘插到任意一台 Windows 电脑上都能直接跑**，
不要求目标机器装过 Python，盘符从 `F:` 变成 `G:`/`E:` 也不影响。

```powershell
# 1. 体检：一次性确认运行时 / 依赖 / 数据 / 写入权限
powershell -ExecutionPolicy Bypass -File .\diagnose.ps1

# 2. 启动（也可直接双击 run.bat）
powershell -ExecutionPolicy Bypass -File .\run.ps1
```

浏览器会自动打开 <http://127.0.0.1:5000/>。端口被占用时换端口：`.\run.ps1 -Port 5001`。

### 为什么换机器就能用

| 部件 | 换机后 | 说明 |
| --- | --- | --- |
| 源码 / 前端 / 文档 | 可用 | 全部基于 `BASE_DIR` 相对解析，无绝对路径 |
| `data/`（83GB） | 可用 | 跟着硬盘走，未入库 |
| `.env` 密钥 | 可用 | 在硬盘上，且未入库 |
| Python 运行时 | 可用 | 内嵌在 `.runtime/`，`sys.prefix` 由 exe 位置推导 |

> 原先使用 `.venv`，其 `pyvenv.cfg` 把母解释器钉死在
> `C:\Users\<用户名>\AppData\Local\Programs\Python\Python312`，
> 换一台电脑该路径即失效，整个虚拟环境报废。
> 现改为内嵌运行时；旧环境保留为 `.venv.old/`，确认新环境无误后可自行删除（省 1.9GB）。

### 运行时损坏时如何重建

```powershell
# 联网：重新下载安装锁定依赖
powershell -ExecutionPolicy Bypass -File .\scripts\setup_runtime.ps1

# 离线：从旧虚拟环境原样复制（要求 Python 版本一致，脚本会自动核对）
python scripts\build_runtime.py --skip-core --from-venv .venv.old
```

### 依赖文件说明

- `requirements.txt` —— 松散下界（`>=`），用于语义声明
- `requirements.lock.txt` —— **精确锁定的 58 个包**，换机重建时用这个，避免装出另一套版本

## 目录结构

```
Cryo-floods/
├── webgis_backend/            # Flask 后端
│   ├── app.py                 # 入口：蓝图注册、页面/静态资源路由、统一错误处理
│   ├── config.py              # 配置（密钥/路径/账号均从 .env 读取）
│   ├── requirements.txt       # 后端依赖
│   ├── modules/
│   │   ├── auth.py            # 登录 / 登出 / 登录保护
│   │   ├── admin.py           # 系统管理 API（用户/角色/权限/日志）
│   │   ├── admin_db.py        # 系统管理 SQLite（建表/种子/CRUD）
│   │   ├── basin.py           # 流域/河湖/边界/居民地等 GeoJSON 图层
│   │   ├── data_query.py      # ERA5 索引查询与 TIF 服务
│   │   ├── simulate.py        # LSTM 径流模拟 / 洪水淹没 / 动画
│   │   ├── snowmelt_flood.py  # 融雪洪水识别
│   │   ├── alert.py           # 洪水径流 / 动画 / 风险评估
│   │   ├── economy.py         # GDP / 能源 / 水坝 / 水库数据
│   │   ├── disaster.py        # 冰冻圈灾害事件数据
│   │   ├── llm.py             # DeepSeek 决策智能体（SSE，检索增强 RAG）
│   │   ├── expert_kb.py       # 智能体真实数据知识库（构建与检索，RAG 数据层）
│   │   ├── expert.py          # 院士专家名录（公开资料档案 / 领域检索 / 单位联系方式）
│   │   ├── decision.py        # 决策支持内容（防灾实例 / 工程措施 / 非工程措施）
│   │   ├── geocode.py         # 地理编码
│   │   ├── system.py          # 系统状态
│   │   └── utils.py           # 公共工具（缓存 / 路径安全校验）
├── webgis_frontend/           # 前端（Flask 直接托管）
│   ├── *.html                 # index / query / simulate / alert / decision / admin / login
│   ├── cesium/                # Cesium 1.146 Build（三维示范区自托管引擎，Apache-2.0）
│   ├── js/                    # main / query / simulate / alert / decision / admin / login / geotiff / scene3d / ui-components
│   └── css/                   # styles.css / components.css
├── docs/                      # 项目文档（分层编号，见下）
│   ├── 01_技术思路/           # 00 总览索引 + 首页 / 灾害库 / 过程模拟 / 风险评估 / 决策支持 / 系统管理 / 三维示范区建设方案
│   ├── 02_模块技术说明/       # 洪水风险评估 / 专家咨询 / 决策支持内容
│   ├── 03_评估与汇报/         # 经济数据方案 / 数据缺口对照 / 工作汇报 / 径流优化审查
│   ├── 04_论文与规划/         # 论文架构设计文档
│   ├── 05_前端审查/           # 前端交互与视觉优化审查清单
│   └── 06_运维/               # SSH 配置说明
├── scripts/                   # 独立维护脚本（非后端运行时依赖，路径均按项目根解析）
│   ├── preprocess_economy.py      # 经济数据 xlsx → 系统规范 CSV / JSON
│   ├── preprocess_osm_landuse.py  # OSM landuse → 多波段权重掩膜 GeoTIFF
│   ├── build_3d_tiles.py          # 三维瓦片生成：DEM 填洞 / quantized-mesh 地形瓦片 / 矢量简化 / 影像缓存
│   └── benchmark/             # 性能基准脚本
│       ├── bench_runoff_speed.py  # 径流模拟端到端耗时基线
│       └── bench_before_after.py  # 新旧实现实测对比
├── data/                      # 数据区 82GB（gitignore，仅交付物例外入库）
│   ├── raw/                    # 原始输入（80GB）
│   │   ├── TibetanPlateau/    # ERA5 气象强迫：4 变量 × 逐日 GeoTIFF（67GB，占大头）
│   │   ├── GLDAS025_Snowmelt/ # GLDAS 逐日融雪（6.3GB，50406 个文件，勿递归遍历）
│   │   ├── socioeconomy/      # 青藏高原社会经济原始资料（3.0GB）
│   │   ├── dem/ thresholds/ models/
│   │   └── geo/               # 矢量底图，按语义分 8 个子目录（2026-09-07 起）
│   │       ├── disaster/      # 8 类冰冻圈灾害（与 config.DISASTER_TYPES 一一对应）
│   │       ├── boundary/      # 行政边界 / 研究区总边界
│   │       ├── hydrology/     # 流域 / 河网 / 湖泊
│   │       ├── cryosphere/    # 冰川 / 多年冻土
│   │       ├── infrastructure/# 水坝 / 水库 / 电厂 / 公路 / 铁路
│   │       ├── settlement/    # 居民地
│   │       ├── station/       # 气象 / 水文台站
│   │       └── socioeconomic/ # 县域边界
│   ├── processed/             # 中间成果（2.5GB）
│   │   ├── economy/           # 县域人口/耕地/粮食/牲畜派生 CSV
│   │   ├── db/ dem/ geo/ GLDAS_snowmelt_max/
│   │   └── 3d/                # 三维示范区数据区（scripts/build_3d_tiles.py 生成）
│   │       ├── regions.json   #   区域注册表（新增区域只加记录，前后端零改动）
│   │       ├── dem_filled.tif #   DEM 空洞全域确定性填充产物
│   │       └── tp_full/       #   全域区域：terrain/（quantized-mesh 瓦片+layer.json）、vectors/（简化矢量）
│   └── webgis/                # WebGIS 子系统数据区（路径常量见 config.py）
│       ├── content/           # 业务内容数据：决策知识库 / 专家名录 JSON（入库）
│       ├── uploads/           # 用户上传的经济数据（入库）
│       └── outputs/           # 运行产物：runoff_results / flood_inundation / risk_results
│                              #           / masks / pngs / animations（不入库，可再生）
├── Training/                  # 模型训练与数据预处理脚本
├── tests/                     # 自动化冒烟测试（python tests/smoke_test.py）
├── run.ps1 / run.bat          # 一键启动脚本
└── requirements.txt           # 项目依赖（与后端一致）
```

> `scripts/` 下的脚本用 `__file__` 回退定位项目根，因此可在任意工作目录下直接运行；
> 若调整脚本所在目录层级，需同步修改其中的根目录回退层数。

## 测试

```bash
# 自动化冒烟测试：验证核心 API 与知识库（无需启动服务，使用 Flask test client）
python tests/smoke_test.py

# pytest 套件（含三维示范区回归测试：瓦片网格契约 / 编解码往返 / 接缝连续性 / 路由安全）
python -m pytest tests/ -q
```

覆盖：健康检查 / 专家名录 / 决策内容 / 灾害库 / 图层路由 / LLM 状态 / 登录鉴权 / 知识库构建与 RAG 检索。退出码 0 表示全部通过。

## 主要 API 一览

- 认证：`POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/auth/me`
- 图层数据：`/api/basin/*`（data/search/river/permafrost/glaciers/cma/weather_station/railway/road/settlement/city_settlement/capital_settlement/boundary_*/lake）、`/api/disaster/<type>`、`/api/economy/*`
- 查询：`/api/query/variables`、`/api/query/list`、`/api/query/tif/<path>`
- 模拟：`/api/simulate/models`、`/api/simulate/runoff`、`/api/simulate/flood-inundation`、`/api/simulate/flood/thresholds`
- 融雪：`/api/snowmelt/identify`、`/api/snowmelt/result/<file>`
- 风险：`/api/alert/risk_assessment`
- 智能体：`/api/llm/chat`（SSE，检索增强：自动注入系统真实数据并要求 [数据源] 标注）、`/api/llm/health`
- 专家名录：`/api/expert/profiles`（支持 `?field=` 领域筛选、`?q=` 搜索）、`/api/expert/fields`（领域分类）
- 决策内容：`/api/decision/content`（防灾实例 10 例 / 工程措施 20 条 / 非工程措施 12 条，含来源）
- 三维示范区：`/api/3d/regions`、`/api/3d/regions/<id>`；地形瓦片 `/tiles3d/<region>/terrain/layer.json` 与 `/tiles3d/<region>/terrain/<z>/<x>/<y>.terrain`（quantized-mesh，TMS 网格 2^(z+1)×2^z）；矢量 `/tiles3d/<region>/vectors/<name>.geojson`；引擎静态资源 `/cesium/*`
- 系统：`/api/system/status`、`/api/health`；管理：`/api/admin/*`（需登录+权限）

## 已知边界与后续规划

- 动画/路径规划/应急资源调度等决策支持功能为“构想/待完善”状态（详见 `docs/04_论文与规划/青藏高原冰冻圈灾害数字孪生系统构建.md`）。
- 三维示范区（决策支持 → 三维示范区页签）：全域地形 z0–z12 已本地化，影像为高德在线瓦片（需联网；断网时地形/矢量仍可用）。DEM 为 SRT 源（约90m），含空洞回填痕迹，陡峰高程偏低；掩膜外远场为常量填充的平缓地形。三维数据一次性生成命令见 `docs/01_技术思路/07_三维示范区建设方案.md`。
- 已有自动化冒烟测试（`tests/smoke_test.py`）与 pytest 套件（`tests/test_scene3d.py` 等），尚未接入 CI；风险评估与模拟为同步计算，长时段任务会阻塞请求线程，建议后续引入任务队列与进度轮询。
- 前端库/字体已本地化，离线可用；地图底图瓦片仍走高德在线服务，完全离线需另配本地瓦片服务或预缓存。