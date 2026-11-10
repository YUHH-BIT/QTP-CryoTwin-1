# 三维示范区旧版整包归档（2026-11-10）

## 为什么归档

主系统「决策支持 → 三维示范区」（`webgis_frontend/terrain3d.html`）已按用户要求
替换为吉隆「8·26」灾害链演示页（iframe 内嵌，系统导航区保持不变）。
本目录把替换前的全部内容**复制**一份单独存放，方便以后恢复或复用。
**原位置没有删除任何文件**；归档目录按用户要求纳入 git。

## 目录内容

| 路径 | 说明 | 体积 |
|---|---|---|
| `terrain3d.original.html` | 替换前的完整页面（1451 行 / 65.7 KB，v4 Three.js 单块地形版） | 66 KB |
| `terrain3d/himalaya/` | **喜马拉雅 · 珠峰段专属**：`meta.json`（含珠峰 8848.9 等 5 座 8000m 山峰）、`height.bin`、`texture.jpg`、`texture_hillshade.jpg` | 6.4 MB |
| `terrain3d/yarlung/` | 雅鲁藏布江流域（**替换前的默认区域**） | 7.4 MB |
| `terrain3d/gyirong/` | 吉隆区域 | 4.7 MB |
| `terrain3d/gyirong_corridor/` | 吉隆走廊高分辨率数据 | 15 MB |
| `himalaya_cesium_tiles_z10/` | 早期 Cesium 方案的喜马拉雅 z10 影像瓦片（144 张 png）。原路径为 `data/processed/3d/himalaya/`，因 `.gitignore` 的 `data/` 规则在此改名存放 | 6.4 MB |
| `related/` | 含喜马拉雅片段的**共用**文件副本，见下节 | — |

## 重要事实：默认区域不是喜马拉雅

替换前页面的默认区域是 **雅鲁藏布江 `yarlung`**：
`terrain3d.html:420` 的 `REGION = URLSearchParams(...).get('region') || 'yarlung'`。
喜马拉雅是 v3 遗留的矩形试验区，需要 `?region=himalaya` 才加载，
页面代码里没有「喜马拉雅」四个字。因此本次归档把**四个区域整包**都收进来，
而不是只收 himalaya 目录。

## 共用文件里的喜马拉雅片段（不要整文件覆盖回去）

这些文件同时服务其它模块，归档里是**副本**，恢复时只取片段：

- `related/scene3d.js`（v2 Cesium 全域遗留，当前无 html 引用）
  - 第 220 行：注释「子区域（如喜马拉雅）数据本身就是裁好的」
  - 第 296–298 行：`CAMERA_PRESETS.himalaya = { lon: 86.9, lat: 28.05, height: 320000, pitch: -45, heading: 20 }`
  - 第 523–524 行：`scene3d-cam-himalaya` 按钮绑定 `flyToPreset`
- `related/build_terrain_page.py`（多区域数据生成脚本）
  - 第 13 行：`--place himalaya` 用法
  - 第 47–56 行：`PLACES['himalaya'] = {'name':'喜马拉雅 · 珠峰段','bbox':(85.5,27.2,88.5,29.2)}`
  - 第 59–66 行：`PEAKS` 六座山峰（含卓木拉日）
  - 第 695 行：`--place` 默认值 `himalaya`
- `related/07_三维示范区建设方案.md`（历史技术文档）
  - 第 7 行 v3 喜马拉雅矩形试验区；104、122 行 DEM 空洞率与珠峰削平
  - 第 165 行「默认区域 yarlung，可用 `?region=himalaya` 切回」
  - 216 行 `--place` 默认 himalaya；259–260 行珠峰不在流域内

## 未归档（共用/无关，原地保留）

`webgis_backend/modules/expert_kb.py:609` 地名关键词列表、
`docs/02_模块技术说明/03_决策支持内容模块技术说明.md:29` 尼泊尔冰湖范例、
`webgis_frontend/terrain3d/yarlung/disasters.json` 里的 `HMA` 缩写（数据源名）、
`data/processed/3d/regions.json`（未注册 himalaya）、
`webgis_frontend/css/styles.css:4906–5064` 的 `.scene3d-*` 类（Cesium 通用样式，无喜马拉雅专属类）。

## 如何恢复旧页面

1. 把 `terrain3d.original.html` 复制回 `webgis_frontend/terrain3d.html`；
2. `terrain3d/` 四个区域数据仍在 `webgis_frontend/terrain3d/` 原位置（本次没有删除），
   若曾清理过，则从本目录的 `terrain3d/` 复制回去；
3. 后端路由 `/terrain3d.html` 与 `/terrain3d/<path:filename>` 未改动，无需改后端；
4. `?region=himalaya` 即可回到喜马拉雅试验区。

## 后端接口备注（替换前/后均不受影响）

`/api/3d/*` 与 `/tiles3d/*` 只服务遗留的 `js/scene3d.js` Cesium 方案；
替换前的 `terrain3d.html` 是纯静态页，只 fetch `/terrain3d/<region>/...`。
本次替换没有改动 `webgis_backend/app.py` 的任何路由。
