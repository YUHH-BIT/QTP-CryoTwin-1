# -*- coding: utf-8 -*-
"""步骤 1：径流生成（与项目 Training/inference/predict.py 逻辑一致）。

模型语义（与 predict.py 完全相同）：
- 对每个像元，取其区间内全部日期 T 天的 4 变量时间序列 [T, 4]
  -> 一次过两层 LSTM（时间状态在 T 天内传递）-> 输出 T 天的径流序列 [T]
- 模型结构：LSTM(input=4, hidden=100, layers=2, dropout=0.2) + FC(100->1) + ReLU
- 输出：逐日写盘，每天做数值方向修正 flipped = max - (x - min)（predict.py 行为）

与 predict.py 的差异（仅执行方式，语义不变）：
- 驱动命名按本项目实际 {变量名}_{YYYY-MM-DD}.tif 自动识别日期
- 行块流式 + 像元分批推理，避免全年 [T,H,W]×4 变量一次载入内存
- 输出命名 {YYYY-MM-DD}_runoff.tif（与 webgis runoff_engine 一致）

用法：
    python step1_runoff.py --start 2024-01-01 --end 2024-12-31
    python step1_runoff.py --start 2024-07-01 --end 2024-08-31 --meteor_dir D:/data/era5

注意：
- 逐像元整段序列过 LSTM 较慢：全青藏高原一年约数小时（predict.py 同量级）。
  若你已有径流结果，可跳过本步直接运行 step3_hazard.py。
"""
import argparse
import os
import re
import time

import numpy as np
import rasterio
import torch
import torch.nn as nn

import config


# ---- 模型定义（与 Training/input/train.py / predict.py 保持一致）----
class RunoffLSTM(nn.Module):
    def __init__(self, input_size=4, hidden_size=100, num_layers=2, dropout=0.2):
        super().__init__()
        self.lstm = nn.LSTM(
            input_size=input_size, hidden_size=hidden_size,
            num_layers=num_layers, batch_first=True, dropout=dropout)
        self.fc = nn.Linear(hidden_size, 1)
        self.relu = nn.ReLU()

    def forward(self, x):
        out, _ = self.lstm(x)                       # [B, T, 100]
        return self.relu(self.fc(out).squeeze(-1))  # [B, T]


_DATE_RE = re.compile(r"(\d{4})[-_](\d{2})[-_](\d{2})")


def list_dates(meteor_dir, variables, start=None, end=None):
    """以变量 0 目录中所有含日期的 tif 文件为准，提取日期并过滤区间。"""
    d0 = os.path.join(meteor_dir, variables[0])
    dates = set()
    for f in os.listdir(d0):
        low = f.lower()
        if not low.endswith(".tif") or ".aux" in low:
            continue
        m = _DATE_RE.search(f)
        if m:
            dates.add(f"{m.group(1)}-{m.group(2)}-{m.group(3)}")
    dates = sorted(dates)
    if start:
        dates = [d for d in dates if d >= start]
    if end:
        dates = [d for d in dates if d <= end]
    return dates


def find_var_file(var_dir, date):
    """在变量目录中找含该日期的 tif（忽略 aux 等附属文件）。"""
    for f in os.listdir(var_dir):
        low = f.lower()
        if date in f and low.endswith(".tif") and ".aux" not in low:
            return os.path.join(var_dir, f)
    return None


