// ============ 统一提示（UI 组件库 Toast），替代原生系统 alert 弹窗 ============
function uiMsg(message, type = 'warning') {
    if (window.UI && UI.toast) {
        UI.toast(message, type);
    } else {
        window.alert(message); // 组件库加载失败时降级为系统弹窗
    }
}

// 洪水阈值文件名 → 中文显示（如 grid_threshold_90p → 第90百分位数阈值（重度洪水））
const _THRESHOLD_SEVERITY = {
    '10': '轻度洪水',
    '50': '中度洪水',
    '90': '重度洪水',
    '95': '严重洪水',
    '99': '极端洪水',
};

function _thresholdLabel(name) {
    const base = String(name).replace(/\.tif$/i, '');
    const m = base.match(/grid_threshold_(\d+)p$/i);
    if (m) {
        const sev = _THRESHOLD_SEVERITY[m[1]];
        return sev ? `第${m[1]}百分位数阈值场（${sev}）` : `第${m[1]}百分位数阈值场`;
    }
    return base;
}

// ============ 模拟结果弹窗（与风险评估弹窗一致：可拖动/可隐藏/可重开） ============
window._simResultCharts = [];   // 弹窗内创建的图表实例：重开时 resize、重新渲染时销毁

function _trackSimChart(chart) {
    if (chart) window._simResultCharts.push(chart);
    return chart;
}

function _showSimResultModal(title, sub) {
    const modal = document.getElementById('sim-result-modal');
    const overlay = document.getElementById('sim-result-overlay');
    const titleEl = document.getElementById('sim-result-modal-title');
    const subEl = document.getElementById('sim-result-modal-sub');
    if (titleEl) titleEl.textContent = title;
    if (subEl) subEl.textContent = sub || '';
    // 清空上一次结果内容并销毁旧图表
    window._simResultCharts.forEach(c => { try { c.dispose(); } catch (e) {} });
    window._simResultCharts = [];
    const stats = document.getElementById('sim-result-stats');
    if (stats) stats.innerHTML = '';
    const table = document.getElementById('sim-result-table');
    if (table) {
        table.querySelector('thead').innerHTML = '';
        table.querySelector('tbody').innerHTML = '';
    }
    const tip = document.getElementById('sim-result-no-tip');
    if (tip) tip.style.display = 'none';
    modal.classList.add('active');
    overlay.classList.add('active');
    document.getElementById('sim-result-reopen').style.display = 'none';
    // 弹窗显示后再初始化图表，ECharts 尺寸才正确
    setTimeout(() => window._simResultCharts.forEach(c => { try { c.resize(); } catch (e) {} }), 0);
}

function _hideSimResultModal() {
    document.getElementById('sim-result-modal').classList.remove('active');
    document.getElementById('sim-result-overlay').classList.remove('active');
    document.getElementById('sim-result-reopen').style.display = '';
}

// 导出：洪水淹没逐日统计 CSV
function exportFloodCsv(result) {
    if (!result || !result.flood_results) { uiMsg('暂无淹没结果可导出', 'warning'); return; }
    const lines = ['日期,有无洪水,淹没面积(km²),淹没比例(%),平均径流,最大径流'];
    (result.flood_results || []).forEach(f => {
        lines.push([
            f.date || '',
            f.has_flood ? '是' : '否',
            f.flood_area_km2 != null ? f.flood_area_km2 : '',
            f.flood_ratio != null ? (f.flood_ratio * 100).toFixed(2) : '',
            f.mean_value != null ? f.mean_value : '',
            f.max_value != null ? f.max_value : ''
        ].join(','));
    });
    lines.push('');
    lines.push('总天数,' + (result.total_days || 0));
    lines.push('有效天数,' + (result.valid_days || 0));
    lines.push('洪水天数,' + (result.flood_days || 0));
    lines.push('洪水概率(%),' + ((result.flood_probability || 0) * 100).toFixed(2));
    const name = '洪水淹没统计_' + (result.start_date || '') + '_' + (result.end_date || '') + '.csv';
    UI.downloadText(name, '\ufeff' + lines.join('\r\n'), 'text/csv;charset=utf-8');
}

// 导出：下载洪水淹没结果 GeoTIFF（逐个下载）
function downloadFloodTifs(result) {
    const urls = (result && result.urls) || [];
    if (!urls.length) { uiMsg('暂无结果文件可下载', 'warning'); return; }
    urls.forEach((u, i) => {
        setTimeout(() => UI.downloadUrl(u, u.split('/').pop()), i * 400);
    });
}

function _reopenSimResultModal() {
    document.getElementById('sim-result-modal').classList.add('active');
    document.getElementById('sim-result-overlay').classList.add('active');
    document.getElementById('sim-result-reopen').style.display = 'none';
    setTimeout(() => window._simResultCharts.forEach(c => { try { c.resize(); } catch (e) {} }), 0);
}

