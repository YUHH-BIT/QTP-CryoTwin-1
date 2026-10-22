# 洪水危险性评估通用流程（四步）

一套可独立运行的通用代码，把**径流生成 → 阈值生成 → 危险性生成 → 危险性验证**拆成四个步骤，
各自独立可跑。已配置为本项目（E:\QTP‑CryoTwin）的实际目录与文件命名；
发给他人时修改 `config.py` 里的路径与参数即可复用到你自己的研究区。



```
flood\_workflow/

├── config.py               统一配置（路径、阈值分位、容差…）

├── step1\_runoff.py         1) 径流生成：气象驱动 + LSTM → 逐日径流 tif

├── step2\_threshold.py      2) 阈值栅格生成：多年 runoff → 逐像元分位数

├── step3\_hazard.py         3) 危险性生成：runoff + 阈值栅格 → 时段危险性 1–5 级 tif

├── step4\_validation.py     4) 危险性验证：历史洪水点位 → 命中率（文本）+ 空间分布图

├── requirements.txt        依赖

└── README.md
```



***

## 1. 环境准备



```
\# Python 3.10+，然后：

pip install -r requirements.txt
```

> `torch`
>
>  只在步骤 1（径流生成）用到；如果你已有径流结果，可不安装 torch，
> 直接跑步骤 2、3、4。

## 2. 数据准备

按下面的目录结构放好数据（路径在 `config.py` 中修改）：



```
气象驱动（步骤 1 输入）            METEOR\_DIR/{变量}/{变量名}\_{YYYY-MM-DD}.tif

&#x20; ├── temperature\_2m\_2024-01-01.tif

&#x20; ├── temperature\_2m\_max\_2024-01-01.tif

&#x20; ├── total\_precipitation\_max\_2024-01-01.tif

&#x20; └── total\_precipitation\_sum\_2024-01-01.tif

LSTM 模型权重                     LSTM\_MODEL（.pt）

径流输出/输入目录                  RUNOFF\_DIR/    {YYYY-MM-DD}\_runoff.tif

阈值输出/输入目录（步骤 2 输出、步骤 3 输入）  THRESHOLD\_DIR/ grid\_threshold\_{p}p.tif

研究区边界（可选）                 REGION\_BOUNDARY（GeoJSON/SHP，与栅格同 CRS 或可投影）

历史洪水点位（步骤 4 输入）        POINTS\_FILE（SHP 用几何坐标；CSV 需 lon/lat 列）
```



* **阈值栅格**：由步骤 2（step2\_threshold.py）用多年逐日 runoff 逐像元分位数生成
  （10/50/90/95/99p），与径流同量纲、同网格。已有现成阈值文件时可跳过步骤 2。

* **点位数据**：SHP 优先用几何坐标（即使属性表 lon/lat 为 0 也能正确读取）；

  CSV 需要 `lon`、`lat` 两列（度）。

* **径流生成（步骤 1）与项目 predict.py 同语义**：每个像元取区间内全部日期 T 天的
  4 变量时间序列 [T, 4] 一次过两层 LSTM（时间状态在 T 天内传递），输出 T 天径流；
  逐日写盘时做 `max-(x-min)` 数值方向修正（predict.py 行为，`--flip` 默认开）。
  驱动命名自动识别 `{变量名}_{YYYY-MM-DD}.tif`（也兼容 `{YYYYMMDD}`、`{YYYY_MMDD}`）。
  执行方式为行块流式 + 像元分批（`--block_rows` / `--batch` 可调内存），
  语义与 predict.py 完全一致，但可跑全青藏高原。全区域一年约数小时（predict.py 同量级）。

## 3. 运行



```
\# 步骤 1：径流生成（已有径流结果可跳过；时间必填）

python step1\_runoff.py --start 2024-01-01 --end 2024-12-31

\# 步骤 2：阈值栅格生成（已有阈值文件可跳过；时间必填，选历史年份）

python step2\_threshold.py --start 2004-01-01 --end 2023-12-31

\# 步骤 3：危险性生成（时间必填）

python step3\_hazard.py --start 2024-01-01 --end 2024-12-31 --p 99

\# 步骤 4：危险性验证（时间必填）

python step4\_validation.py --hazard \<step3 输出的 tif 路径> --points <点位文件> --start 2024-01-01 --end 2024-12-31 --radius 1

\# 步骤 4 完整示例（点位按年份筛选 + 研究区边界过滤；时间必填；路径为本项目实际目录）

python step4\_validation.py \\

&#x20;   \--hazard E:/QTP‑CryoTwin/data/webgis/outputs/risk\_results/2024-01-01\_to\_2024-12-31\_basin-all\_hazard.tif \\

&#x20;   \--points E:/QTP‑CryoTwin/docs/历史洪水点位数据集/2004\_2025/2004\_2025.shp \\

&#x20;   \--start 2024-01-01 --end 2024-12-31 \\

&#x20;   \--year 2024 --radius 1 \\

&#x20;   \--boundary E:/QTP‑CryoTwin/data/raw/geo/boundary/TP\_China.geojson
```