def main():
    ap = argparse.ArgumentParser(description="径流生成（predict.py 同语义）：LSTM 全年序列 -> 逐日径流 tif")
    ap.add_argument("--meteor_dir", default=str(config.METEOR_DIR))
    ap.add_argument("--model", default=str(config.LSTM_MODEL))
    ap.add_argument("--out_dir", default=str(config.RUNOFF_DIR))
    ap.add_argument("--variables", nargs="+", default=list(config.VARIABLES))
    ap.add_argument("--start", required=True, help="起止日期，必填，如 2024-01-01")
    ap.add_argument("--end", required=True, help="结束日期，必填，如 2024-12-31")
    ap.add_argument("--flip", action="store_true", default=config.FLIP_DIRECTION,
                    help="每天做 max-(x-min) 数值方向修正（predict.py 行为，默认 True）")
    ap.add_argument("--block_rows", type=int, default=100,
                    help="行块大小，控制内存（默认 100 行）")
    ap.add_argument("--batch", type=int, default=500,
                    help="每批推理像元数（默认 500，内存不足调小）")
    args = ap.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"使用设备: {device}")

    # 模型结构与 predict.py 一致（dropout 0.2，推理时 eval 不生效）
    model = RunoffLSTM(input_size=len(args.variables), dropout=0.2).to(device)
    state = torch.load(args.model, map_location=device, weights_only=True)
    if isinstance(state, dict) and "state_dict" in state:
        state = state["state_dict"]
    model.load_state_dict(state)
    model.eval()

    dates = list_dates(args.meteor_dir, args.variables, args.start, args.end)
    print(f"待推理日期: {len(dates)} 天 ({dates[0]} ~ {dates[-1]})")
    if not dates:
        raise SystemExit("没有找到驱动数据，请检查 --meteor_dir 与日期区间")
    T = len(dates)

    # 参考影像（变量 0 的第一天）
    ref_path = find_var_file(os.path.join(args.meteor_dir, args.variables[0]), dates[0])
    if ref_path is None:
        raise SystemExit(f"变量 {args.variables[0]} 中未找到 {dates[0]} 的 tif")
    with rasterio.open(ref_path) as ref:
        H, W, profile = ref.height, ref.width, ref.profile
        profile.update(count=1, dtype=rasterio.float32, compress="lzw")

    # 预创建 T 个输出文件（nan 初始化），随后按行块写入
    out_paths = []
    for d in dates:
        p = os.path.join(args.out_dir, f"{d}_runoff.tif")
        with rasterio.open(p, "w", **profile) as dst:
            dst.write(np.full((H, W), np.nan, dtype=np.float32), 1)
        out_paths.append(p)

    t0 = time.time()
    n_valid = 0
    for r0 in range(0, H, args.block_rows):
        r1 = min(r0 + args.block_rows, H)
        rows = r1 - r0
        t_row = time.time()

        # 加载该行块的全年 4 变量 [T, rows, W]
        var_stacks = []
        skip = False
        for var in args.variables:
            stack = np.full((T, rows, W), np.nan, dtype=np.float32)
            for t, d in enumerate(dates):
                p = find_var_file(os.path.join(args.meteor_dir, var), d)
                if p is None:
                    skip = True
                    break
                with rasterio.open(p) as src:
                    img = src.read(1, window=((r0, r1), (0, W))).astype(np.float32)
                    if src.nodata is not None:
                        img = np.where(img == src.nodata, np.nan, img)
                    stack[t] = img
            if skip:
                print(f"  行 {r0}~{r1} 跳过：变量 {var} 数据缺失")
                break
            var_stacks.append(stack)
        if skip:
            continue

        # 有效像元（全年 4 变量均无缺失）
        valid_mask = np.all(np.isfinite(np.stack(var_stacks, axis=-1)), axis=(0, -1))  # [rows, W]
        vrows, vcols = np.where(valid_mask)
        nv = len(vrows)
        n_valid += nv

        # 逐像元取 [T, 4] 序列 -> LSTM -> [T]，分批推理
        results = np.full((T, rows, W), np.nan, dtype=np.float32)
        for i in range(0, nv, args.batch):
            sl = slice(i, min(i + args.batch, nv))
            seq = np.stack([var_stacks[k][:, vrows[sl], vcols[sl]] for k in range(len(args.variables))],
                           axis=-1)               # [T, B, 4]
            x = torch.tensor(seq.transpose(1, 0, 2), dtype=torch.float32).to(device)  # [B, T, 4]
            with torch.no_grad():
                y = model(x)                      # [B, T]
            results[:, vrows[sl], vcols[sl]] = y.cpu().numpy().transpose(1, 0)  # [T, B] -> 填 [T, rows, W]

        # 逐日写盘（含 flip，predict.py 行为）
        for t, d in enumerate(dates):
            arr = results[t]
            if args.flip:
                lo, hi = np.nanmin(arr), np.nanmax(arr)
                arr = hi - (arr - lo)
            with rasterio.open(out_paths[t], "r+") as dst:
                dst.write(arr, 1, window=((r0, r1), (0, W)))

        print(f"  行 {r0}~{r1}  有效像元 {nv:,}  耗时 {time.time()-t_row:.1f} s")

    print(f"完成：{T} 天，有效像元合计 {n_valid:,}，总耗时 {time.time()-t0:.1f} s，输出到 {args.out_dir}")


if __name__ == "__main__":
    main()