// 弹窗标题栏拖动
function _makeSimResultModalDraggable() {
    const modal = document.getElementById('sim-result-modal');
    const header = modal.querySelector('.sim-result-modal-header');
    let dragging = false, startX = 0, startY = 0, origLeft = 0, origTop = 0;
    header.addEventListener('mousedown', (e) => {
        if (e.target.closest('button')) return;  // 点按钮不拖动
        dragging = true;
        const rect = modal.getBoundingClientRect();
        modal.style.transform = 'none';
        modal.style.left = rect.left + 'px';
        modal.style.top = rect.top + 'px';
        startX = e.clientX; startY = e.clientY;
        origLeft = rect.left; origTop = rect.top;
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        modal.style.left = (origLeft + e.clientX - startX) + 'px';
        modal.style.top = (origTop + e.clientY - startY) + 'px';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
}

// 绑定弹窗事件（script 在 body 末尾，DOM 已就绪）
(function() {
    const closeBtn = document.getElementById('sim-result-modal-close');
    const reopenBtn = document.getElementById('sim-result-reopen');
    const overlay = document.getElementById('sim-result-overlay');
    if (closeBtn) closeBtn.addEventListener('click', _hideSimResultModal);
    if (overlay) overlay.addEventListener('click', _hideSimResultModal);
    if (reopenBtn) reopenBtn.addEventListener('click', _reopenSimResultModal);
    _makeSimResultModalDraggable();
})();

// 加载第一个图层后开始链式播放（startLoop 内部保证每帧展示满 speed 毫秒，首图也会展示满 3 秒）
function autoPlayAfterLoad(url, variable, date, speed) {
    Promise.resolve(loadGeoTiffLayer(url, variable, date)).then(() => {
        if (typeof window.startLoop === 'function') {
            window.startLoop(speed || 3000);
        }
    });
}

// 通用流域加载函数（动态探测名称字段，value 用索引，与后端 get_basin_geometry 索引匹配一致）
async function loadBasinsToSelect(selectId) {
    const select = document.getElementById(selectId);
    if (!select) return;
    try {
        const resp = await fetch('/api/basin/data');
        const data = await resp.json();
        const features = data.features || (data.data && data.data.features) || [];
        if (!features.length) return;
        const firstProps = features[0].properties || {};
        const candidates = ['NAME', 'BASIN_NAME', 'BAS_NM', 'name', 'BASIN', 'PN', 'BAS_NAME', 'BasinName'];
        let nameField = candidates.find(f => firstProps[f] !== undefined && firstProps[f] !== '');
        if (!nameField) {
            nameField = Object.keys(firstProps).find(
                k => typeof firstProps[k] === 'string' && firstProps[k].length > 0 && firstProps[k].length < 30
            );
        }
        const defaultOpt = select.querySelector('option');
        select.innerHTML = '';
        if (defaultOpt) {
            // 保留默认选项（"全部流域" value=all 或空占位），不再强制清空 value
            select.appendChild(defaultOpt);
        }
        let loadedCount = 0;
        features.forEach((f, i) => {
            const name = (nameField && f.properties[nameField]) ? f.properties[nameField] : '';
            if (!name) return;  // 跳过无名称流域
            const opt = document.createElement('option');
            opt.value = String(i);
            opt.textContent = name;
            select.appendChild(opt);
            loadedCount++;
        });
        console.log(`[流域加载] ${selectId}: ${loadedCount} 个, 名称字段: ${nameField}`);
    } catch (e) {
        console.warn(`[流域加载] ${selectId} 失败:`, e);
    }
}

// 前端计算均值函数
async function calculateGeoTiffMean(url) {
    try {
        // 使用fetch获取GeoTIFF数据并计算均值
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP错误: ${response.status}`);
        }
        const arrayBuffer = await response.arrayBuffer();

        // 解析GeoTIFF数据
        const tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer);
        const image = await tiff.getImage();
        const data = await image.readRasters();

        // 假设是单通道数据
        const values = data[0];

        // 过滤掉nodata值（假设0为nodata）
        const validValues = [];
        for (let i = 0; i < values.length; i++) {
            if (values[i] > 0) {
                validValues.push(values[i]);
            }
        }

        // 计算均值
        if (validValues.length > 0) {
            const sum = validValues.reduce((acc, val) => acc + val, 0);
            return sum / validValues.length;
        }
        return null;
    } catch (error) {
        console.warn(`计算 ${url} 均值失败:`, error);
        return null;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const modelSelect = document.getElementById('model-select');
    const startDateInput = document.getElementById('start-date');
    const endDateInput = document.getElementById('end-date');
    const simulateBtn = document.getElementById('start-simulate');
    const resultTable = document.getElementById('result-table');
    const loadingOverlay = document.getElementById('loading-overlay');
    const mapContainer = document.getElementById('map');
    
    // 显示错误信息函数
    function showError(message) {
        console.error('错误:', message);
        // 静默处理错误，不显示给用户
    }

    // 中英文映射表
    const i18n = {
        variables: {
            'runoff': '径流',
            'inundation': '淹没水深',
            'flood': '洪水',
            'snowmelt': '融雪径流',
            'temperature_2m': '日均温',
            'temperature_2m_max': '日最高温',
            'total_precipitation_sum': '日总降水',
            'total_precipitation_max': '日最大降水',
        },
        units: {
            'runoff': 'mm',
            'inundation': 'mm',
            'flood': 'mm',
            'snowmelt': 'mm',
            'temperature_2m': '℃',
            'temperature_2m_max': '℃',
            'total_precipitation_sum': 'mm',
            'total_precipitation_max': 'mm',
        },
        labels: {
            'variable': '变量',
            'date': '日期',
            'mean_value': '值',
            'tif_file': '操作',
            'load_to_map': '加载',
            'select_model': '请选择径流模拟模型',
            'select_start_date': '请选择模拟起始日期',
            'select_end_date': '请选择模拟结束日期',
            'start_date_later': '模拟起始日期不能晚于模拟结束日期',
            'no_data': '未查询到模拟结果',
            'loading': '模拟中...',
            'loading_layer': '正在加载模拟数据图层...',
            'error_fetch_vars': '获取模型列表失败',
            'error_no_filepath': '未获取到文件路径，请检查模拟数据',
            'loop_playing': '播放中',
            'loop_paused': '已暂停'
        }
    };

    // 地图相关变量
    let tifLayer = null;
    let legendControl = null;
    let debugCanvasAdded = false; // 调试canvas标记
    // 循环播放相关变量
    let loopInterval = null;
    let loopTimer = null;      // 链式播放计时器（每帧保证展示 speed 毫秒）
    window.tifFileList = [];
    window.currentLoopIndex = 0;
    let isLoopPlaying = false;
    let isLoadingTiff = false; // 加载状态守卫
    let loopSpeedMs = 3000;    // 播放速度（毫秒/帧），倍速选择实时更新，1x = 3秒/帧
    let chartData = []; // 折线图数据
    let loopControlBtn = null;
    let loopStatusDisplay = null;
    // 径流模拟接口全局占用标记：径流模拟与洪水灾害过程-径流模拟两个入口共用同一后端接口，
    // 避免一个在跑时另一个入口重复提交（后端会返回 409）。
    // 两个入口在不同作用域，必须挂到 window 上共享。
    // 2026-09-24 恢复：此前版本的该标记从未 commit、随未提交改动丢失，
    // 与后端 _RUNOFF_RUN_LOCK 一并补回。
    window.runoffApiBusy = false;

    // 使用 main.js 中已定义的全局变量
    // - baseLayers: 底图配置
    // - basinLayer, riverLayer, cmaLayer: 专题图层引用
    // - originalRiverSource, originalCmaSource: 原始数据源
    // - map: 地图实例
    
    // 使用 main.js 中已创建的地图实例
    const map = window.map;

    // 流域边界GeoJSON加载
    function loadBasinData() {
        fetch('/api/basin/data')
            .then(res => {
                if (!res.ok) throw new Error('接口流域数据加载失败');
                return res.json();
            })
            .then(data => {
                const vectorSource = new ol.source.Vector({
                    features: new ol.format.GeoJSON().readFeatures(data, {
                        featureProjection: 'EPSG:3857'
                    })
                });
                basinLayer = new ol.layer.Vector({
                    source: vectorSource,
                    style: function(feature) {
                        const name = feature.get('BasinName') || '';
                        return [
                            new ol.style.Style({
                                stroke: new ol.style.Stroke({ color: '#5D4037', width: 2 }),
                                fill: null
                            }),
                            new ol.style.Style({
                                text: new ol.style.Text({
                                    text: name,
                                    font: 'bold 18px Microsoft YaHei, Arial, sans-serif',
                                    fill: new ol.style.Fill({ color: '#000000' }),
                                    stroke: new ol.style.Stroke({ color: '#ffffff', width: 3 }),
                                    textAlign: 'center',
                                    textBaseline: 'middle',
                                    placement: 'point',
                                    offsetY: -10,
                                    scale: 1.2
                                })
                            })
                        ];
                    },
                    type: 'basin-layer',
                    zIndex: 40
                });
                map.addLayer(basinLayer);
                map.getView().setZoom(5.5);
                console.log('流域边界数据加载完成！');
            })
            .catch(error => {
                fetch('assets/TibetanPlateau.geojson')
                    .then(res => {
                        if (!res.ok) throw new Error('本地流域数据加载失败');
                        return res.json();
                    })
                    .then(data => {
                        const vectorSource = new ol.source.Vector({
                            features: new ol.format.GeoJSON().readFeatures(data, {
                                featureProjection: 'EPSG:3857'
                            })
                        });
                        basinLayer = new ol.layer.Vector({
                            source: vectorSource,
                            style: function(feature) {
                                const name = feature.get('BasinName') || '';
                                return [
                                    new ol.style.Style({
                                        stroke: new ol.style.Stroke({ color: '#ff0000', width: 2 }),
                                        fill: new ol.style.Fill({ color: 'rgba(255, 0, 0, 0.1)' })
                                    }),
                                    new ol.style.Style({
                                        text: new ol.style.Text({
                                            text: name,
                                            font: 'bold 18px Microsoft YaHei, Arial, sans-serif',
                                            fill: new ol.style.Fill({ color: '#000000' }),
                                            stroke: new ol.style.Stroke({ color: '#ffffff', width: 3 }),
                                            textAlign: 'center',
                                            textBaseline: 'middle',
                                            placement: 'point',
                                            offsetY: -10,
                                            scale: 1.2
                                        })
                                    })
                                ];
                            },
                            type: 'basin-layer',
                            zIndex: 40
                        });
                        map.addLayer(basinLayer);
                        console.log('本地流域边界数据加载完成！');
                    })
                    .catch(err => {
                        console.error('流域边界数据加载失败:', err);
                    });
            });
    }

    // 河网数据加载
    function loadRiverData() {
        fetch('/api/basin/river')
            .then(res => {
                if (!res.ok) throw new Error('接口河网数据加载失败');
                return res.json();
            })
            .then(data => {
                const vectorSource = new ol.source.Vector({
                    features: new ol.format.GeoJSON().readFeatures(data, {
                        featureProjection: 'EPSG:3857'
                    })
                });
                originalRiverSource = vectorSource;
                riverLayer = new ol.layer.Vector({
                    source: vectorSource,
                    style: new ol.style.Style({
                        stroke: new ol.style.Stroke({
                            color: '#1E90FF',
                            width: 1.5
                        })
                    }),
                    type: 'river-layer',
                    zIndex: 30
                });
                map.addLayer(riverLayer);
                console.log('河网数据加载完成！');
            })
            .catch(error => {
                // 静默处理河网数据加载失败，不影响主要功能
                console.log('河网数据加载失败，跳过河网显示');
            });
    }

    // 水文站数据加载
    function loadCmaData() {
        // 定义带文字标签的样式函数，使用"站点"属性
        const cmaStyleFunction = function(feature) {
            // 从属性中获取站点名称，使用"站点"字段
            const stationName = feature.get('站点') || '未知站点';

            return new ol.style.Style({
                // 点样式
                image: new ol.style.Circle({
                    radius: 7, // 稍微增大半径提高可见性
                    fill: new ol.style.Fill({
                        color: '#00f849'
                    }),
                    stroke: new ol.style.Stroke({
                        color: '#ffffff',
                        width: 2
                    })
                }),
                // 文字标签样式
                text: new ol.style.Text({
                    text: stationName,
                    font: '12px Microsoft YaHei, sans-serif',
                    fill: new ol.style.Fill({
                        color: '#333333'
                    }),
                    stroke: new ol.style.Stroke({
                        color: '#ffffff',
                        width: 2
                    }),
                    offsetY: 20, // 增加偏移量避免文字与点重叠
                    offsetX: 0,
                    padding: [2, 5, 2, 5]
                })
            });
        };

        fetch('/api/basin/cma')
            .then(res => {
                if (!res.ok) throw new Error('接口水文站数据加载失败');
                return res.json();
            })
            .then(data => {
                const vectorSource = new ol.source.Vector({
                    features: new ol.format.GeoJSON().readFeatures(data, {
                        featureProjection: 'EPSG:3857'
                    })
                });
                originalCmaSource = vectorSource;
                cmaLayer = new ol.layer.Vector({
                    source: vectorSource,
                    style: cmaStyleFunction,
                    type: 'cma-layer',
                    zIndex: 50
                });
                map.addLayer(cmaLayer);
                console.log('水文站数据加载完成！');
            })
            .catch(error => {
                // 静默处理水文站数据加载失败，不影响主要功能
                console.log('水文站数据加载失败，跳出水文站显示');
            });
    }
    
    // 加载流域选择选项到下拉框
    function loadBasinOptions() {
        loadBasinsToSelect('runoff-basin-select');
    }

    // 加载流域选择选项
    loadBasinOptions();

    // 地图点击事件处理
    map.on('click', function(evt) {
        if (isLoopPlaying) {
            toggleLoopPlayback();
        }
    });

    // 颜色插值函数
    function interpolateColor(norm, colorStops) {
        const clampedNorm = Math.max(0, Math.min(1, norm));
        for (let i = 0; i < colorStops.length - 1; i++) {
            const start = colorStops[i];
            const end = colorStops[i + 1];
            if (clampedNorm >= start.value && clampedNorm <= end.value) {
                const t = (clampedNorm - start.value) / (end.value - start.value);
                return [
                    Math.round(start.color[0] + t * (end.color[0] - start.color[0])),
                    Math.round(start.color[1] + t * (end.color[1] - start.color[1])),
                    Math.round(start.color[2] + t * (end.color[2] - start.color[2]))
                ];
            }
        }
        return clampedNorm <= 0 ? colorStops[0].color : colorStops[colorStops.length - 1].color;
    }

    function formatValue(value, decimalPlaces) {
        if (Math.abs(value) < 1e-10) {
            return '0';
        }
        const formatted = value.toFixed(decimalPlaces);
        if (decimalPlaces > 0 && formatted.endsWith('.00')) {
            return formatted.replace('.00', '');
        }
        return formatted;
    }

    // 创建图例（从大到小排序，适配暗黑模式）
    function createLegend(variable, colorStops, minValue, maxValue) {
        if (legendControl) map.removeControl(legendControl);

        const isRunoff = variable.toLowerCase().includes('runoff') || variable.toLowerCase().includes('flood') || variable.toLowerCase().includes('inundation') || variable.toLowerCase().includes('snowmelt');

        // 图层标题按变量类型取名。此前这里硬编码成"洪水"，
        // 导致径流图层的图例也显示"洪水/mm"。改为查 i18n 字典，
        // 字典里没有的再按关键字回退（淹没/洪水/融雪/径流）。
        const varKey = (variable || '').toLowerCase();
        varName = i18n.variables[varKey]
            || (varKey.includes('inundation') ? '淹没水深'
                : varKey.includes('flood') ? '洪水'
                : varKey.includes('snowmelt') ? '融雪径流'
                : varKey.includes('runoff') ? '径流'
                : '径流');
        unit = i18n.units[varKey] || (isRunoff ? 'mm' : '');
        displayVariable = unit ? `${varName}/${unit}` : varName;

        // 图例高度策略（2026-09-11）：
        // 本图例被"灾害过程模拟"下三个功能共用 —— 径流模拟 / 洪水识别 / 淹没模拟。
        // 原先设 maxHeight:400px + overflow:auto，16 档里只要有一档标签换行
        // （径流小数位最多 6 位，如 "0.123456 - 0.123457"），总高就超过 400px，
        // 于是出现纵向拖拉条、末档被截断，必须手动拖拽才能看全。
        // 现改为：不设高度上限（内容多高就多高，自然向上延伸，锚点是 bottom 所以不跑出视口）
        // + overflow:visible（杜绝任何滚动条）+ 加宽档位行避免标签换行，
        // 三个功能图例高度一致且始终完整可见。
        const legendDiv = document.createElement('div');
        legendDiv.className = 'ol-legend';
        Object.assign(legendDiv.style, {
            background: '#1e293b',
            padding: '8px',
            fontSize: '12px',
            border: '1px solid #334155',
            position: 'absolute',
            bottom: '25px',
            left: '150px',
            width: '150px',
            maxWidth: '150px',
            // 不设 maxHeight：由 16 档内容决定高度，避免滚动条
            minHeight: '398px',   // 16 档 + 标题的完整高度，保证三个功能图例高度统一
            overflow: 'visible',
            boxSizing: 'border-box',
            borderRadius: '8px',
            color: '#e2e8f0',
            boxShadow: '0 2px 8px rgba(0,0,0,0.3)'
        });

        const title = document.createElement('div');
        title.textContent = displayVariable;
        title.style.fontWeight = '600';
        title.style.marginBottom = '6px';
        title.style.textAlign = 'center';
        title.style.color = '#93c5fd';
        legendDiv.appendChild(title);

        const effectiveMinValue = isRunoff ? Math.max(0, minValue) : minValue;

        const numLegendItems = 16;
        const midCount = numLegendItems - 2;

        // 小数位数（单位 mm）：实用精度到 0.01mm（2 位）已足够。
        // 跨度大时按档宽自动降为 1 位或整数；不再为极小档宽把位数抬到 3~6 位——
        // 毫米尺度下那是无意义精度（浮点噪声），且会让图例标签冗长、把 16 档撑高触发滚动条。
        // 原「下界=0 时不显示成 0」的保护循环会让 0.toFixed(任意位) 恒≤0 而一路加到 6 位，已删除。
        let decimalPlaces = 0;
        if (isRunoff) {
            const iv = (maxValue - effectiveMinValue) / midCount;
            decimalPlaces = iv > 0
                ? Math.min(2, Math.max(0, Math.ceil(-Math.log10(iv))))
                : 0;
        }

        if (Math.abs(maxValue - effectiveMinValue) < 1e-10) {
            const row = document.createElement('div');
            row.style.display = 'flex';
            row.style.alignItems = 'center';
            row.style.marginBottom = '8px';

            const colorBox = document.createElement('div');
            colorBox.style.width = '28px';
            colorBox.style.height = '14px';
            colorBox.style.marginRight = '8px';
            colorBox.style.border = '1px solid #475569';
            const [r, g, b] = interpolateColor(0.5, colorStops);
            colorBox.style.background = `rgb(${r}, ${g}, ${b})`;
            row.appendChild(colorBox);

            const valueText = document.createElement('span');
            valueText.textContent = isRunoff
                ? formatValue(maxValue, decimalPlaces)
                : `${Math.round(maxValue)}`;
            row.appendChild(valueText);
            legendDiv.appendChild(row);
        } else {
            const lastIdx = numLegendItems - 1;
            // 中间档等分 [effectiveMinValue, maxValue]；顶档表示超出上界的尾部，
            // 底档表示低于下界的头部。这样档位与渲染的 clamp 行为一致。
            const interval = (maxValue - effectiveMinValue) / midCount;
            const span = maxValue - effectiveMinValue;

            for (let i = 0; i < numLegendItems; i++) {
                const row = document.createElement('div');
                row.style.display = 'flex';
                row.style.alignItems = 'center';
                row.style.marginBottom = '8px';

                const colorBox = document.createElement('div');
                colorBox.style.width = '28px';
                colorBox.style.height = '14px';
                colorBox.style.marginRight = '8px';
                colorBox.style.border = '1px solid #475569';

                let t, label;
                if (i === 0) {
                    // 顶档：≥ 98% 分位（渲染时被 clamp 到最上端颜色）
                    t = 1;
                    label = isRunoff
                        ? `大于 ${formatValue(maxValue, decimalPlaces)}`
                        : `大于 ${Math.round(maxValue)}`;
                } else if (i === lastIdx) {
                    // 底档：低于 2% 分位的值。0 值不参与配色（图上透明），
                    // 标签用"小于"形式，避免出现 "0 - 0" 或单独的 0 值。
                    t = 0;
                    label = isRunoff
                        ? `小于 ${formatValue(effectiveMinValue, decimalPlaces)}`
                        : `≤ ${Math.round(effectiveMinValue)}`;
                } else {
                    const upperBound = maxValue - (i - 1) * interval;
                    const lowerBound = maxValue - i * interval;
                    // 色块取该档中点对应的归一化值，保证图例颜色与渲染色带严格一致
                    const mid = (upperBound + lowerBound) / 2;
                    t = span > 0 ? (mid - effectiveMinValue) / span : 0.5;
                    const lowerStr = isRunoff ? formatValue(lowerBound, decimalPlaces) : Math.round(lowerBound);
                    const upperStr = isRunoff ? formatValue(upperBound, decimalPlaces) : Math.round(upperBound);
                    label = `${lowerStr} ~ ${upperStr}`;
                }

                const [r, g, b] = interpolateColor(t, colorStops);
                colorBox.style.background = `rgb(${r}, ${g}, ${b})`;

                row.appendChild(colorBox);

                const valueText = document.createElement('span');
                valueText.textContent = label;
                // 档位标签不换行：换行会让个别档变成两行，
                // 三个功能的图例高度就会不一致，且总高容易顶破容器产生滚动条。
                valueText.style.whiteSpace = 'nowrap';

                row.appendChild(valueText);
                legendDiv.appendChild(row);
            }
        }

        legendControl = new ol.control.Control({ element: legendDiv });
        map.addControl(legendControl);
    }

    // 绘制折线图（ECharts 实现，暗色冰冻圈主题）
    let meanLineChart = null; // 记录实例，重新绘制时销毁
    function drawFittedLineChart({ containerId, data, title, yAxisLabel, xAxisLabel, containerSize }) {
        const oldContainer = document.getElementById(containerId);
        if (oldContainer) oldContainer.remove();

        const chartWrap = document.createElement('div');
        chartWrap.id = containerId;
        chartWrap.className = 'ui-fade-in';

        // 将折线图添加到 simulate-results 容器中
        const simulateResults = document.getElementById('simulate-results');
        if (simulateResults) {
            simulateResults.appendChild(chartWrap);
        } else {
            document.body.appendChild(chartWrap);
        }

        Object.assign(chartWrap.style, {
            position: 'relative',
            width: '100%',
            height: `${(containerSize && containerSize.height) || 220}px`,
            margin: '12px auto 4px'
        });

        if (typeof echarts === 'undefined') {
            chartWrap.innerHTML = '<div class="ui-empty"><i class="fa fa-bar-chart"></i><p>图表组件（ECharts）加载失败</p></div>';
            return;
        }

        if (meanLineChart) { try { meanLineChart.dispose(); } catch (e) {} meanLineChart = null; }
        const chart = echarts.init(chartWrap);
        meanLineChart = chart;

        const chartData = (data || []).filter(d => d.value !== null && d.value !== undefined && !isNaN(parseFloat(d.value)));

        if (chartData.length < 2) {
            chartWrap.innerHTML = '<div class="ui-empty"><i class="fa fa-line-chart"></i><p>暂无有效数据，无法绘制趋势图</p></div>';
            return;
        }

        const option = {
            title: {
                text: title || '',
                left: 'center',
                top: 2,
                textStyle: { color: '#93c5fd', fontSize: 15, fontWeight: 600 }
            },
            tooltip: {
                trigger: 'axis',
                backgroundColor: 'rgba(30, 41, 59, 0.92)',
                borderColor: '#334155',
                textStyle: { color: '#e2e8f0', fontSize: 12 }
            },
            grid: { left: '3%', right: '4%', bottom: '3%', top: '22%', containLabel: true },
            xAxis: {
                type: 'category',
                boundaryGap: false,
                data: chartData.map(d => d.date),
                axisLabel: { color: '#94a3b8', rotate: 35, fontSize: 11 },
                axisLine: { lineStyle: { color: '#334155' } },
                axisTick: { show: false },
                name: xAxisLabel || '日期',
                nameTextStyle: { color: '#94a3b8', fontSize: 11 }
            },
            yAxis: {
                type: 'value',
                name: yAxisLabel || '',
                nameTextStyle: { color: '#94a3b8', fontSize: 11 },
                axisLabel: { color: '#94a3b8', fontSize: 11 },
                axisLine: { show: false },
                splitLine: { lineStyle: { color: 'rgba(51, 65, 85, 0.7)', type: 'dashed' } }
            },
            series: [{
                name: title || '趋势',
                type: 'line',
                smooth: true,
                symbol: 'circle',
                symbolSize: 6,
                data: chartData.map(d => parseFloat(d.value)),
                lineStyle: { color: '#4ade80', width: 2.5 },
                itemStyle: { color: '#d1fae5', borderColor: '#4ade80', borderWidth: 2 },
                areaStyle: {
                    color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                        { offset: 0, color: 'rgba(74, 222, 128, 0.35)' },
                        { offset: 1, color: 'rgba(74, 222, 128, 0.03)' }
                    ])
                }
            }]
        };

        chart.setOption(option);
        window.addEventListener('resize', () => { try { chart.resize(); } catch (e) {} });
    }

    // 加载GeoTIFF图层
window.loadGeoTiffLayer = async function(filePath, variable, date) {
    if (isLoadingTiff) {
        console.warn('上一个 GeoTIFF 加载中，跳过本次...');
        return;
    }
    isLoadingTiff = true;
    console.log(`开始加载: ${filePath}, 当前状态: loading=${isLoadingTiff}, playing=${isLoopPlaying}`);

    // 从文件路径中提取变量信息，如果未提供的话
    const fileName = filePath.split('/').pop();
    if (!variable) {
        const varMatch = fileName.match(/_([a-z]+)\.tif$/i);
        variable = varMatch ? varMatch[1] : 'runoff';
    }

    if (tifLayer) {
        map.removeLayer(tifLayer);
        tifLayer = null;
    }

    if (legendControl) {
        map.removeControl(legendControl);
        legendControl = null;
    }

    loadingOverlay.style.display = 'flex';
    loadingOverlay.querySelector('.loading-text').textContent = i18n.labels.loading_layer;

    try {
        console.log('开始加载 GeoTIFF:', filePath);
        const response = await fetch(filePath);
        if (!response.ok) throw new Error(`网络请求失败: ${response.status} ${response.statusText}`);
        const arrayBuffer = await response.arrayBuffer();
        const tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer);
        const image = await tiff.getImage();
        const width = image.getWidth();
        const height = image.getHeight();
        if (width <= 0 || height <= 0) {
            throw new Error(`无效的图像尺寸: ${width}x${height}`);
        }
        const bbox = image.getBoundingBox();
        const extentWebMercator = ol.proj.transformExtent(bbox, 'EPSG:4326', 'EPSG:3857');
        console.log('🗺️ 图层地理范围:', extentWebMercator);
        const rasters = await image.readRasters({ interleave: true });
        const samplesPerPixel = image.getSamplesPerPixel();
        console.log('📊 数据波段数:', samplesPerPixel);
        const bandData = [];
        for (let i = 0; i < rasters.length; i += samplesPerPixel) {
            bandData.push(rasters[i]);
        }
        // nodata 检测：不能用硬编码 -9999。本项目历史产物混用了 NaN、-3.4e38 哨兵、
        // -9999、0 四种无效值标记（而且 ReLU 输出 0 是合法值）。这里用统一的判别函数。
        const noDataValue = -9999;          // 保留作历史兼容
        const isNoData = v => v === noDataValue || !Number.isFinite(v) || v <= -3e38;

        const validData = bandData.filter(v => !isNoData(v));
        if (validData.length === 0) {
            throw new Error('TIFF文件中没有有效数据');
        }

        // 只用非零正值计算分位拉伸范围：0 值不参与配色，图上透明显示
        const positiveData = validData.filter(v => v > 1e-10);
        if (positiveData.length === 0) {
            throw new Error('TIFF文件中没有非零有效数据');
        }
        const sorted = Array.from(positiveData).sort((a, b) => a - b);
        const percentile = p => {
            const idx = (sorted.length - 1) * p;
            const lo = Math.floor(idx);
            const hi = Math.ceil(idx);
            return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
        };
        let minValue = percentile(0.02);
        let maxValue = percentile(0.98);
        if (!(maxValue > minValue)) {
            maxValue = minValue + Math.max(1e-6, Math.abs(minValue) * 0.01);
        }

        // 使用规范的颜色映射：径流 - 大值深蓝，小值浅红
        const colorStops = [
            { value: 0/19, color: [255, 0, 0] },    // 红色 (最小值)
            { value: 1/19, color: [255, 64, 0] },
            { value: 2/19, color: [255, 128, 0] },
            { value: 3/19, color: [255, 192, 0] },
            { value: 4/19, color: [255, 255, 0] },  // 黄色
            { value: 5/19, color: [192, 255, 0] },
            { value: 6/19, color: [128, 255, 0] },
            { value: 7/19, color: [64, 255, 0] },
            { value: 8/19, color: [0, 255, 0] },    // 绿色
            { value: 9/19, color: [0, 255, 64] },
            { value: 10/19, color: [0, 255, 128] },
            { value: 11/19, color: [0, 255, 192] },
            { value: 12/19, color: [0, 255, 255] }, // 青色
            { value: 13/19, color: [0, 192, 255] },
            { value: 14/19, color: [0, 128, 255] },
            { value: 15/19, color: [0, 64, 255] },
            { value: 16/19, color: [0, 0, 255] },   // 浅蓝
            { value: 17/19, color: [0, 0, 200] },   // 中蓝
            { value: 18/19, color: [0, 0, 150] },   // 深蓝
            { value: 19/19, color: [0, 0, 100] }    // 最深蓝 (最大值)
        ];

        console.log(`🌈 数据范围: 2%分位=${minValue}, 98%分位=${maxValue} (原始 min=${sorted[0]} max=${sorted[sorted.length-1]})`);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        const imageData = ctx.createImageData(width, height);
        console.log(`📊 创建画布: ${width}x${height}, 像素总数: ${bandData.length}`);

        for (let i = 0; i < bandData.length; i++) {
            const val = bandData[i];
            // 0 值（ReLU 背景）与 nodata 一律透明：图上不显示 0 值的颜色
            if (isNoData(val) || val <= 1e-10) {
                imageData.data.set([0, 0, 0, 0], i * 4);
            } else {
                // 分位数拉伸 + 截断
                const norm = Math.max(0, Math.min(1, (val - minValue) / (maxValue - minValue)));
                const [r, g, b] = interpolateColor(norm, colorStops);
                imageData.data.set([r, g, b, 255], i * 4);
            }
        }
        ctx.putImageData(imageData, 0, 0);
        console.log(`✅ 画布绘制完成，非零像素数量: ${imageData.data.filter((v, i) => i % 4 < 3 && v > 0).length}`);
        
        // 关键修复：使用ImageCanvas源，实现动态绘制
        if (tifLayer) {
            map.removeLayer(tifLayer);
        }
        
        tifLayer = new ol.layer.Image({
            source: new ol.source.ImageCanvas({
                canvasFunction: (extent, resolution, pixelRatio, size, projection) => {
                    if (projection.getCode() !== 'EPSG:3857') {
                        console.warn('投影不匹配，期望EPSG:3857');
                        return null;
                    }
                    const outputCanvas = document.createElement('canvas');
                    outputCanvas.width = size[0];
                    outputCanvas.height = size[1];
                    const outputCtx = outputCanvas.getContext('2d');
                    outputCtx.clearRect(0, 0, size[0], size[1]);
                    
                    // 计算缩放比例和绘制位置
                    const scaleX = size[0] / ol.extent.getWidth(extent);
                    const scaleY = size[1] / ol.extent.getHeight(extent);
                    const targetX = (extentWebMercator[0] - extent[0]) * scaleX;
                    const targetY = (extent[3] - extentWebMercator[3]) * scaleY;
                    const targetWidth = ol.extent.getWidth(extentWebMercator) * scaleX;
                    const targetHeight = ol.extent.getHeight(extentWebMercator) * scaleY;
                    
                    // 绘制图像
                    outputCtx.drawImage(
                        canvas, 0, 0, canvas.width, canvas.height,
                        targetX, targetY, targetWidth, targetHeight
                    );
                    
                    return outputCanvas;
                },
                projection: 'EPSG:3857',
                imageExtent: extentWebMercator
            }),
            opacity: 0.75,
            visible: true,
            // 遵循点线面顺序：结果栅格属于"面"要素，仅比冻土（zIndex:5）略高，不覆盖线/点要素
            zIndex: 10
        });
        
        // 添加更多调试信息
        const source = tifLayer.getSource();
        console.log('🔍 图层源类型:', source.constructor.name);
        console.log('🔍 图层源配置:', {
            projection: source.getProjection().getCode(),
            imageExtent: extentWebMercator
        });
        
        console.log('创建新图层:', tifLayer, '图层源:', tifLayer.getSource());
        map.addLayer(tifLayer);
        tifLayer.changed(); // 通知OL图层已更新
        console.log('图层数量:', map.getLayers().getLength(), '当前图层:', tifLayer);
        
        // 检查图层是否正确添加
        const layers = map.getLayers().getArray();
        console.log('所有图层:', layers);
        for (let i = 0; i < layers.length; i++) {
            console.log('图层', i, ':', layers[i], 'zIndex:', layers[i].getZIndex(), 'visible:', layers[i].getVisible());
        }
        map.getView().fit(extentWebMercator, { padding: [50, 50, 50, 50], maxZoom: 10 }); // 强制定位到TIFF范围
        console.log('地图中心:', map.getView().getCenter(), '地图缩放:', map.getView().getZoom());
        
        try {
            createLegend(variable, colorStops, minValue, maxValue);
            console.log('图例创建成功');
        } catch (legendErr) {
            console.error('创建图例时出错:', legendErr);
        }
        
        // 强制地图渲染
        setTimeout(() => {
            map.renderSync();  // 同步渲染
            console.log('地图已同步渲染');
        }, 200);  // 延长延迟时间以确保canvas绘制完成
        
        console.log('✅ 图层加载完成');
        
        // 再次尝试触发地图渲染
        setTimeout(() => {
            if (tifLayer && tifLayer.getSource()) {
                tifLayer.getSource().changed();  // 触发源更新
                console.log('已触发图层源更新');
            }
        }, 500);
    } catch (err) {
        console.error('GeoTIFF 加载错误:', err);
        uiMsg('加载TIF文件失败: ' + err.message, 'error');
    } finally {
        loadingOverlay.style.display = 'none';
        isLoadingTiff = false;
    }
}

    // 循环播放控制函数（链式：每帧加载完成后展示满 speed 毫秒再切换下一张）
    function startLoop(speed = 3000) {
        if (loopInterval) { clearInterval(loopInterval); loopInterval = null; }
        if (loopTimer) { clearTimeout(loopTimer); loopTimer = null; }
        isLoopPlaying = true;
        updateLoopStatusIndicator();
        loopNext(speed);
    }

    function loopNext(speed) {
        if (!isLoopPlaying) return;
        loopTimer = setTimeout(() => {
            loopTimer = null;
            if (!isLoopPlaying) return;
            window.currentLoopIndex = (window.currentLoopIndex + 1) % window.tifFileList.length;
            const fileInfo = window.tifFileList[window.currentLoopIndex];
            if (typeof loadGeoTiffLayer === 'function') {
                console.log(`循环切换到索引 ${window.currentLoopIndex}: ${fileInfo.filePath}`);
                // 等上一张加载完成后再开始计时，保证每张展示满 speed 毫秒
                Promise.resolve(loadGeoTiffLayer(fileInfo.filePath, fileInfo.variable, fileInfo.date))
                    .then(() => {
                        updateLoopStatusIndicator();
                        loopNext(speed);
                    })
                    .catch(() => {
                        updateLoopStatusIndicator();
                        loopNext(speed);
                    });
            } else {
                console.warn('loadGeoTiffLayer 未定义，停止循环');
                stopLoop();
            }
        }, speed);
    }

    function stopLoop() {
        if (loopInterval) { clearInterval(loopInterval); loopInterval = null; }
        if (loopTimer) { clearTimeout(loopTimer); loopTimer = null; }
        isLoopPlaying = false;
        updateLoopStatusIndicator();
    }

    window.startLoop = startLoop;
    window.stopLoop = stopLoop;

    function toggleLoop() {
        if (window.tifFileList.length === 0) return;
        isLoopPlaying ? stopLoop() : startLoop(loopSpeedMs);
    }

    window.toggleLoop = toggleLoop;

    function updateLoopStatusIndicator() {
        let player = document.getElementById('video-player-controls');
        if (!player) {
            player = document.createElement('div');
            player.id = 'video-player-controls';
            player.innerHTML = `
                <style>
                    #video-player-controls {
                        position: absolute;
                        bottom: 30px;
                        left: 50%;
                        transform: translateX(-50%);
                        background: rgba(0, 0, 0, 0.85);
                        border-radius: 12px;
                        padding: 8px 16px;
                        display: flex;
                        align-items: center;
                        gap: 12px;
                        z-index: 1000;
                        box-shadow: 0 4px 20px rgba(0,0,0,0.5);
                        backdrop-filter: blur(10px);
                        border: 1px solid rgba(255,255,255,0.1);
                    }
                    #video-player-controls .control-btn {
                        background: transparent;
                        border: none;
                        color: white;
                        cursor: pointer;
                        font-size: 16px;
                        padding: 6px 10px;
                        border-radius: 6px;
                        transition: all 0.2s;
                    }
                    #video-player-controls .control-btn:hover {
                        background: rgba(255,255,255,0.1);
                    }
                    #video-player-controls .control-btn.play-btn {
                        font-size: 24px;
                        padding: 8px 14px;
                        background: #4ade80;
                    }
                    #video-player-controls .control-btn.play-btn:hover {
                        background: #16a34a;
                    }
                    #video-player-controls .progress-container {
                        flex: 1;
                        min-width: 200px;
                        height: 6px;
                        background: rgba(255,255,255,0.2);
                        border-radius: 3px;
                        cursor: pointer;
                        position: relative;
                    }
                    #video-player-controls .progress-bar {
                        height: 100%;
                        background: #4ade80;
                        border-radius: 3px;
                        width: 0%;
                        transition: width 0.1s;
                    }
                    #video-player-controls .progress-container:hover .progress-bar {
                        background: #86efac;
                    }
                    #video-player-controls .time-display {
                        color: rgba(255,255,255,0.8);
                        font-size: 12px;
                        min-width: 60px;
                        text-align: center;
                    }
                    #video-player-controls .speed-select {
                        background: rgba(255,255,255,0.1);
                        border: 1px solid rgba(255,255,255,0.2);
                        color: white;
                        border-radius: 4px;
                        padding: 4px 8px;
                        font-size: 12px;
                        cursor: pointer;
                    }
                    #video-player-controls .speed-select option {
                        background: #1e293b;
                        color: white;
                    }
                    #video-player-controls .date-display {
                        color: rgba(255,255,255,0.6);
                        font-size: 11px;
                        min-width: 100px;
                        text-align: center;
                    }
                </style>
                <button class="control-btn" onclick="prevFrame()" title="上一帧">⏮</button>
                <button class="control-btn play-btn" onclick="toggleLoop()">▶</button>
                <button class="control-btn" onclick="nextFrame()" title="下一帧">⏭</button>
                <div class="progress-container" onclick="seekTo(event)">
                    <div class="progress-bar" id="player-progress"></div>
                </div>
                <div class="time-display" id="player-time">00:00 / 00:00</div>
                <div class="date-display" id="player-date">--</div>
                <select class="speed-select" onchange="changeSpeed(this.value)">
                    <option value="0.5">0.5x</option>
                    <option value="1" selected>1x</option>
                    <option value="1.5">1.5x</option>
                    <option value="2">2x</option>
                    <option value="3">3x</option>
                </select>
            `;
            document.body.appendChild(player);
        }
        
        const playBtn = player.querySelector('.play-btn');
        const progressBar = player.querySelector('.progress-bar');
        const timeDisplay = player.querySelector('#player-time');
        const dateDisplay = player.querySelector('#player-date');
        
        playBtn.textContent = isLoopPlaying ? '⏸' : '▶';
        
        const total = window.tifFileList ? window.tifFileList.length : 0;
        const current = window.currentLoopIndex !== undefined ? window.currentLoopIndex + 1 : 0;
        const progress = total > 0 ? (current / total) * 100 : 0;
        
        progressBar.style.width = progress + '%';
        
        const currentStr = String(current).padStart(2, '0');
        const totalStr = String(total).padStart(2, '0');
        timeDisplay.textContent = `${currentStr} / ${totalStr}`;
        
        if (window.tifFileList && window.tifFileList[window.currentLoopIndex]) {
            dateDisplay.textContent = window.tifFileList[window.currentLoopIndex].date;
        }
    }

    function prevFrame() {
        if (!window.tifFileList || window.tifFileList.length === 0) return;
        window.currentLoopIndex = (window.currentLoopIndex - 1 + window.tifFileList.length) % window.tifFileList.length;
        const fileInfo = window.tifFileList[window.currentLoopIndex];
        loadGeoTiffLayer(fileInfo.filePath, fileInfo.variable, fileInfo.date);
        updateLoopStatusIndicator();
    }

    function nextFrame() {
        if (!window.tifFileList || window.tifFileList.length === 0) return;
        window.currentLoopIndex = (window.currentLoopIndex + 1) % window.tifFileList.length;
        const fileInfo = window.tifFileList[window.currentLoopIndex];
        loadGeoTiffLayer(fileInfo.filePath, fileInfo.variable, fileInfo.date);
        updateLoopStatusIndicator();
    }

    function seekTo(event) {
        if (!window.tifFileList || window.tifFileList.length === 0) return;
        const container = event.currentTarget;
        const rect = container.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const percent = x / rect.width;
        window.currentLoopIndex = Math.floor(percent * window.tifFileList.length);
        if (window.currentLoopIndex >= window.tifFileList.length) {
            window.currentLoopIndex = window.tifFileList.length - 1;
        }
        const fileInfo = window.tifFileList[window.currentLoopIndex];
        loadGeoTiffLayer(fileInfo.filePath, fileInfo.variable, fileInfo.date);
        updateLoopStatusIndicator();
    }

    function changeSpeed(speed) {
        // 1x 对应默认 3000ms/帧，2x 即 1500ms/帧，以此类推
        loopSpeedMs = 3000 / parseFloat(speed);
        if (isLoopPlaying) {
            stopLoop();
            startLoop(loopSpeedMs);
        }
    }

    window.prevFrame = prevFrame;
    window.nextFrame = nextFrame;
    window.seekTo = seekTo;
    window.changeSpeed = changeSpeed;

    // 切换循环播放
    function toggleLoopPlayback() {
        if (isLoopPlaying) {
            stopLoop();
            if (loopControlBtn) {
                loopControlBtn.textContent = '▶';
            }
            if (loopStatusDisplay) {
                loopStatusDisplay.textContent = i18n.labels.loop_paused;
            }
        } else {
            if (window.tifFileList.length === 0) return;
            
            if (loopControlBtn) {
                loopControlBtn.textContent = '⏸';
            }
            if (loopStatusDisplay) {
                loopStatusDisplay.textContent = i18n.labels.loop_playing;
            }
            // 复用链式播放，沿用当前倍速
            startLoop(loopSpeedMs);
        }
    }

    // 模拟按钮点击事件
    simulateBtn.addEventListener('click', async () => {
        const selectedModel = modelSelect.value;
        const startDate = startDateInput.value;
        const endDate = endDateInput.value;
        const selectedBasin = document.getElementById('runoff-basin-select').value; // 获取选中的流域

        if (!selectedModel) {
            uiMsg(i18n.labels.select_model);
            return;
        }
        if (!startDate) {
            uiMsg(i18n.labels.select_start_date);
            return;
        }
        if (!endDate) {
            uiMsg(i18n.labels.select_end_date);
            return;
        }
        if (new Date(startDate) > new Date(endDate)) {
            uiMsg(i18n.labels.start_date_later);
            return;
        }

        // 与洪水灾害过程-径流模拟入口共用同一接口，运行中禁止重复提交
        if (window.runoffApiBusy) {
            uiMsg('已有径流模拟任务在运行，请等待其完成后再提交', 'error');
            return;
        }
        window.runoffApiBusy = true;

        // 设置按钮为模拟中状态
        const originalText = simulateBtn.innerHTML;
        simulateBtn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> 模拟中...';
        simulateBtn.disabled = true;
        simulateBtn.style.opacity = '0.7';
        simulateBtn.style.cursor = 'not-allowed';

        if (loadingOverlay) {
            loadingOverlay.style.display = 'flex';
            const loadingText = loadingOverlay.querySelector('.loading-text');
            if (loadingText) {
                loadingText.textContent = i18n.labels.loading;
            }
        }

        try {
            // 调用真实的后端模拟API
            const response = await fetch('/api/simulate/runoff', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: selectedModel,
                    start_date: startDate,
                    end_date: endDate,
                    basin_id: selectedBasin || null  // 添加流域ID参数，如果未选择则为null
                })
            });

            if (!response.ok) {
                // 解析后端错误信息（如 409 已有任务在运行），而不是只给状态码
                let errMsg = `模拟请求失败: ${response.status} ${response.statusText}`;
                try {
                    const errBody = await response.json();
                    if (errBody && errBody.error) errMsg = errBody.error;
                } catch (e) { /* 响应体非 JSON 时保留默认提示 */ }
                throw new Error(errMsg);
            }

            const result = await response.json();

            if (result.status === 'success') {
                // 将后端返回的文件列表转换为前端需要的格式
                const results = result.data.files.map(filePath => {
                    const fileName = filePath.split('/').pop();
                    const dateMatch = fileName.match(/(\d{4}-\d{2}-\d{2})/);
                    const date = dateMatch ? dateMatch[1] : '未知日期';
                    
                    return {
                        variable: 'runoff',
                        date: date,
                        meanValue: '计算中...',
                        filePath: filePath
                    };
                });

                // 计算每个文件的均值
                const resultsWithMeans = await Promise.all(results.map(async (result) => {
                    try {
                        const meanValue = await calculateGeoTiffMean(result.filePath);
                        return {
                            ...result,
                            meanValue: meanValue !== null ? meanValue.toFixed(2) : '计算失败'
                        };
                    } catch (error) {
                        console.error(`计算均值失败: ${result.filePath}`, error);
                        return {
                            ...result,
                            meanValue: '计算失败'
                        };
                    }
                }));

                displayResults(resultsWithMeans);
                
                // 将所有径流结果添加到循环播放列表并自动开始播放
                if (result.data && result.data.files && result.data.files.length > 0) {
                    window.tifFileList = [];
                    window.currentLoopIndex = 0;
                    
                    result.data.files.forEach((filePath, index) => {
                        const fileName = filePath.split('/').pop();
                        const dateMatch = fileName.match(/(\d{4}-\d{2}-\d{2})/);
                        const date = dateMatch ? dateMatch[1] : '未知日期';
                        
                        window.tifFileList.push({
                            filePath: filePath,
                            variable: 'runoff',
                            date: date
                        });
                    });
                    
                    // 第一个图显示3秒后再开始播放，3秒/帧
                    autoPlayAfterLoad(result.data.files[0], 'runoff', window.tifFileList[0].date, 3000);
                }
            } else {
                throw new Error(result.error || '模拟失败');
            }
        } catch (error) {
            console.error('模拟功能出错:', error);
            uiMsg(`模拟失败: ${error.message}`, 'error');
        } finally {
            // 恢复按钮状态
            simulateBtn.innerHTML = '<i class="fa fa-play mr-2"></i>开始模拟';
            simulateBtn.disabled = false;
            simulateBtn.style.opacity = '1';
            simulateBtn.style.cursor = 'pointer';
            window.runoffApiBusy = false;

            loadingOverlay.style.display = 'none';
        }
    });

    // 显示结果
    function displayResults(results) {
        // 使用组件化表格样式
        resultTable.className = 'ui-table';
        const thead = resultTable.querySelector('thead');
        const tbody = resultTable.querySelector('tbody');
        
        // 生成表头
        thead.innerHTML = '';
        const trHead = document.createElement('tr');
        
        const headers = ['变量', '日期', '均值', '操作'];
        headers.forEach(headerText => {
            const th = document.createElement('th');
            th.textContent = headerText;
            trHead.appendChild(th);
        });
        
        thead.appendChild(trHead);
        tbody.innerHTML = '';

        if (results.length === 0) {
            const row = document.createElement('tr');
            const cell = document.createElement('td');
            cell.colSpan = 4;
            cell.innerHTML = '<div class="ui-empty"><i class="fa fa-inbox"></i><p>未查询到模拟结果</p></div>';
            row.appendChild(cell);
            tbody.appendChild(row);
            return;
        }

        window.tifFileList = []; // 显式使用全局播放列表，避免与隐式全局混淆
        chartData = [];
        results.forEach((result, index) => {
            const row = document.createElement('tr');
            
            const varCell = document.createElement('td');
            varCell.innerHTML = UI.badge(i18n.variables[result.variable] || result.variable, 'ice', { dot: false });
            row.appendChild(varCell);

            const dateCell = document.createElement('td');
            dateCell.textContent = result.date;
            row.appendChild(dateCell);

            const valueCell = document.createElement('td');
            valueCell.innerHTML = UI.badge(String(result.meanValue), result.meanValue !== '计算失败' && result.meanValue !== '计算中...' ? 'info' : 'default', { dot: false });
            row.appendChild(valueCell);

            const actionCell = document.createElement('td');
            const loadBtn = document.createElement('button');
            loadBtn.innerHTML = '<i class="fa fa-map-marker mr-1"></i>' + i18n.labels.load_to_map;
            loadBtn.className = 'ui-btn ui-btn-primary ui-btn-sm';
            loadBtn.addEventListener('click', () => {
                loadGeoTiffLayer(result.filePath, result.variable, result.date);

                // 添加到循环播放列表（同一文件不重复入列）
                if (!window.tifFileList.some(f => f.filePath === result.filePath)) {
                    window.tifFileList.push({
                        filePath: result.filePath,
                        variable: result.variable,
                        date: result.date
                    });
                }
            });
            actionCell.appendChild(loadBtn);
            row.appendChild(actionCell);

            tbody.appendChild(row);
            
            // 添加折线图数据
            if (result.meanValue !== '计算中...' && result.meanValue !== '计算失败' && result.meanValue !== null) {
                chartData.push({
                    date: result.date,
                    value: parseFloat(result.meanValue)
                });
            }
        });

        // 绘制折线图（当有效数据点≥2时）
        if (chartData.length >= 2) {
            drawFittedLineChart({
                containerId: 'mean-line-chart',
                data: chartData,
                title: (() => {
                    const zh = i18n.variables['runoff'] || '径流';
                    const unit = i18n.units['runoff'] || '';
                    return unit ? `${zh}（${unit}）` : zh;
                })(),
                yAxisLabel: `${i18n.labels.mean_value}（mm）`,
                xAxisLabel: i18n.labels.date,
                containerSize: { width: 400, height: 200 }
            });
        }

        // 创建循环播放控件
        if (results.length > 1) {
            const loopContainer = document.createElement('div');
            loopContainer.style.marginTop = '10px';
            loopContainer.style.textAlign = 'center';
            
            loopControlBtn = document.createElement('button');
            loopControlBtn.textContent = '▶';
            loopControlBtn.className = 'loop-btn';
            loopControlBtn.addEventListener('click', toggleLoopPlayback);
            
            loopStatusDisplay = document.createElement('span');
            loopStatusDisplay.textContent = i18n.labels.loop_paused;
            loopStatusDisplay.style.marginLeft = '10px';
            loopStatusDisplay.style.color = '#666';
            
            loopContainer.appendChild(loopControlBtn);
            loopContainer.appendChild(loopStatusDisplay);
            
            const existingLoopContainer = document.querySelector('.loop-container');
            if (existingLoopContainer) {
                existingLoopContainer.remove();
            }
            loopContainer.className = 'loop-container';
            resultTable.parentNode.insertBefore(loopContainer, resultTable.nextSibling);
        }
        // 自动播放由模拟成功回调中的 autoPlayAfterLoad 统一触发，此处不再重复处理
    }

    // 加载模型列表
    async function loadModels() {
        if (!modelSelect) {
            showError('模型选择框不存在');
            return;
        }
        try {
            console.log('加载模型列表...');
            const res = await fetch('/api/simulate/models');
            if (!res.ok) throw new Error(`接口请求失败: ${res.status}`);
            const models = await res.json();
            if (!Array.isArray(models) || models.length === 0) throw new Error('无可用模型');
            modelSelect.innerHTML = '';
            const defaultOption = document.createElement('option');
            defaultOption.value = '';
            defaultOption.textContent = `-- 请选择径流模拟模型 --`;
            modelSelect.appendChild(defaultOption);

            models.forEach(name => {
                const opt = document.createElement('option');
                opt.value = name;
                // 根据模型文件名显示友好的名称
                if (name === 'lstm_runoff_model.pt') {
                    opt.textContent = '长短期记忆网络（LSTM）模型';
                } else {
                    opt.textContent = name;
                }
                modelSelect.appendChild(opt);
            });
            console.log('模型列表加载完毕');
        } catch (e) {
            modelSelect.innerHTML = '<option>加载失败</option>';
            showError('模型列表加载失败: ' + e.message);
            console.error(e);
        }
    }

    // 初始化日期选择器
// 默认设置为2024年全年
function initializeDatePickers() {
    const startDate = new Date(2024, 0, 1);
    const endDate = new Date(2024, 11, 31);
    startDateInput.valueAsDate = startDate;
    endDateInput.valueAsDate = endDate;
}

    // 注：calculateGeoTiffMean 原先在本作用域内重复定义了一份，与文件顶层的全局实现逐字相同。
    // 已删除局部副本，统一复用顶层实现（见本文件 `async function calculateGeoTiffMean`）。

    // 初始化页面
    loadModels();
    initializeDatePickers();
    
    // 初始化模拟侧边栏下拉菜单功能
    initializeSimulateDropdown();
});

// 模拟侧边栏下拉菜单功能
function initializeSimulateDropdown() {
    const simulateDropdown = document.getElementById('simulate-dropdown');
    const simulateSidebar = document.getElementById('simulate-sidebar');
    const simulateSidebarTitle = document.getElementById('simulate-sidebar-title');
    const simulateSidebarClose = document.getElementById('simulate-sidebar-close');
    const runoffCategory = document.getElementById('runoff-category-sidebar');
    const floodCategory = document.getElementById('flood-category-sidebar');
    const floodSimulateCategory = document.getElementById('flood-simulate-category-sidebar');
    const snowSimulateCategory = document.getElementById('snow-simulate-category-sidebar');
    const iceSimulateCategory = document.getElementById('ice-simulate-category-sidebar');
    const permafrostSimulateCategory = document.getElementById('permafrost-simulate-category-sidebar');
    const simulateSidebarMask = document.getElementById('simulate-sidebar-mask');
    
    // 当前激活的类别
    let activeCategory = null;
    
    // 类别名称映射
    const categoryNames = {
        'runoff': '径流模拟',
        'flood': '洪水淹没模拟',
        'flood-simulate': '洪水灾害过程模拟',
        'snow-simulate': '积雪灾害过程模拟',
        'ice-simulate': '冰川灾害过程模拟',
        'permafrost-simulate': '冻土灾害过程模拟'
    };
    // 右侧栏标题图标代表模块本身（过程模拟），不随具体模拟类型变化
    const titleIcon = 'fa-play-circle';
    const titleColor = '#4ade80';
    function setSidebarTitle(key) {
        const name = categoryNames[key] || '灾害过程模拟';
        simulateSidebarTitle.innerHTML = `<i class="fa ${titleIcon} rhs-title-icon" style="color:${titleColor}"></i>${name}`;
    }
    
    // 显示模拟侧边栏
    function showSimulateSidebar() {
        simulateSidebar.classList.add('active');
        if (simulateSidebarMask) simulateSidebarMask.classList.add('active');
        // 如果有之前选中的类别，则恢复显示
        if (activeCategory) {
            restoreCategoryContent();
        }
    }
    
    // 恢复类别内容
    function restoreCategoryContent() {
        // 隐藏所有类别
        runoffCategory.style.display = 'none';
        floodCategory.style.display = 'none';
        floodSimulateCategory.style.display = 'none';
        snowSimulateCategory.style.display = 'none';
        iceSimulateCategory.style.display = 'none';
        permafrostSimulateCategory.style.display = 'none';
        
        // 恢复选中的类别
        if (activeCategory === 'flood-simulate') {
            floodSimulateCategory.style.display = 'block';
        } else if (activeCategory === 'snow-simulate') {
            snowSimulateCategory.style.display = 'block';
        } else if (activeCategory === 'ice-simulate') {
            iceSimulateCategory.style.display = 'block';
        } else if (activeCategory === 'permafrost-simulate') {
            permafrostSimulateCategory.style.display = 'block';
        } else if (activeCategory === 'runoff') {
            runoffCategory.style.display = 'block';
        } else if (activeCategory === 'flood') {
            floodCategory.style.display = 'block';
        }
        
        // 更新标题
        if (categoryNames[activeCategory]) {
            setSidebarTitle(activeCategory);
        }
    }
    
    // 隐藏模拟侧边栏（只隐藏侧边栏，保留类别状态）
    function hideSimulateSidebar() {
        simulateSidebar.classList.remove('active');
        if (simulateSidebarMask) simulateSidebarMask.classList.remove('active');
        // 注意：不再隐藏类别内容，保留activeCategory状态
    }
    
    // 切换类别显示
    function toggleCategory(category) {
        // 隐藏所有类别
        runoffCategory.style.display = 'none';
        floodCategory.style.display = 'none';
        floodSimulateCategory.style.display = 'none';
        snowSimulateCategory.style.display = 'none';
        iceSimulateCategory.style.display = 'none';
        permafrostSimulateCategory.style.display = 'none';
        
        // 显示选中的类别
        if (category === 'flood-simulate') {
            floodSimulateCategory.style.display = 'block';
            activeCategory = 'flood-simulate';
        } else if (category === 'snow-simulate') {
            snowSimulateCategory.style.display = 'block';
            activeCategory = 'snow-simulate';
        } else if (category === 'ice-simulate') {
            iceSimulateCategory.style.display = 'block';
            activeCategory = 'ice-simulate';
        } else if (category === 'permafrost-simulate') {
            permafrostSimulateCategory.style.display = 'block';
            activeCategory = 'permafrost-simulate';
        }
        
        // 更新动态标题
        setSidebarTitle(category);
        
        // 显示侧边栏
        showSimulateSidebar();
    }
    
    // 显示/隐藏下拉菜单
    function toggleDropdown() {
        if (simulateDropdown.classList.contains('active')) {
            hideDropdown();
        } else {
            showDropdown();
        }
    }
    
    // 显示下拉菜单
    function showDropdown() {
        simulateDropdown.classList.add('active');
    }
    
    // 隐藏下拉菜单
    function hideDropdown() {
        simulateDropdown.classList.remove('active');
    }
    
    // 注册导航栏下拉项点击处理（由 main.js 统一导航调用）
    window.applyNavCategory = (category) => {
        // 高亮对应的下拉菜单项
        document.querySelectorAll('#simulate-dropdown .dropdown-item').forEach(i => {
            i.classList.toggle('active', i.dataset.category === category);
        });
        // 侧边栏已打开且点击的是当前分类 -> 收起；否则打开/切换
        if (simulateSidebar.classList.contains('active') && activeCategory === category) {
            hideSimulateSidebar();
        } else {
            toggleCategory(category);
        }
    };
    
    // 关闭按钮点击事件
    simulateSidebarClose.addEventListener('click', function(e) {
        e.preventDefault();
        hideSimulateSidebar();
    });

    // 侧边栏遮罩（点击关闭）
    if (simulateSidebarMask) {
        simulateSidebarMask.addEventListener('click', function() {
            hideSimulateSidebar();
        });
    }

    // Esc 关闭
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && simulateSidebar.classList.contains('active')) {
            hideSimulateSidebar();
        }
    });
    
    // 初始化：默认不显示侧边栏，等待用户点击
    // toggleCategory('runoff');
}

// 初始化功能
document.addEventListener('DOMContentLoaded', function() {
    initializeFloodSimulation();
    initializeFloodSimulationModule();
    initializeSnowSimulationModule();
    initializeIceSimulationModule();
    initializePermafrostSimulationModule();
    initializeFloodSubmoduleTabs();
    initSnowmeltFloodIdentify();
});

// 融雪洪水识别功能
function initSnowmeltFloodIdentify() {
    // 加载流域列表
    loadSnowmeltFloodBasinOptions();
    
    // 设置默认日期范围为 2024-06-01 至 2024-07-01
    const defaultStart = '2024-06-01';
    const defaultEnd = '2024-07-01';
    
    // 使用原生JavaScript设置日期
    const startDateInput = document.getElementById('flood-snowmelt-start-date');
    const endDateInput = document.getElementById('flood-snowmelt-end-date');
    
    if (startDateInput) {
        startDateInput.value = defaultStart;
    }
    if (endDateInput) {
        endDateInput.value = defaultEnd;
    }
    
    // 绑定开始识别按钮事件
    const startButton = document.getElementById('start-flood-snowmelt-identify');
    if (startButton) {
        startButton.addEventListener('click', function() {
            startSnowmeltFloodIdentify();
        });
    }
    
    console.log('洪水识别模块初始化完成');
}

// 加载洪水识别流域选择选项到下拉框
function loadSnowmeltFloodBasinOptions() {
    loadBasinsToSelect('flood-snowmelt-basin-select');
}

function startSnowmeltFloodIdentify() {
    // 获取参数
    const basinSelect = document.getElementById('flood-snowmelt-basin-select');
    const modelSelect = document.getElementById('flood-snowmelt-model-select');
    const startDateInput = document.getElementById('flood-snowmelt-start-date');
    const endDateInput = document.getElementById('flood-snowmelt-end-date');
    
    const basinId = basinSelect ? basinSelect.value : '';
    const modelName = modelSelect ? modelSelect.value : '';
    const startDate = startDateInput ? startDateInput.value : '';
    const endDate = endDateInput ? endDateInput.value : '';
    const basinParam = (basinId && basinId !== 'all') ? basinId : null; // 全部流域→null
    
    // 参数校验（"全部流域" all 为合法值）
    if (!basinId) {
        uiMsg('请选择研究流域');
        return;
    }
    
    if (!modelName) {
        uiMsg('请选择识别模型');
        return;
    }
    
    if (!startDate || !endDate) {
        uiMsg('请选择日期范围');
        return;
    }
    
    // 检查日期顺序
    if (new Date(startDate) > new Date(endDate)) {
        uiMsg('模拟起始日期不能晚于模拟结束日期');
        return;
    }
    
    // 显示加载状态
    const startButton = document.getElementById('start-flood-snowmelt-identify');
    if (startButton) {
        startButton.disabled = true;
        startButton.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> 识别中...';
    }
    
    // 显示加载遮罩
    const loadingOverlay = document.getElementById('loading-overlay');
    if (loadingOverlay) {
        loadingOverlay.style.display = 'flex';
    }
    
    // 调用后端API
    fetch('/api/snowmelt/identify', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            basin_id: basinParam,
            model_name: modelName,
            start_date: startDate,
            end_date: endDate
        })
    })
    .then(response => {
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.json();
    })
    .then(response => {
        console.log('融雪洪水识别完成:', response);
        
        // 显示统计信息
        const basinText = basinSelect ? (basinSelect.selectedOptions[0]?.text || '') : '';
        showSnowmeltFloodResult(response, `${startDate} 至 ${endDate} | ${basinText}`);
        
        // 显示洪水日期列表（包含折线图）
        displaySnowmeltFloodResults(response);
        
        // 将所有洪水结果添加到循环播放列表并自动开始播放
        if (response.urls && response.urls.length > 0) {
            // 清空之前的播放列表
            window.tifFileList = [];
            window.currentLoopIndex = 0;
            
            // 添加所有结果到播放列表
            response.urls.forEach((url, index) => {
                window.tifFileList.push({
                    filePath: url,
                    variable: 'snowmelt',
                    date: response.dates_processed[index]
                });
            });
            
            // 第一个图显示3秒后再开始播放，3秒/帧
            autoPlayAfterLoad(response.urls[0], 'snowmelt', response.dates_processed[0], 3000);
        }
        
        // 恢复按钮状态
        if (startButton) {
            startButton.disabled = false;
            startButton.innerHTML = '<i class="fa fa-play mr-2"></i>执行洪水识别';
        }
        
        // 隐藏加载遮罩
        if (loadingOverlay) {
            loadingOverlay.style.display = 'none';
        }
    })
    .catch(error => {
        console.error('融雪洪水识别失败:', error);
        
        // 恢复按钮状态
        if (startButton) {
            startButton.disabled = false;
            startButton.innerHTML = '<i class="fa fa-play mr-2"></i>执行洪水识别';
        }
        
        // 隐藏加载遮罩
        if (loadingOverlay) {
            loadingOverlay.style.display = 'none';
        }
        
        uiMsg(`识别失败: ${error.message}`, 'error');
    });
}

function showSnowmeltFloodResult(response, sub) {
    if (response.status !== 'success') return;

    _showSimResultModal('融雪洪水识别结果', sub || '洪水灾害过程模拟 · 洪水识别');
    const resultStats = document.getElementById('sim-result-stats');
    const noTip = document.getElementById('sim-result-no-tip');
    if (!resultStats) return;

    // 使用 UI 组件库渲染统计卡片（统计卡片 + 环形进度 + 徽章）
    if (resultStats) {
        resultStats.innerHTML = '';

        const panel = document.createElement('div');
        panel.className = 'ui-card ui-fade-in';
        panel.innerHTML = `<h4 class="ui-card-title"><i class="fa fa-bar-chart"></i>洪水识别统计信息</h4>`;

        // 顶部信息行：日期范围 / 洪水天数徽章 + 洪水概率环形进度
        const topRow = document.createElement('div');
        topRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:14px;';
        topRow.innerHTML = `
            <div style="font-size:13px;color:var(--text-secondary);line-height:2;">
                <div><i class="fa fa-calendar" style="color:var(--ice);margin-right:4px;"></i>日期范围：<span style="color:#cbd5e1;">${response.start_date} 至 ${response.end_date}</span></div>
                <div><i class="fa fa-database" style="color:var(--ice);margin-right:4px;"></i>洪水天数：${UI.badge((response.flood_days || 0).toLocaleString() + ' 天', 'danger')}</div>
            </div>
        `;
        const ringWrap = document.createElement('div');
        ringWrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;';
        const pct = Math.round((response.flood_probability || 0) * 1000) / 10;
        const ringColor = response.flood_probability > 0.3
            ? '#f87171'
            : (response.flood_probability > 0.1 ? '#fbbf24' : 'var(--primary)');
        ringWrap.appendChild(UI.ring(pct, {
            size: 84,
            color: ringColor,
            label: pct.toFixed(1) + '%',
            sub: '洪水概率'
        }));
        topRow.appendChild(ringWrap);
        panel.appendChild(topRow);

        // 统计卡片网格（覆盖全部统计项：总天数/有效天数/洪水天数/平均洪水比例/平均融雪径流）
        const gridHtml = UI.statGrid([
            { label: '总天数', value: (response.total_days || 0).toLocaleString(), unit: '天', icon: 'fa-calendar-check-o', accent: 'ice' },
            { label: '有效天数', value: (response.valid_days || 0).toLocaleString(), unit: '天', icon: 'fa-check-circle', accent: 'success' },
            { label: '洪水累加天数', value: (response.flood_days || 0).toLocaleString(), unit: '天', icon: 'fa-exclamation-triangle', accent: 'danger' },
            { label: '平均洪水比例', value: ((response.avg_flood_ratio || 0) * 100).toFixed(2), unit: '%', icon: 'fa-percent', accent: 'warning' },
            { label: '平均融雪径流', value: response.avg_mean_value !== null && response.avg_mean_value !== undefined ? response.avg_mean_value.toFixed(2) : 'N/A', unit: response.avg_mean_value !== null && response.avg_mean_value !== undefined ? 'mm' : '', icon: 'fa-tint', accent: 'ice' }
        ]);
        const gridHolder = document.createElement('div');
        gridHolder.innerHTML = gridHtml;
        panel.appendChild(gridHolder.firstElementChild);

        resultStats.appendChild(panel);
    }
        
        // 绘制折线图（当有效数据点≥2时）
        const floodDates = response.flood_dates || [];
        const dateList = response.dates_processed || [];
        const chartData = [];
        
        floodDates.forEach((flood, i) => {
            if (flood.mean_value !== null && flood.mean_value !== 'N/A') {
                chartData.push({
                    // 防御：日期缺失时回退到 dates_processed 或序号，避免 X 轴出现 undefined
                    date: flood.date || dateList[i] || `第${i + 1}天`,
                    value: parseFloat(flood.mean_value)
                });
            }
        });
        
        if (chartData.length >= 2) {
            const oldChart = document.getElementById('snowmelt-flood-chart');
            if (oldChart) oldChart.remove();
            
            const chartContainer = document.createElement('div');
            chartContainer.id = 'snowmelt-flood-chart';
            chartContainer.style.width = '100%';
            chartContainer.style.height = '300px';
            chartContainer.style.marginTop = '15px';
            
            resultStats.appendChild(chartContainer);
            
            const chart = echarts.init(chartContainer);
            
            const option = {
                title: {
                    text: '融雪径流（mm）',
                    left: 'center',
                    textStyle: {
                        color: '#93c5fd',
                        fontSize: 16
                    }
                },
                tooltip: {
                    trigger: 'axis',
                    backgroundColor: 'rgba(30, 41, 59, 0.9)',
                    borderColor: '#334155',
                    textStyle: {
                        color: '#e2e8f0'
                    }
                },
                grid: {
                    left: '3%',
                    right: '4%',
                    bottom: '3%',
                    containLabel: true
                },
                xAxis: {
                    type: 'category',
                    boundaryGap: false,
                    data: chartData.map(item => item.date),
                    axisLabel: {
                        color: '#94a3b8',
                        rotate: 45
                    },
                    axisLine: {
                        lineStyle: {
                            color: '#334155'
                        }
                    },
                    name: '日期',
                    nameTextStyle: {
                        color: '#94a3b8'
                    }
                },
                yAxis: {
                    type: 'value',
                    axisLabel: {
                        color: '#94a3b8',
                        formatter: '{value} mm'
                    },
                    axisLine: {
                        lineStyle: {
                            color: '#334155'
                        }
                    },
                    splitLine: {
                        lineStyle: {
                            color: '#334155',
                            type: 'dashed'
                        }
                    },
                    name: '融雪径流量 (mm)',
                    nameTextStyle: {
                        color: '#94a3b8'
                    }
                },
                series: [{
                    name: '融雪径流',
                    type: 'line',
                    smooth: true,
                    data: chartData.map(item => item.value),
                    lineStyle: {
                        color: '#4ade80',
                        width: 2
                    },
                    itemStyle: {
                        color: '#4ade80'
                    },
                    areaStyle: {
                        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                            { offset: 0, color: 'rgba(74, 222, 128, 0.3)' },
                            { offset: 1, color: 'rgba(74, 222, 128, 0.05)' }
                        ])
                    }
                }]
            };
            
            chart.setOption(option);
            _trackSimChart(chart);
            
            window.addEventListener('resize', function() {
                chart.resize();
            });
        }

    if (noTip) {
        noTip.style.display = response.flood_days > 0 ? 'none' : 'block';
    }
}



function drawLineChart(containerId, title, data, yAxisName, unit) {
    const oldChart = document.getElementById(containerId);
    if (oldChart) oldChart.remove();
    
    const chartContainer = document.createElement('div');
    chartContainer.id = containerId;
    chartContainer.className = 'ui-fade-in';
    chartContainer.style.width = '100%';
    chartContainer.style.height = '300px';
    chartContainer.style.marginTop = '15px';
    
    // 挂载到模拟结果弹窗的统计区容器（固定 id），原 replace 逻辑生成的 id 不存在导致图表未显示
    const parentContainer = document.getElementById('sim-result-stats');
    if (parentContainer) {
        parentContainer.appendChild(chartContainer);
    }
    
    const chart = echarts.init(chartContainer);
    
    const option = {
        title: {
            text: title,
            left: 'center',
            textStyle: {
                color: '#93c5fd',
                fontSize: 16
            }
        },
        tooltip: {
            trigger: 'axis',
            backgroundColor: 'rgba(30, 41, 59, 0.9)',
            borderColor: '#334155',
            textStyle: {
                color: '#e2e8f0'
            }
        },
        grid: {
            left: '3%',
            right: '4%',
            bottom: '3%',
            containLabel: true
        },
        xAxis: {
            type: 'category',
            boundaryGap: false,
            data: data.map(item => item.date),
            axisLabel: {
                color: '#94a3b8',
                rotate: 45
            },
            axisLine: {
                lineStyle: {
                    color: '#334155'
                }
            },
            name: '日期',
            nameTextStyle: {
                color: '#94a3b8'
            }
        },
        yAxis: {
            type: 'value',
            axisLabel: {
                color: '#94a3b8',
                formatter: unit ? `{value} ${unit}` : '{value}'
            },
            axisLine: {
                lineStyle: {
                    color: '#334155'
                }
            },
            splitLine: {
                lineStyle: {
                    color: '#334155',
                    type: 'dashed'
                }
            },
            name: yAxisName,
            nameTextStyle: {
                color: '#94a3b8'
            }
        },
        series: [{
            name: title,
            type: 'line',
            smooth: true,
            data: data.map(item => item.value),
            lineStyle: {
                color: '#4ade80',
                width: 2
            },
            itemStyle: {
                color: '#4ade80'
            },
            areaStyle: {
                color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                    { offset: 0, color: 'rgba(74, 222, 128, 0.5)' },
                    { offset: 1, color: 'rgba(74, 222, 128, 0.05)' }
                ])
            }
        }]
    };
    
    chart.setOption(option);
    _trackSimChart(chart);
    
    window.addEventListener('resize', function() {
        chart.resize();
    });
}

function displaySnowmeltFloodResults(response) {
    const resultTable = document.getElementById('sim-result-table');
    const noTip = document.getElementById('sim-result-no-tip');

    if (!response || !response.urls || response.urls.length === 0) {
        if (noTip) {
            noTip.style.display = 'block';
            noTip.textContent = '暂无融雪洪水识别结果，请调整分析条件后重试';
        }
        return;
    }

    resultTable.className = 'ui-table';
    resultTable.innerHTML = '';

    const thead = document.createElement('thead');
    thead.innerHTML = `
        <tr>
            <th>日期</th>
            <th>均值(mm)</th>
            <th>操作</th>
        </tr>
    `;
    resultTable.appendChild(thead);
    
    const tbody = document.createElement('tbody');
    
    const dates = response.dates_processed || [];
    const urls = response.urls || [];
    
    dates.forEach((date, index) => {
        const row = document.createElement('tr');
        
        const meanValue = response.flood_dates[index]?.mean_value !== null ? response.flood_dates[index].mean_value.toFixed(2) : 'N/A';
        const isNA = meanValue === 'N/A';
        
        row.innerHTML = `
            <td>${date}</td>
            <td>${UI.badge(isNA ? 'N/A' : meanValue + ' mm', isNA ? 'default' : 'ice', { dot: false })}</td>
            <td>
                <button class="ui-btn ui-btn-primary ui-btn-sm" onclick="loadSnowmeltFloodLayer('${date}', '${urls[index]}')">
                    <i class="fa fa-map-marker mr-1"></i>加载到地图
                </button>
            </td>
        `;
        tbody.appendChild(row);
    });
    
    resultTable.appendChild(tbody);
}

window.loadSnowmeltFloodLayer = function(date, url) {
    console.log(`加载融雪洪水图层: ${date}, URL: ${url}`);
    
    loadGeoTiffLayer(url, 'snowmelt', date);
};

// 洪水灾害过程模拟子模块切换功能
function initializeFloodSubmoduleTabs() {
    const tabBtns = document.querySelectorAll('.flood-submodule-tabs .tab-btn');
    const tabContents = document.querySelectorAll('.flood-submodule-content');
    
    tabBtns.forEach(btn => {
        btn.addEventListener('click', function() {
            const targetTab = this.getAttribute('data-tab');
            
            // 移除所有按钮的active类
            tabBtns.forEach(b => b.classList.remove('active'));
            // 隐藏所有内容
            tabContents.forEach(content => {
                content.classList.remove('active');
                content.style.display = 'none';
            });
            
            // 激活当前按钮
            this.classList.add('active');
            // 显示对应内容
            const targetContent = document.getElementById(targetTab);
            if (targetContent) {
                targetContent.classList.add('active');
                targetContent.style.display = 'block';
            }
        });
    });
    
    // 默认显示第一个标签页
    if (tabContents.length > 0) {
        tabContents[0].style.display = 'block';
    }
    
    // 初始化洪水灾害过程模拟功能
    initializeFloodSimulationModule();
}

// 洪水灾害过程模拟功能
function initializeFloodSimulationModule() {
    // 幂等保护：该函数会被 DOMContentLoaded 直接调用一次，
    // 又会被 initializeFloodSubmoduleTabs() 再调用一次；
    // 若不防重入，start-flood-runoff-simulate 按钮的 click 监听会绑定两次，
    // 用户点一次按钮就会并发发出两个相同的 POST /api/simulate/runoff。
    if (window.__floodSimModuleInited) return;
    window.__floodSimModuleInited = true;
    // 洪水径流模拟子模块
    const floodRunoffModelSelect = document.getElementById('flood-runoff-model-select');
    const floodRunoffStartDate = document.getElementById('flood-runoff-start-date');
    const floodRunoffEndDate = document.getElementById('flood-runoff-end-date');
    const startFloodRunoffSimulateBtn = document.getElementById('start-flood-runoff-simulate');
    const floodRunoffResultTable = document.getElementById('flood-runoff-result-table');
    const noFloodRunoffResultTip = document.getElementById('no-flood-runoff-result-tip');
    
    // 洪水淹没模拟子模块
    const floodInundationThresholdSelect = document.getElementById('flood-inundation-threshold-select');
    const floodInundationStartDate = document.getElementById('flood-inundation-start-date');
    const floodInundationEndDate = document.getElementById('flood-inundation-end-date');
    const startFloodInundationAnalysisBtn = document.getElementById('start-flood-inundation-analysis');
    const floodInundationResultTable = document.getElementById('flood-inundation-result-table');
    const noFloodInundationResultTip = document.getElementById('no-flood-inundation-result-tip');
    // 评估页串联：若从"风险评估-缺少淹没数据"引导而来，预填日期并自动切到对应子步骤
    try {
        const pending = sessionStorage.getItem('pendingFloodSim');
        if (pending) {
            const p = JSON.parse(pending);
            sessionStorage.removeItem('pendingFloodSim');
            if (p && p.start && p.end) {
                floodInundationStartDate.value = p.start;
                floodInundationEndDate.value = p.end;
                if (p.missing_step === 'runoff') {
                    floodRunoffStartDate.value = p.start;
                    floodRunoffEndDate.value = p.end;
                }
                const targetTab = (p.missing_step === 'runoff') ? 'runoff-tab' : 'inundation-tab';
                const tabBtn = document.querySelector(`.flood-submodule-tabs .tab-btn[data-tab="${targetTab}"]`);
                if (tabBtn) tabBtn.click();
            }
        }
    } catch (e) { /* 预填失败不影响正常加载 */ }
    // 加载径流模拟/淹没模拟流域选择（"全部流域" value=all 保留为默认）
    loadBasinsToSelect('basin-select');
    loadBasinsToSelect('flood-inundation-basin-select');
    
    // 初始化洪水径流模拟日期选择器（默认 2024-06-01 至 2024-07-01）
    function initializeFloodRunoffDatePickers() {
        floodRunoffStartDate.value = '2024-06-01';
        floodRunoffEndDate.value = '2024-07-01';
    }
    
    // 初始化洪水淹没模拟日期选择器（默认 2024-06-01 至 2024-07-01）
    function initializeFloodInundationDatePickers() {
        floodInundationStartDate.value = '2024-06-01';
        floodInundationEndDate.value = '2024-07-01';
    }
    
    // 加载径流模型列表
    async function loadFloodRunoffModels() {
        try {
            const res = await fetch('/api/simulate/models');
            if (!res.ok) throw new Error(`接口请求失败: ${res.status}`);
            const models = await res.json();
            if (!Array.isArray(models) || models.length === 0) throw new Error('无可用模型');
            
            floodRunoffModelSelect.innerHTML = '';
            const defaultOption = document.createElement('option');
            defaultOption.value = '';
            defaultOption.textContent = '-- 请选择径流模拟模型 --';
            floodRunoffModelSelect.appendChild(defaultOption);

            models.forEach(name => {
                const opt = document.createElement('option');
                opt.value = name;
                if (name === 'lstm_runoff_model.pt') {
                    opt.textContent = '长短期记忆网络（LSTM）模型';
                } else {
                    opt.textContent = name; 
                }
                floodRunoffModelSelect.appendChild(opt);
            });
            // 默认选中第一个模型（LSTM）
            if (floodRunoffModelSelect.options.length > 1) {
                floodRunoffModelSelect.selectedIndex = 1;
            }
        } catch (e) {
            floodRunoffModelSelect.innerHTML = '<option>加载失败</option>';
            console.error('径流模型列表加载失败:', e);
        }
    }
    
    // 加载洪水阈值列表
    async function loadFloodInundationThresholds() {
        try {
            const response = await fetch('/api/simulate/flood/thresholds');
            if (!response.ok) {
                throw new Error('获取阈值列表失败');
            }
            const thresholds = await response.json();
            
            floodInundationThresholdSelect.innerHTML = '<option value="">-- 请选择洪水阈值 --</option>';
            
            thresholds.forEach(threshold => {
                const option = document.createElement('option');
                option.value = threshold;
                option.textContent = _thresholdLabel(threshold); // 中英文映照显示
                floodInundationThresholdSelect.appendChild(option);
            });
            // 默认选中第一个阈值
            if (floodInundationThresholdSelect.options.length > 1) {
                floodInundationThresholdSelect.selectedIndex = 1;
            }
        } catch (error) {
            console.error('加载阈值列表失败:', error);
            floodInundationThresholdSelect.innerHTML = '<option value="">-- 阈值加载失败 --</option>';
        }
    }
    
    // 洪水灾害过程模拟洪水径流模拟
    startFloodRunoffSimulateBtn.addEventListener('click', async function() {
        const model = floodRunoffModelSelect.value;
        const startDate = floodRunoffStartDate.value;
        const endDate = floodRunoffEndDate.value;
        const selectedBasin = document.getElementById('basin-select').value; // 洪水灾害过程模拟-径流模拟 tab 的流域选择
        const basinParam = (selectedBasin && selectedBasin !== 'all') ? selectedBasin : null; // 全部流域→null
        
        if (!model || !startDate || !endDate) {
            uiMsg('请选择径流模拟模型和日期范围');
            return;
        }
        
        const start = new Date(startDate);
        const end = new Date(endDate);
        
        if (start > end) {
            uiMsg('模拟起始日期不能晚于模拟结束日期');
            return;
        }

        // 与径流模拟入口共用同一接口，运行中禁止重复提交
        if (window.runoffApiBusy) {
            uiMsg('已有径流模拟任务在运行，请等待其完成后再提交', 'error');
            return;
        }
        window.runoffApiBusy = true;

        // 显示加载状态
        startFloodRunoffSimulateBtn.disabled = true;
        startFloodRunoffSimulateBtn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> 模拟中...';

        try {
            const response = await fetch('/api/simulate/runoff', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: model,
                    start_date: startDate,
                    end_date: endDate,
                    basin_id: basinParam  // 全部流域→null
                })
            });

            if (!response.ok) {
                // 解析后端错误信息（如 409 已有任务在运行），而不是只给状态码
                let errMsg = `径流模拟请求失败: ${response.status} ${response.statusText}`;
                try {
                    const errBody = await response.json();
                    if (errBody && errBody.error) errMsg = errBody.error;
                } catch (e) { /* 响应体非 JSON 时保留默认提示 */ }
                throw new Error(errMsg);
            }

            const result = await response.json();

            if (result.status === 'success') {
                // 处理洪水径流模拟结果
                const results = result.data.files.map(filePath => {
                    const dateMatch = filePath.match(/(\d{4}-\d{2}-\d{2})/);
                    const date = dateMatch ? dateMatch[1] : '未知日期';

                    return {
                        variable: 'runoff',
                        date: date,
                        meanValue: '计算中...',
                        filePath: filePath
                    };
                });

                // 计算每个文件的均值
                const resultsWithMeans = await Promise.all(results.map(async (item) => {
                    try {
                        const meanValue = await calculateGeoTiffMean(item.filePath);
                        return {
                            ...item,
                            meanValue: meanValue !== null ? meanValue.toFixed(2) : '计算失败'
                        };
                    } catch (error) {
                        console.error(`计算均值失败: ${item.filePath}`, error);
                        return {
                            ...item,
                            meanValue: '计算失败'
                        };
                    }
                }));

                const runoffBasinText = document.getElementById('basin-select').selectedOptions[0]?.text || '';
                displayFloodRunoffResults(resultsWithMeans, `${startDate} 至 ${endDate} | ${runoffBasinText}`);

                // 与洪水识别/淹没模拟入口一致：所有结果入列并自动开始播放
                if (result.data && result.data.files && result.data.files.length > 0) {
                    window.tifFileList = [];
                    window.currentLoopIndex = 0;
                    result.data.files.forEach(filePath => {
                        const dateMatch = filePath.match(/(\d{4}-\d{2}-\d{2})/);
                        window.tifFileList.push({
                            filePath: filePath,
                            variable: 'runoff',
                            date: dateMatch ? dateMatch[1] : '未知日期'
                        });
                    });
                    // 第一个图显示3秒后再开始播放，3秒/帧
                    autoPlayAfterLoad(result.data.files[0], 'runoff', window.tifFileList[0].date, 3000);
                }
            } else {
                throw new Error(result.error || '径流模拟失败');
            }
        } catch (error) {
            console.error('径流模拟功能出错:', error);
            uiMsg(`径流模拟失败: ${error.message}`, 'error');
        } finally {
            // 恢复按钮状态
            startFloodRunoffSimulateBtn.innerHTML = '<i class="fa fa-play mr-2"></i>执行径流模拟';
            startFloodRunoffSimulateBtn.disabled = false;
            window.runoffApiBusy = false;
        }
    });

    // 洪水灾害过程模拟淹没分析
    startFloodInundationAnalysisBtn.addEventListener('click', async function() {
        const threshold = floodInundationThresholdSelect.value;
        const startDate = floodInundationStartDate.value;
        const endDate = floodInundationEndDate.value;
        const basinId = document.getElementById('flood-inundation-basin-select').value;
        const basinParam = (basinId && basinId !== 'all') ? basinId : null; // 全部流域→null
        
        if (!threshold || !startDate || !endDate) {
            uiMsg('请选择洪水阈值和日期范围');
            return;
        }
        
        const start = new Date(startDate);
        const end = new Date(endDate);
        
        if (start > end) {
            uiMsg('模拟起始日期不能晚于模拟结束日期');
            return;
        }
        
        // 显示加载状态
        startFloodInundationAnalysisBtn.disabled = true;
        startFloodInundationAnalysisBtn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> 分析中...';
        
        try {
            const response = await fetch('/api/simulate/flood-inundation', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    threshold: threshold,
                    start_date: startDate,
                    end_date: endDate,
                    basin_id: basinParam
                })
            });
            
            if (response.ok) {
                const result = await response.json();
                
                if (result.status === 'success') {
                    const inundationBasinText = document.getElementById('flood-inundation-basin-select').selectedOptions[0]?.text || '';
                    displayFloodInundationResults(result, `${startDate} 至 ${endDate} | ${inundationBasinText}`);
                    
                    // 将所有洪水淹没结果添加到循环播放列表并自动开始播放
                    if (result.urls && result.urls.length > 0) {
                        window.tifFileList = [];
                        window.currentLoopIndex = 0;
                        
                        result.urls.forEach((url, index) => {
                            window.tifFileList.push({
                                filePath: url,
                                variable: 'flood',
                                date: result.dates_processed[index]
                            });
                        });
                        
                        // 第一个图显示3秒后再开始播放，3秒/帧（原2秒/帧仍偏快）
                        autoPlayAfterLoad(result.urls[0], 'flood', result.dates_processed[0], 3000);
                    }
                } else {
                    throw new Error(result.error || '淹没模拟失败');
                }
            } else {
                throw new Error('淹没模拟请求失败');
            }
        } catch (error) {
            console.error('淹没模拟功能出错:', error);
            uiMsg(`淹没模拟失败: ${error.message}`, 'error');
        } finally {
            // 恢复按钮状态
            startFloodInundationAnalysisBtn.innerHTML = '<i class="fa fa-play mr-2"></i>执行淹没模拟';
            startFloodInundationAnalysisBtn.disabled = false;
        }
    });
    
    // 显示洪水径流模拟结果
    function displayFloodRunoffResults(results, sub) {
        _showSimResultModal('径流模拟结果', sub || '洪水灾害过程模拟 · 径流模拟');
        const resultStats = document.getElementById('sim-result-stats');
        const table = document.getElementById('sim-result-table');
        const thead = table.querySelector('thead');
        const tbody = table.querySelector('tbody');
        const noTip = document.getElementById('sim-result-no-tip');

        // 生成表头
        thead.innerHTML = '';
        const trHead = document.createElement('tr');
        const headers = ['变量', '日期', '均值', '操作'];
        headers.forEach(headerText => {
            const th = document.createElement('th');
            th.textContent = headerText;
            trHead.appendChild(th);
        });
        thead.appendChild(trHead);
        tbody.innerHTML = '';

        if (results.length === 0) {
            noTip.style.display = 'block';
            noTip.textContent = '暂无径流模拟结果，请调整模拟条件后重试';
            return;
        }

        // 绘制折线图（当有效数据点≥2时）
        const chartData = [];
        results.forEach(result => {
            const meanValue = parseFloat(result.meanValue);
            if (!isNaN(meanValue)) {
                chartData.push({
                    date: result.date,
                    value: meanValue
                });
            }
        });

        if (chartData.length >= 2 && resultStats) {
            drawLineChart('sim-result-chart', '径流（mm）', chartData, '径流量 (mm)', 'mm');
        }

        results.forEach(result => {
            const row = document.createElement('tr');

            const varCell = document.createElement('td');
            varCell.innerHTML = UI.badge('径流', 'ice', { dot: false });
            row.appendChild(varCell);

            const dateCell = document.createElement('td');
            dateCell.textContent = result.date;
            row.appendChild(dateCell);

            const valueCell = document.createElement('td');
            valueCell.innerHTML = UI.badge(String(result.meanValue) + ' mm', result.meanValue !== '计算失败' && result.meanValue !== '计算中...' ? 'info' : 'default', { dot: false });
            row.appendChild(valueCell);

            const actionCell = document.createElement('td');
            const loadBtn = document.createElement('button');
            loadBtn.innerHTML = '<i class="fa fa-map-marker mr-1"></i>加载';
            loadBtn.className = 'ui-btn ui-btn-primary ui-btn-sm';
            loadBtn.addEventListener('click', () => {
                loadGeoTiffLayer(result.filePath, 'runoff', result.date);
                // 添加到循环播放列表（同一文件不重复入列）
                if (!window.tifFileList.some(f => f.filePath === result.filePath)) {
                    window.tifFileList.push({
                        filePath: result.filePath,
                        variable: 'runoff',
                        date: result.date
                    });
                }
            });
            actionCell.appendChild(loadBtn);
            row.appendChild(actionCell);

            tbody.appendChild(row);
        });
    }
    
    // 显示洪水淹没模拟结果
    function displayFloodInundationResults(result, sub) {
        _showSimResultModal('洪水淹没模拟结果', sub || '洪水灾害过程模拟 · 淹没模拟');
        const resultStats = document.getElementById('sim-result-stats');
        const table = document.getElementById('sim-result-table');
        const thead = table.querySelector('thead');
        const tbody = table.querySelector('tbody');
        const noTip = document.getElementById('sim-result-no-tip');

        // 生成表头
        thead.innerHTML = '';
        const trHead = document.createElement('tr');
        
        const headers = ['日期', '淹没面积(km²)', '操作'];
        headers.forEach(headerText => {
            const th = document.createElement('th');
            th.textContent = headerText;
            trHead.appendChild(th);
        });
        
        thead.appendChild(trHead);
        tbody.innerHTML = '';

        const floodResults = result.flood_results || [];
        const validResults = floodResults.filter(r => r.has_flood);

        if (validResults.length === 0) {
            noTip.style.display = 'block';
            noTip.textContent = '暂无洪水淹没结果，请先进行分析';
            return;
        }

        noTip.style.display = 'none';

        if (resultStats) {
            resultStats.innerHTML = '';

            const panel = document.createElement('div');
            panel.className = 'ui-card ui-fade-in';
            panel.innerHTML = `<h4 class="ui-card-title"><i class="fa fa-tint"></i>洪水淹没统计信息</h4>`;

            // 顶部信息行：日期范围 / 洪水天数徽章 + 洪水概率环形进度
            const topRow = document.createElement('div');
            topRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:14px;';
            topRow.innerHTML = `
                <div style="font-size:13px;color:var(--text-secondary);line-height:2;">
                    <div><i class="fa fa-calendar" style="color:var(--ice);margin-right:4px;"></i>日期范围：<span style="color:#cbd5e1;">${result.start_date} 至 ${result.end_date}</span></div>
                    <div><i class="fa fa-database" style="color:var(--ice);margin-right:4px;"></i>洪水天数：${UI.badge((result.flood_days || 0).toLocaleString() + ' 天', 'danger')}</div>
                </div>
            `;
            const ringWrap = document.createElement('div');
            ringWrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;';
            const pct = Math.round((result.flood_probability || 0) * 1000) / 10;
            const ringColor = result.flood_probability > 0.3
                ? '#f87171'
                : (result.flood_probability > 0.1 ? '#fbbf24' : 'var(--primary)');
            ringWrap.appendChild(UI.ring(pct, {
                size: 84,
                color: ringColor,
                label: pct.toFixed(1) + '%',
                sub: '洪水概率'
            }));
            topRow.appendChild(ringWrap);
            panel.appendChild(topRow);

            // 统计卡片网格
            const gridHtml = UI.statGrid([
                { label: '总天数', value: (result.total_days || 0).toLocaleString(), unit: '天', icon: 'fa-calendar-check-o', accent: 'ice' },
                { label: '有效天数', value: (result.valid_days || 0).toLocaleString(), unit: '天', icon: 'fa-check-circle', accent: 'success' },
                { label: '洪水累加天数', value: (result.flood_days || 0).toLocaleString(), unit: '天', icon: 'fa-exclamation-triangle', accent: 'danger' },
                { label: '平均洪水比例', value: ((result.avg_flood_ratio || 0) * 100).toFixed(2), unit: '%', icon: 'fa-percent', accent: 'warning' },
                { label: '平均径流量', value: result.avg_mean_value !== null && result.avg_mean_value !== undefined ? result.avg_mean_value.toFixed(2) : 'N/A', unit: result.avg_mean_value !== null && result.avg_mean_value !== undefined ? 'mm' : '', icon: 'fa-tint', accent: 'ice' }
            ]);
            const gridHolder = document.createElement('div');
            gridHolder.innerHTML = gridHtml;
            panel.appendChild(gridHolder.firstElementChild);

            // 导出工具栏
            const exportToolbar = document.createElement('div');
            exportToolbar.style.cssText = 'display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;';
            exportToolbar.innerHTML = `
                <button type="button" class="ui-btn ui-btn-sm" id="flood-export-csv"><i class="fa fa-file-excel-o"></i> 导出淹没统计CSV</button>
                <button type="button" class="ui-btn ui-btn-sm" id="flood-download-tif"><i class="fa fa-download"></i> 下载结果GeoTIFF</button>
            `;
            exportToolbar.querySelector('#flood-export-csv').addEventListener('click', () => exportFloodCsv(result));
            exportToolbar.querySelector('#flood-download-tif').addEventListener('click', () => downloadFloodTifs(result));
            panel.appendChild(exportToolbar);

            resultStats.appendChild(panel);
        }
        
        // 绘制折线图（当有效数据点≥2时）
        const chartData = [];
        validResults.forEach((flood, i) => {
            if (flood.flood_area_km2 !== null && flood.flood_area_km2 > 0) {
                chartData.push({
                    // 防御：日期缺失时回退为序号，避免 X 轴出现 undefined
                    date: flood.date || `第${i + 1}天`,
                    value: Math.round(parseFloat(flood.flood_area_km2))
                });
            }
        });
        
        if (chartData.length >= 2 && resultStats) {
            const oldChart = document.getElementById('flood-inundation-chart');
            if (oldChart) oldChart.remove();
            
            const chartContainer = document.createElement('div');
            chartContainer.id = 'flood-inundation-chart';
            chartContainer.style.width = '100%';
            chartContainer.style.height = '300px';
            chartContainer.style.marginTop = '15px';
            
            resultStats.appendChild(chartContainer);
            
            const chart = echarts.init(chartContainer);
            
            const option = {
                title: {
                    text: '淹没面积（km²）',
                    left: 'center',
                    textStyle: {
                        color: '#93c5fd',
                        fontSize: 16
                    }
                },
                tooltip: {
                    trigger: 'axis',
                    backgroundColor: 'rgba(30, 41, 59, 0.9)',
                    borderColor: '#334155',
                    textStyle: {
                        color: '#e2e8f0'
                    }
                },
                grid: {
                    left: '3%',
                    right: '4%',
                    bottom: '3%',
                    containLabel: true
                },
                xAxis: {
                    type: 'category',
                    boundaryGap: false,
                    data: chartData.map(d => d.date),
                    axisLabel: {
                        color: '#94a3b8',
                        rotate: 45
                    },
                    axisLine: {
                        lineStyle: {
                            color: '#475569'
                        }
                    }
                },
                yAxis: {
                    type: 'value',
                    name: '淹没面积 (km²)',
                    nameTextStyle: {
                        color: '#94a3b8'
                    },
                    axisLabel: {
                        color: '#94a3b8'
                    },
                    axisLine: {
                        lineStyle: {
                            color: '#475569'
                        }
                    },
                    splitLine: {
                        lineStyle: {
                            color: '#334155',
                            type: 'dashed'
                        }
                    }
                },
                series: [{
                    name: '淹没面积',
                    type: 'line',
                    smooth: true,
                    data: chartData.map(d => d.value),
                    lineStyle: {
                        color: '#4ade80',
                        width: 2
                    },
                    itemStyle: {
                        color: '#4ade80'
                    },
                    areaStyle: {
                        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                            {offset: 0, color: 'rgba(74, 222, 128, 0.3)'},
                            {offset: 1, color: 'rgba(74, 222, 128, 0.05)'}
                        ])
                    }
                }]
            };
            
            chart.setOption(option);
            _trackSimChart(chart);
            
            window.addEventListener('resize', () => {
                chart.resize();
            });
        }
        
        validResults.forEach(flood => {
            const row = document.createElement('tr');
            
            const dateCell = document.createElement('td');
            dateCell.textContent = flood.date || '—';
            row.appendChild(dateCell);

            const areaCell = document.createElement('td');
            const area = flood.flood_area_km2 !== null ? Math.round(flood.flood_area_km2) : 'N/A';
            areaCell.innerHTML = UI.badge(String(area) + ' km²', area !== 'N/A' ? 'warning' : 'default', { dot: false });
            row.appendChild(areaCell);

            const actionCell = document.createElement('td');
            const loadBtn = document.createElement('button');
            loadBtn.innerHTML = '<i class="fa fa-map-marker mr-1"></i>加载';
            loadBtn.className = 'ui-btn ui-btn-primary ui-btn-sm';
            loadBtn.addEventListener('click', () => {
                loadGeoTiffLayer(flood.result_file, 'flood', flood.date);
            });
            actionCell.appendChild(loadBtn);
            row.appendChild(actionCell);

            tbody.appendChild(row);
        });
    }
    
    // 计算淹没面积（基于GeoTIFF文件）
    async function calculateInundationArea(url) {
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error('获取文件失败');
            
            const arrayBuffer = await response.arrayBuffer();
            const tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer);
            const image = await tiff.getImage();
            const data = await image.readRasters();
            
            // 计算非零像素数（淹没区域）
            const values = data[0];
            const nodata = image.getGDALNoData() || 0;
            const inundatedPixels = values.filter(v => v > 0 && v !== nodata).length;
            
            // 获取像素大小
            const transform = image.getImageWidth() > 0 ? image.getGeoTransform() : null;
            if (!transform) return null;
            
            const pixelWidth = Math.abs(transform[1]);
            const pixelHeight = Math.abs(transform[5]);
            
            // 假设是经纬度坐标系，使用椭球体面积公式计算
            const imageHeight = image.getImageHeight();
            const centerLat = (transform[3] + (transform[3] - pixelHeight * imageHeight)) / 2;
            const latRad = centerLat * Math.PI / 180;
            
            const metersPerDegLat = 111132.954 - 559.822 * Math.cos(2 * latRad) + 1.175 * Math.cos(4 * latRad);
            const metersPerDegLon = 111412.84 * Math.cos(latRad) - 93.5 * Math.cos(3 * latRad) + 0.118 * Math.cos(5 * latRad);
            
            const pixelAreaM2 = (pixelWidth * metersPerDegLon) * (pixelHeight * metersPerDegLat);
            const areaKm2 = (inundatedPixels * pixelAreaM2) / 1000000;
            
            return areaKm2;
        } catch (error) {
            console.error('计算淹没面积失败:', error);
            return null;
        }
    }
    
    // 初始化
    initializeFloodRunoffDatePickers();
    initializeFloodInundationDatePickers();
    loadFloodRunoffModels();
    loadFloodInundationThresholds();
}

// 洪水淹没模拟功能
function initializeFloodSimulation() {
    // 侧边栏元素
    const thresholdSelect = document.getElementById('threshold-select');
    const floodStartDate = document.getElementById('flood-start-date');
    const floodEndDate = document.getElementById('flood-end-date');
    const startAnalysisBtn = document.getElementById('start-analysis');
    const floodResultTable = document.getElementById('flood-result-table');
    const noFloodResultTip = document.getElementById('no-flood-result-tip');
    
    // 主内容区域元素
    const thresholdSelectMain = document.getElementById('threshold-select-main');
    const floodStartDateMain = document.getElementById('flood-start-date-main');
    const floodEndDateMain = document.getElementById('flood-end-date-main');
    const startAnalysisBtnMain = document.getElementById('start-analysis-main');
    const floodResultTableMain = document.getElementById('flood-result-table-main');
    const noFloodResultTipMain = document.getElementById('no-flood-result-tip-main');
    
    // 从后端API获取阈值列表
    function loadThresholds() {
        fetch('/api/simulate/flood/thresholds')
            .then(response => {
                if (!response.ok) {
                    throw new Error('获取阈值列表失败');
                }
                return response.json();
            })
            .then(thresholds => {
                // 清空现有选项
                thresholdSelect.innerHTML = '<option value="">-- 请选择洪水阈值 --</option>';
                thresholdSelectMain.innerHTML = '<option value="">-- 请选择洪水阈值 --</option>';
                
                // 添加阈值选项
                thresholds.forEach(threshold => {
                    const option = document.createElement('option');
                    option.value = threshold;
                    option.textContent = _thresholdLabel(threshold); // 中英文映照显示
                    thresholdSelect.appendChild(option);
                    
                    const optionMain = document.createElement('option');
                    optionMain.value = threshold;
                    optionMain.textContent = _thresholdLabel(threshold); // 中英文映照显示
                    thresholdSelectMain.appendChild(optionMain);
                });
                
                console.log('阈值列表加载成功:', thresholds);
            })
            .catch(error => {
                console.error('加载阈值列表失败:', error);
                // 如果API调用失败，显示错误信息
                thresholdSelect.innerHTML = '<option value="">-- 阈值加载失败 --</option>';
                thresholdSelectMain.innerHTML = '<option value="">-- 阈值加载失败 --</option>';
            });
    }
    
    // 洪水淹没分析函数（侧边栏与主区两个入口共用，需互斥，避免并发重入）
    let floodInundationRunning = false;
    function analyzeFloodInundation(threshold, startDate, endDate, resultTable, noResultTip, analysisBtn) {
        if (floodInundationRunning) {
            uiMsg('洪水淹没分析正在进行中，请稍候…');
            return;
        }
        floodInundationRunning = true;
        // 两个入口按钮互斥，避免同一次操作触发两次请求抢同一批输出文件
        const _floodBtns = [analysisBtn, startAnalysisBtn, startAnalysisBtnMain].filter(Boolean);
        _floodBtns.forEach(b => { b.disabled = true; });
        if (!threshold || !startDate || !endDate) {
            _floodBtns.forEach(b => { b.disabled = false; });
            floodInundationRunning = false;
            uiMsg('请选择洪水阈值和日期范围');
            return;
        }
        
        const start = new Date(startDate);
        const end = new Date(endDate);
        
        if (start > end) {
            _floodBtns.forEach(b => { b.disabled = false; });
            floodInundationRunning = false;
            uiMsg('模拟起始日期不能晚于模拟结束日期');
            return;
        }
        
        // 显示加载状态
        analysisBtn.disabled = true;
        analysisBtn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> 分析中...';
        
        // 准备请求数据
        const requestData = {
            threshold: threshold,
            start_date: startDate,
            end_date: endDate
        };
        
        // 调用后端洪水淹没分析API
        fetch('/api/simulate/flood-inundation', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestData)
        })
        .then(response => {
            if (!response.ok) {
                // 尝试解析错误信息
                return response.json().then(errorData => {
                    throw new Error(`洪水淹没模拟失败 (${response.status}): ${errorData.error || '未知错误'}`);
                }).catch(() => {
                    throw new Error(`洪水淹没模拟失败 (${response.status})`);
                });
            }
            return response.json();
        })
        .then(result => {
            // 显示分析结果
            displayFloodResults(result, resultTable, noResultTip);
            
            // 恢复按钮状态
            _floodBtns.forEach(b => { b.disabled = false; b.innerHTML = '<i class="fa fa-play mr-2"></i>开始分析'; });
            floodInundationRunning = false;
        })
        .catch(error => {
            console.error('洪水淹没模拟失败:', error);
            uiMsg(error.message || '洪水淹没模拟失败，请检查参数或联系管理员', 'error');
            
            // 恢复按钮状态
            _floodBtns.forEach(b => { b.disabled = false; b.innerHTML = '<i class="fa fa-play mr-2"></i>开始分析'; });
            floodInundationRunning = false;
        });
    }
    
    // 显示洪水淹没结果（ECharts 面积图 + 组件化表格）
    let floodAreaChart = null; // 记录实例，重新绘制时销毁
    function displayFloodResults(result, resultTable, noResultTip) {
        const floodResults = result.flood_results || [];
        const validResults = floodResults.filter(r => r.has_flood);
        
        if (!result || validResults.length === 0) {
            noResultTip.style.display = 'block';
            resultTable.style.display = 'none';
            // 移除旧图表
            const oldChart = document.getElementById('flood-area-chart');
            if (oldChart) oldChart.remove();
            noResultTip.textContent = '暂无洪水淹没结果，请调整分析条件后重试';
            return;
        }
        
        noResultTip.style.display = 'none';
        resultTable.style.display = 'table';
        resultTable.className = 'ui-table';
        
        // 清空表格
        resultTable.innerHTML = '';

        // ---- ECharts 淹没面积趋势图 ----
        const oldChart = document.getElementById('flood-area-chart');
        if (oldChart) oldChart.remove();
        if (floodAreaChart) { try { floodAreaChart.dispose(); } catch (e) {} floodAreaChart = null; }

        if (typeof echarts !== 'undefined') {
            const chartWrap = document.createElement('div');
            chartWrap.id = 'flood-area-chart';
            chartWrap.className = 'ui-fade-in';
            chartWrap.style.cssText = 'width:100%;height:220px;margin:4px auto 14px;';
            resultTable.parentNode.insertBefore(chartWrap, resultTable);

            const chartData = validResults
                .filter(f => f.flood_area_km2 !== null && f.flood_area_km2 > 0)
                .map((f, i) => ({ date: f.date || `第${i + 1}天`, value: Math.round(parseFloat(f.flood_area_km2)) }));

            if (chartData.length >= 2) {
                const chart = echarts.init(chartWrap);
                floodAreaChart = chart;
                chart.setOption({
                    title: {
                        text: '淹没面积（km²）',
                        left: 'center',
                        top: 2,
                        textStyle: { color: '#93c5fd', fontSize: 15, fontWeight: 600 }
                    },
                    tooltip: {
                        trigger: 'axis',
                        backgroundColor: 'rgba(30, 41, 59, 0.92)',
                        borderColor: '#334155',
                        textStyle: { color: '#e2e8f0', fontSize: 12 }
                    },
                    grid: { left: '3%', right: '4%', bottom: '3%', top: '22%', containLabel: true },
                    xAxis: {
                        type: 'category',
                        boundaryGap: false,
                        data: chartData.map(d => d.date),
                        axisLabel: { color: '#94a3b8', rotate: 35, fontSize: 11 },
                        axisLine: { lineStyle: { color: '#334155' } },
                        axisTick: { show: false }
                    },
                    yAxis: {
                        type: 'value',
                        name: '面积 (km²)',
                        nameTextStyle: { color: '#94a3b8', fontSize: 11 },
                        axisLabel: { color: '#94a3b8', fontSize: 11 },
                        axisLine: { show: false },
                        splitLine: { lineStyle: { color: 'rgba(51, 65, 85, 0.7)', type: 'dashed' } }
                    },
                    series: [{
                        name: '淹没面积',
                        type: 'line',
                        smooth: true,
                        symbol: 'circle',
                        symbolSize: 6,
                        data: chartData.map(d => d.value),
                        lineStyle: { color: '#f59e0b', width: 2.5 },
                        itemStyle: { color: '#fbbf24', borderColor: '#f59e0b', borderWidth: 2 },
                        areaStyle: {
                            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                                { offset: 0, color: 'rgba(245, 158, 11, 0.4)' },
                                { offset: 1, color: 'rgba(245, 158, 11, 0.03)' }
                            ])
                        }
                    }]
                });
                window.addEventListener('resize', () => { try { chart.resize(); } catch (e) {} });
            } else {
                chartWrap.innerHTML = '<div class="ui-empty"><i class="fa fa-line-chart"></i><p>有效数据不足，暂不展示趋势图</p></div>';
            }
        }
        
        // 创建表头
        const thead = document.createElement('thead');
        thead.innerHTML = `
            <tr>
                <th>日期</th>
                <th>淹没面积(km²)</th>
                <th>操作</th>
            </tr>
        `;
        resultTable.appendChild(thead);
        
        // 创建表体
        const tbody = document.createElement('tbody');
        
        validResults.forEach(flood => {
            const row = document.createElement('tr');
            const area = flood.flood_area_km2 !== null ? Math.round(flood.flood_area_km2) : 'N/A';
            row.innerHTML = `
                <td>${flood.date || '—'}</td>
                <td>${UI.badge(String(area) + ' km²', area !== 'N/A' ? 'warning' : 'default', { dot: false })}</td>
                <td>
                    <button class="ui-btn ui-btn-primary ui-btn-sm" onclick="loadFloodLayer('${flood.date || ''}', '${thresholdSelect.value}')">
                        <i class="fa fa-map-marker mr-1"></i>加载
                    </button>
                </td>
            `;
            tbody.appendChild(row);
        });
        
        resultTable.appendChild(tbody);
    }
    
    // 加载洪水图层到地图 - 简化版本，直接复用现有代码
    window.loadFloodLayer = function(date, threshold) {
        console.log(`加载洪水图层: ${date}, 阈值: ${threshold}`);
        
        // 直接调用后端API获取洪水淹没结果
        fetch('/api/simulate/flood-inundation', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                start_date: date,
                end_date: date,
                threshold: threshold
            })
        })
        .then(response => {
            if (!response.ok) {
                throw new Error('加载洪水图层失败');
            }
            return response.json();
        })
        .then(result => {
            if (result.status === 'success' && result.urls && result.urls.length > 0) {
                // 获取第一个洪水图层URL
                const floodLayerUrl = result.urls[0];
                console.log('正在加载洪水图层:', floodLayerUrl);
                
                // 直接使用现有的GeoTIFF加载函数，传入洪水相关参数
                loadGeoTiffLayer(floodLayerUrl, 'flood', date);
                
                uiMsg(`成功加载 ${date} 的洪水淹没图层到地图`, 'success');
            } else {
                uiMsg('加载洪水图层失败: ' + (result.error || '未能生成洪水淹没图层'), 'error');
            }
        })
        .catch(error => {
            console.error('加载洪水图层失败:', error);
            uiMsg('加载洪水图层失败，请检查网络连接或联系管理员', 'error');
        });
    };
    
    // 事件监听：侧边栏洪水淹没分析
    startAnalysisBtn.addEventListener('click', () => {
        analyzeFloodInundation(
            thresholdSelect.value,
            floodStartDate.value,
            floodEndDate.value,
            floodResultTable,
            noFloodResultTip,
            startAnalysisBtn
        );
    });
    
    // 事件监听：主内容区域洪水淹没分析
    startAnalysisBtnMain.addEventListener('click', () => {
        analyzeFloodInundation(
            thresholdSelectMain.value,
            floodStartDateMain.value,
            floodEndDateMain.value,
            floodResultTableMain,
            noFloodResultTipMain,
            startAnalysisBtnMain
        );
    });
    
    // 初始化：加载阈值列表
    loadThresholds();
    
    // 设置默认日期范围为2024年全年（用本地时区格式化，避免 toISOString 跨时区偏移一天）
    function fmtLocalDate(d) {
        return d.getFullYear() + '-' +
            String(d.getMonth() + 1).padStart(2, '0') + '-' +
            String(d.getDate()).padStart(2, '0');
    }
    const defaultStartDate = fmtLocalDate(new Date(2024, 0, 1));
    const defaultEndDate = fmtLocalDate(new Date(2024, 11, 31));
    
    if (floodStartDate) floodStartDate.value = defaultStartDate;
    if (floodEndDate) floodEndDate.value = defaultEndDate;
    if (floodStartDateMain) floodStartDateMain.value = defaultStartDate;
    if (floodEndDateMain) floodEndDateMain.value = defaultEndDate;
}



// 积雪灾害过程模拟功能
function initializeSnowSimulationModule() {
    const snowModelSelect = document.getElementById('snow-model-select');
    const snowSimulateStartDate = document.getElementById('snow-simulate-start-date');
    const snowSimulateEndDate = document.getElementById('snow-simulate-end-date');
    const startSnowSimulateBtn = document.getElementById('start-snow-simulate');
    const snowSimulateResultTable = document.getElementById('snow-simulate-result-table');
    const noSnowSimulateResultTip = document.getElementById('no-snow-simulate-result-tip');
    
    // 积雪灾害过程模拟按钮点击事件
    startSnowSimulateBtn.addEventListener('click', () => {
        const model = snowModelSelect.value;
        const startDate = snowSimulateStartDate.value;
        const endDate = snowSimulateEndDate.value;
        
        if (!model) {
            uiMsg('请选择积雪模型');
            return;
        }
        
        if (!startDate || !endDate) {
            uiMsg('请选择开始和结束日期');
            return;
        }
        
        if (startDate > endDate) {
            uiMsg('模拟起始日期不能晚于模拟结束日期');
            return;
        }
        
        // 模拟积雪灾害过程模拟功能（占位符）
        console.log('开始积雪灾害过程模拟:', { model, startDate, endDate });
        uiMsg('积雪灾害过程模拟功能正在开发中', 'info');
    });
}

// 冰川灾害过程模拟功能
function initializeIceSimulationModule() {
    const iceModelSelect = document.getElementById('ice-model-select');
    const iceSimulateStartDate = document.getElementById('ice-simulate-start-date');
    const iceSimulateEndDate = document.getElementById('ice-simulate-end-date');
    const startIceSimulateBtn = document.getElementById('start-ice-simulate');
    const iceSimulateResultTable = document.getElementById('ice-simulate-result-table');
    const noIceSimulateResultTip = document.getElementById('no-ice-simulate-result-tip');
    
    // 冰川灾害过程模拟按钮点击事件
    startIceSimulateBtn.addEventListener('click', () => {
        const model = iceModelSelect.value;
        const startDate = iceSimulateStartDate.value;
        const endDate = iceSimulateEndDate.value;
        
        if (!model) {
            uiMsg('请选择冰川模型');
            return;
        }
        
        if (!startDate || !endDate) {
            uiMsg('请选择开始和结束日期');
            return;
        }
        
        if (startDate > endDate) {
            uiMsg('模拟起始日期不能晚于模拟结束日期');
            return;
        }
        
        // 模拟冰川灾害过程模拟功能（占位符）
        console.log('开始冰川灾害过程模拟:', { model, startDate, endDate });
        uiMsg('冰川灾害过程模拟功能正在开发中', 'info');
    });
}

// 冻土灾害过程模拟功能
function initializePermafrostSimulationModule() {
    const permafrostModelSelect = document.getElementById('permafrost-model-select');
    const permafrostSimulateStartDate = document.getElementById('permafrost-simulate-start-date');
    const permafrostSimulateEndDate = document.getElementById('permafrost-simulate-end-date');
    const startPermafrostSimulateBtn = document.getElementById('start-permafrost-simulate');
    const permafrostSimulateResultTable = document.getElementById('permafrost-simulate-result-table');
    const noPermafrostSimulateResultTip = document.getElementById('no-permafrost-simulate-result-tip');
    
    // 冻土灾害过程模拟按钮点击事件
    startPermafrostSimulateBtn.addEventListener('click', () => {
        const model = permafrostModelSelect.value;
        const startDate = permafrostSimulateStartDate.value;
        const endDate = permafrostSimulateEndDate.value;
        
        if (!model) {
            uiMsg('请选择冻土模型');
            return;
        }
        
        if (!startDate || !endDate) {
            uiMsg('请选择开始和结束日期');
            return;
        }
        
        if (startDate > endDate) {
            uiMsg('模拟起始日期不能晚于模拟结束日期');
            return;
        }
        
        // 模拟冻土灾害过程模拟功能（占位符）
        console.log('开始冻土灾害过程模拟:', { model, startDate, endDate });
        uiMsg('冻土灾害过程模拟功能正在开发中', 'info');
    });
}