四个步骤相互独立：你可以只跑验证（用自己的 hazard tif + 点位），

也可以只跑危险性生成（用已有 runoff 与阈值）。

### 常用参数（除时间外均有默认值；时间必须每次由 --start/--end 指定）



| 参数                  | 说明                                 | 默认          |
| ------------------- | ---------------------------------- | ----------- |
| `--start / --end`   | 起止日期（YYYY-MM-DD）                   | **必填，由自己选择** |
| `--quantiles`（step2）| 要生成的分位数（逗号分隔）                    | 10,50,90,95,99 |
| `--p`（step3）        | 阈值分位                               | 99          |
| `--radius`（step4）   | 位置容差 km（0 = 精确像元）                  | 1.0         |
| `--hazard`（step4）   | 危险性 tif 路径（不填自动找 step3 输出）         | 自动          |
| `--csv`（step4）      | 改用 CSV 点位（配 `--lon_col/--lat_col`） | SHP         |
| `--year`（step4）     | 只检验该年份的点位（自动识别日期列筛选）               | 全部          |
| `--boundary`（step4） | 研究区边界（GeoJSON/SHP，只保留边界内点位）        | 不过滤         |

## 4. 输出



| 步骤 | 输出                                          | 说明                                             |
| -- | ------------------------------------------- | ---------------------------------------------- |
| 1  | `{YYYY-MM-DD}_runoff.tif`                   | 逐日径流，float32，与参考影像同网格                          |
| 2  | `grid_threshold_{p}p.tif`                   | 逐像元分位数阈值（float32，与 runoff 同网格），供步骤 3 使用        |
| 3  | `{start}_to_{end}_basin-{basin}_hazard.tif` | uint8，0 = 未淹没，1–5 = 危险等级（分位数相对分级，各级约各占淹没区 20%） |
| 4  | `results_validation.txt`                    | 文本结果：参与检验点数、落入危险性区（>0）点数、命中率、等级构成              |
| 4  | `figures/validation_map.png/.pdf`           | 空间分布图：分级底图 + 点位（绿实心 = 落入、空心 = 未落入）             |

## 5. 方法口径（与论文 / 项目官方一致）



* **淹没判定**：`runoff >= 阈值栅格` → 淹没（保留 runoff 值，否则 0）。

* **时段危险性**：时段内逐像元淹没最大值 → 淹没区内 min-max 归一化 → 淹没区内

  20/40/60/80 分位数分为 1–5 级（**相对分级**，各等级面积约各占淹没区 20%）。

* **验证命中定义**：点位落入危险性区任意等级（>0）即算命中；命中率 = 命中数 / 参与检验点数。

  位置容差 1 km ≈ 1 个 0.009° 像元，0/1/3/5 km 均可配置。

* 风险 R = H × E × V 因含暴露度与脆弱性，**不宜**直接用洪水点位做定量验证；本流程只验证危险性 H。

## 6. 已知注意事项（本项目实测的坑）



1. **网格不一致**：本项目 runoff 混存两套网格（0.008983° 1560×3479 与 0.01° 1557×3478）。
   step3 会自动把阈值重投影到 runoff 网格（双线性），不影响正确性但建议上游统一网格；
   step2 计算阈值时若混入不同网格的 runoff 文件会跳过并警告，请先统一网格。

2. **数据缺口**：气象驱动缺日（如 2024-12-31）会直接跳过该日；LSTM 无法外推补缺，
   请确保驱动数据完整或接受相应覆盖率。另 2024-06-11、2024-06-30 两个淹没/径流文件损坏
   （TIFF 打不开）会在各步骤被跳过并警告，重算前请先修复上游数据。

3. **SHP 编码**：中文属性表可能是 GBK，`geopandas.read_file` 失败时用

   `encoding="gbk"` 读取（本流程只用几何坐标，不受影响）。

4. **分级不可跨情景比较**：分位数相对分级下 "3 级" 在不同时段 / 区域的绝对淹没强度

   不可直接对比；比较时应同时给淹没面积占比作基线。