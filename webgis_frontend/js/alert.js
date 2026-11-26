// 风险评估侧边栏管理器
class AlertSidebarManager {
    constructor() {
        this.sidebar = null;
        this.isOpen = false;
        this.currentCategory = null;
        this.categoryNames = {
            'flood': '洪水灾害风险评估',
            'snow': '积雪灾害风险评估',
            'ice': '冰川灾害风险评估',
            'permafrost': '冻土灾害风险评估'
        };
        // 右侧栏标题图标代表模块本身（风险评估），不随灾害类型变化
        this.titleIcon = 'fa-exclamation-triangle';
        this.titleColor = '#fb7185';
        this.dropdown = null;
        this.toggle = null;
        this.init();
    }

    init() {
        this.sidebar = document.getElementById('alert-sidebar');
        this.dropdown = document.getElementById('alert-dropdown');
        this.toggle = document.querySelector('.dropdown-toggle[data-page="alert"]');
        
        if (!this.sidebar || !this.dropdown) return;

        this.setupSidebarInteractions();
        this.setupAnalysisEvents();
        this.registerNavCategoryHandler();
    }

    // 注册导航栏下拉项点击处理（由 main.js 统一导航调用）
    registerNavCategoryHandler() {
        window.applyNavCategory = (category) => {
            // 高亮对应的下拉菜单项
            document.querySelectorAll('#alert-dropdown .dropdown-item').forEach(i => {
                i.classList.toggle('active', i.dataset.category === category);
            });
            // 侧边栏已打开且点击的是当前分类 -> 收起；否则打开/切换
            if (this.sidebar.classList.contains('active') && this.currentCategory === category) {
                this.hideSidebar();
            } else {
                this.showSidebar(category);
            }
        };
    }

    setupSidebarInteractions() {
        // 关闭按钮
        const closeBtn = document.getElementById('alert-sidebar-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.hideSidebar());
        }

        // 侧边栏遮罩（点击关闭）
        this.mask = document.getElementById('alert-sidebar-mask');
        if (this.mask) {
            this.mask.addEventListener('click', () => this.hideSidebar());
        }

        // Esc 关闭
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.sidebar.classList.contains('active')) {
                this.hideSidebar();
            }
        });

        // 风险因子 tab 按钮切换事件
        const factorBtns = document.querySelectorAll('.alert-category-sidebar-content .tab-btn[data-factor]');
        factorBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                factorBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.handleFactorChange(btn.dataset.factor);
            });
        });
    }

    showSidebar(category) {
        if (!this.sidebar) return;

        // 显示侧边栏
        this.sidebar.classList.add('active');
        if (this.mask) this.mask.classList.add('active');
        this.isOpen = true;
        this.currentCategory = category;

        this.restoreCategoryContent();
    }

    restoreCategoryContent() {
        if (!this.currentCategory) return;

        // 更新侧边栏标题 - 根据选中的类别动态变化
        const titleElement = document.getElementById('alert-sidebar-title');
        if (titleElement) {
            // 根据类别显示不同的标题
            const categoryName = this.categoryNames[this.currentCategory] || '风险评估';
            titleElement.innerHTML = `<i class="fa ${this.titleIcon} rhs-title-icon" style="color:${this.titleColor}"></i>${categoryName}`;
        }

        // 隐藏所有灾害分类
        const allCategories = document.querySelectorAll('.alert-category-sidebar');
        allCategories.forEach(cat => {
            cat.style.display = 'none';
            cat.style.opacity = '0';
            cat.style.transform = 'translateX(20px)';
        });

        // 显示选中的灾害分类
        const selectedCategory = document.getElementById(`${this.currentCategory}-category-sidebar`);
        if (selectedCategory) {
            selectedCategory.style.display = 'block';
            setTimeout(() => {
                selectedCategory.style.opacity = '1';
                selectedCategory.style.transform = 'translateX(0)';
            }, 10);
        }

        // 同步现有图层状态到侧边栏
        this.syncLayerStates();
    }

    hideSidebar() {
        if (this.sidebar) {
            this.sidebar.classList.remove('active');
            if (this.mask) this.mask.classList.remove('active');
            this.isOpen = false;
            // 注意：不再清除currentCategory，保留类别状态
        }
    }

    syncLayerStates() {
        // select 模式下由用户控制，无需同步勾选状态
    }

    handleFactorChange(layerId) {
        if (!window.alertLayerManager) return;
        const startDate = document.getElementById('flood-risk-start-date')?.value || '2024-07-01';
        const endDate = document.getElementById('flood-risk-end-date')?.value || '2024-08-31';
        const basin = document.getElementById('flood-risk-basin')?.value || 'all';
        // 切换因子：只清图层不清缓存（同参数复用计算结果）
        window.alertLayerManager.clearLayers();
        window.alertLayerManager.loadLayer(layerId, startDate, endDate, basin);
    }

    // 初始化风险分析事件
    setupAnalysisEvents() {
        // 为所有风险类型的阈值滑块添加事件
        const riskTypes = ['flood', 'snow', 'ice', 'permafrost'];
        
        riskTypes.forEach(type => {
            const thresholdSlider = document.getElementById(`${type}-risk-threshold`);
            const valueDisplay = document.querySelector(`#${type}-risk-threshold + .alert-analysis-value`);
            
            if (thresholdSlider && valueDisplay) {
                thresholdSlider.addEventListener('input', (e) => {
                    valueDisplay.textContent = `${e.target.value}%`;
                });
            }
            
            // 为分析按钮添加事件
            const analyzeBtn = document.getElementById(`${type}-analyze-btn`);
            if (analyzeBtn) {
                analyzeBtn.addEventListener('click', () => {
                    this.performRiskAnalysis(type);
                });
            }
        });
    }

    // 执行风险分析
    async performRiskAnalysis(type) {
        if (type !== 'flood') {
            showToast(`${this.categoryNames[type]}暂未实现，当前仅支持洪水灾害风险评估`);
            return;
        }
        if (!window.alertLayerManager) {
            showToast('风险图层管理器未初始化');
            return;
        }

        const startDate = document.getElementById('flood-risk-start-date').value;
        const endDate = document.getElementById('flood-risk-end-date').value;
        const basin = document.getElementById('flood-risk-basin').value;
        const basinText = document.getElementById('flood-risk-basin').selectedOptions[0].text;

        if (!startDate || !endDate) {
            showToast('请选择开始日期和结束日期');
            return;
        }
        if (new Date(startDate) > new Date(endDate)) {
            showToast('开始日期不能晚于结束日期');
            return;
        }

        const btn = document.getElementById(`${type}-analyze-btn`);
        const originalText = btn.innerHTML;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> 分析中...';
        btn.disabled = true;

        try {
            // 读取权重面板（默认熵权法；自定义时下发权重）
            const w = collectRiskWeights();
            window.alertLayerManager.weightMethod = w.method;
            window.alertLayerManager.riskWeights = w.riskWeights;
            window.alertLayerManager.exposureWeights = w.exposureWeights;

            // 参数变化时清旧图层重算，显示下拉框选中的因子
            const selectedFactor = document.querySelector('.alert-category-sidebar-content .tab-btn.active')?.dataset.factor || 'flood_risk';
            window.alertLayerManager.clearAll();
            await window.alertLayerManager.loadLayer(selectedFactor, startDate, endDate, basin);
            const data = window.alertLayerManager.riskData;
            if (data && data.stats) {
                if (data.meta) {
                    _showEntropyReadout(data.meta);
                    // 缓存后端自动赋权结果，供"自定义"面板作为初值预填
                    lastAutoWeights = {
                        risk: data.meta.risk_weights || null,
                        exposure: data.meta.exposure_weights || null,
                    };
                    // 仅当本次用默认（自动）赋权评估时，才允许下次进入自定义以自动初值覆盖；
                    // 若本次为自定义评估，保留用户手工选择，切回自定义不被自动初值冲掉。
                    if ((window.alertLayerManager.weightMethod || 'entropy') !== 'custom') {
                        customWeightEdited = false;
                    }
                }
                showRiskResultModal(data, startDate, endDate, basinText);
            }
        } catch (e) {
            if (e.code === 'NO_INUNDATION_DATA') {
                showNoInundationGuide(e.detail, startDate, endDate);
            } else {
                showToast('分析失败: ' + e.message, 'error');
            }
        } finally {
            btn.innerHTML = originalText;
            btn.disabled = false;
        }
    }
}

// 初始化风险评估侧边栏管理器
window.alertSidebarManager = new AlertSidebarManager();

// 加载流域列表到风险分析下拉框（数据来源 /api/basin/data → TP_Basins_China.geojson）
async function loadBasinOptions() {
    const select = document.getElementById('flood-risk-basin');
    if (!select) return;
    try {
        const resp = await fetch('/api/basin/data');
        const data = await resp.json();
        const features = data.features || (data.data && data.data.features) || [];
        if (!features.length) return;

        // 动态探测流域名称字段（不同数据源字段名不同）
        const firstProps = features[0].properties || {};
        const candidates = ['NAME', 'BASIN_NAME', 'BAS_NM', 'name', 'BASIN', 'PN', 'BAS_NAME'];
        let nameField = candidates.find(f => firstProps[f] !== undefined && firstProps[f] !== '');
        if (!nameField) {
            nameField = Object.keys(firstProps).find(
                k => typeof firstProps[k] === 'string' && firstProps[k].length > 0 && firstProps[k].length < 30
            );
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
        console.log('[风险评估] 已加载流域列表:', loadedCount, '个, 名称字段:', nameField);
    } catch (e) {
        console.warn('[风险评估] 加载流域列表失败:', e);
    }
}

// 风险评估页面专用功能
document.addEventListener('DOMContentLoaded', function() {
    // 检查是否为风险评估页面
    if (!window.location.pathname.endsWith('alert.html')) {
        return;
    }

    // 使用与首页相同的折叠面板初始化函数
    initCategoryFold();

    // 加载流域下拉框
    loadBasinOptions();

    // 初始化权重自定义面板
    initRiskWeightPanel();

    // 默认选中第一个类别（洪水灾害风险评估）但不自动显示侧边栏
    if (window.alertSidebarManager) {
        const firstDropdownItem = document.querySelector('#alert-dropdown .dropdown-item');
        if (firstDropdownItem) {
            firstDropdownItem.classList.add('active');
            // 不预设 currentCategory，避免 URL 参数进入时被误判为"点击当前项"而隐藏侧边栏
            // 不自动显示侧边栏，保持与其他界面一致
        }
    }
});

// ==================== 权重自定义面板（洪水风险评估） ====================
// 组定义：综合风险(3 因子) / 暴露度(5 维)；顺序与后端键名严格一致。
const RISK_WEIGHT_DEFS = [
    { key: 'hazard', label: 'H' },
    { key: 'exposure', label: 'E' },
    { key: 'vulnerability', label: 'V' },
];
const EXPOSURE_WEIGHT_DEFS = [
    { key: 'gdp', label: 'GDP' },
    { key: 'pop', label: '人口' },
    { key: 'arable', label: '耕地' },
    { key: 'grain', label: '粮食' },
    { key: 'livestock', label: '牲畜' },
];

// 最近一次评估由后端自动赋权（熵权×AHP 先验混合）得到的权重，作为"自定义"面板的初始值
let lastAutoWeights = null;
// 用户是否已在自定义面板手动编辑过（切换 method 时避免反复覆盖其手工选择）
let customWeightEdited = false;

// 将后端自动赋权结果回填为某组滑块初值（百分比四舍五入）。返回是否成功填充。
function _fillCustomFromAuto(group) {
    const w = group === 'risk' ? (lastAutoWeights && lastAutoWeights.risk)
                                : (lastAutoWeights && lastAutoWeights.exposure);
    if (!w) return false;
    const defs = group === 'risk' ? RISK_WEIGHT_DEFS : EXPOSURE_WEIGHT_DEFS;
    let filled = false;
    defs.forEach(d => {
        const raw = (typeof w[d.key] === 'number' && isFinite(w[d.key])) ? w[d.key] : null;
        if (raw == null) return;
        const v = Math.max(0, Math.min(100, Math.round(raw * 100)));
        const sl = document.querySelector(`#flood-weight-groups .risk-weight-slider[data-group="${group}"][data-key="${d.key}"]`);
        if (sl) {
            sl.value = v;
            const valEl = sl.parentElement.querySelector('.w-val');
            if (valEl) valEl.textContent = v;
            filled = true;
        }
    });
    if (filled) _updateWeightSum(group);
    return filled;
}

// 计算某组滑块的归一化占比文本（权重仅相对大小有效）
function _updateWeightSum(group) {
    const sliders = document.querySelectorAll(`#flood-weight-groups .risk-weight-slider[data-group="${group}"]`);
    const defs = group === 'risk' ? RISK_WEIGHT_DEFS : EXPOSURE_WEIGHT_DEFS;
    let sum = 0;
    sliders.forEach(s => { sum += Number(s.value); });
    const parts = [];
    sliders.forEach(s => {
        const v = Number(s.value);
        const pct = sum > 0 ? Math.round(v / sum * 100) : 0;
        parts.push(`${defs.find(d => d.key === s.dataset.key).label} <b>${pct}%</b>`);
    });
    const box = document.getElementById(group === 'risk' ? 'flood-weight-sum-risk' : 'flood-weight-sum-exposure');
    if (box) box.innerHTML = parts.join(' · ');
}

// 初始化权重面板：方法二选一（熵权法默认 / 自定义），自定义展开二级面板
function initRiskWeightPanel() {
    const methodBox = document.getElementById('flood-weight-method');
    const customPanel = document.getElementById('flood-weight-custom-panel');
    const entropyNote = document.getElementById('flood-weight-entropy-note');
    const badge = document.getElementById('flood-weight-badge');
    if (!methodBox) return;

    const applyMethod = (method) => {
        methodBox.querySelectorAll('.weight-method-opt').forEach(b => {
            b.classList.toggle('active', b.dataset.method === method);
        });
        const isCustom = method === 'custom';
        if (customPanel) customPanel.classList.toggle('open', isCustom);
        if (entropyNote) entropyNote.style.display = isCustom ? 'none' : '';
        if (badge) {
            badge.textContent = isCustom ? '自定义' : '熵权·先验混合';
            badge.classList.toggle('custom', isCustom);
        }
        // 进入自定义：若已评估过且用户未手动改过，则以自动赋权结果为初值
        if (isCustom && lastAutoWeights && !customWeightEdited) {
            _fillCustomFromAuto('risk');
            _fillCustomFromAuto('exposure');
        }
    };

    methodBox.querySelectorAll('.weight-method-opt').forEach(btn => {
        btn.addEventListener('click', () => applyMethod(btn.dataset.method));
    });

    // 滑块：更新数值显示 + 归一化占比
    document.querySelectorAll('#flood-weight-groups .risk-weight-slider').forEach(s => {
        s.addEventListener('input', () => {
            customWeightEdited = true;
            const valEl = s.parentElement.querySelector('.w-val');
            if (valEl) valEl.textContent = s.value;
            _updateWeightSum(s.dataset.group);
        });
    });

    // 重置等权按钮
    document.querySelectorAll('#flood-weight-groups [data-reset]').forEach(btn => {
        btn.addEventListener('click', () => {
            const g = btn.dataset.reset;
            const defs = g === 'risk' ? RISK_WEIGHT_DEFS : EXPOSURE_WEIGHT_DEFS;
            const equal = Math.round(100 / defs.length);
            defs.forEach((d, i) => {
                const sl = document.querySelector(`#flood-weight-groups .risk-weight-slider[data-group="${g}"][data-key="${d.key}"]`);
                if (sl) {
                    sl.value = (i === defs.length - 1) ? (100 - equal * (defs.length - 1)) : equal;
                    const valEl = sl.parentElement.querySelector('.w-val');
                    if (valEl) valEl.textContent = sl.value;
                }
            });
            _updateWeightSum(g);
            customWeightEdited = true; // 重置等权是用户的明确选择，切回自定义时不应被自动初值覆盖
        });
    });

    applyMethod('entropy');
    _updateWeightSum('risk');
    _updateWeightSum('exposure');
}

// 收集权重面板：返回 { method, riskWeights, exposureWeights }
//   method='entropy' -> 后端自动赋权，不下发权重；
//   method='custom'  -> 读取 8 个滑块，全零时退化为 null（交由后端 400 拦截或回退）。
function collectRiskWeights() {
    const methodBox = document.getElementById('flood-weight-method');
    const active = methodBox && methodBox.querySelector('.weight-method-opt.active');
    const method = active ? active.dataset.method : 'entropy';
    if (method !== 'custom') return { method: 'entropy', riskWeights: null, exposureWeights: null };
    const readGroup = (group) => Array.from(
        document.querySelectorAll(`#flood-weight-groups .risk-weight-slider[data-group="${group}"]`)
    ).map(s => Number(s.value));
    const risk = readGroup('risk');
    const exp = readGroup('exposure');
    const sumR = risk.reduce((a, b) => a + b, 0);
    const sumE = exp.reduce((a, b) => a + b, 0);
    return {
        method: 'custom',
        riskWeights: sumR > 0 ? risk : null,
        exposureWeights: sumE > 0 ? exp : null,
    };
}

// ==================== 风险图层管理器 ====================
// 风险等级颜色（val 为分级 1-5，与后端 RISK_LEVELS 一致）
const RISK_LEVEL_COLORS = [
    [44, 123, 182],   // 1 低
    [171, 217, 233],  // 2 较低
    [255, 255, 191],  // 3 中
    [253, 174, 97],   // 4 较高
    [215, 25, 28],    // 5 高
];

function _riskColor(val) {
    const idx = Math.max(1, Math.min(5, Math.round(val))) - 1;
    return RISK_LEVEL_COLORS[idx];
}

// 读取 GeoTIFF 并渲染为 ol.layer.Image
async function _renderRiskTif(url, colorMode) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`加载栅格失败: ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    const tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer);
    const image = await tiff.getImage();
    const width = image.getWidth();
    const height = image.getHeight();
    const bbox = image.getBoundingBox();
    const extentWM = ol.proj.transformExtent(bbox, 'EPSG:4326', 'EPSG:3857');

    const rasters = await image.readRasters({ interleave: true });

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(width, height);

    for (let i = 0; i < rasters.length; i++) {
        const val = rasters[i];
        if (val < 1e-6 || isNaN(val)) {
            imageData.data.set([0, 0, 0, 0], i * 4); // 透明
        } else {
            // 风险/危险性/暴露度/脆弱性均为等级 1-5
            const rgb = _riskColor(val);
            imageData.data.set([rgb[0], rgb[1], rgb[2], 220], i * 4);
        }
    }
    ctx.putImageData(imageData, 0, 0);

    return new ol.layer.Image({
        source: new ol.source.ImageCanvas({
            canvasFunction: (extent, resolution, pixelRatio, size, projection) => {
                if (projection.getCode() !== 'EPSG:3857') return null;
                const out = document.createElement('canvas');
                out.width = size[0];
                out.height = size[1];
                const octx = out.getContext('2d');
                octx.clearRect(0, 0, size[0], size[1]);
                const scaleX = size[0] / ol.extent.getWidth(extent);
                const scaleY = size[1] / ol.extent.getHeight(extent);
                const targetX = (extentWM[0] - extent[0]) * scaleX;
                const targetY = (extent[3] - extentWM[3]) * scaleY;
                const targetW = ol.extent.getWidth(extentWM) * scaleX;
                const targetH = ol.extent.getHeight(extentWM) * scaleY;
                octx.drawImage(canvas, 0, 0, canvas.width, canvas.height,
                    targetX, targetY, targetW, targetH);
                return out;
            },
            projection: 'EPSG:3857',
            imageExtent: extentWM,
        }),
        opacity: 0.75,
        // 遵循点线面顺序：结果栅格属于"面"要素，仅比冻土（zIndex:5）略高，不覆盖线/点要素
        zIndex: 10,
    });
}

class AlertLayerManager {
    constructor() {
        this.layers = {};     // layerId -> ol.layer
        this.riskData = null; // 缓存后端返回结果
        this.loading = false;
        this.currentParams = null; // 记录当前计算参数，变化时重算
        this.weightMethod = 'entropy';   // 'entropy' 默认 | 'custom'
        this.riskWeights = null;      // custom 时数组=[wH,wE,wV]；entropy 时为 null
        this.exposureWeights = null;  // custom 时数组=[w_gdp,...]；entropy 时为 null
    }

    // 权重签名：纳入缓存键，权重变化即触发重算
    _weightSignature() {
        const method = this.weightMethod || 'entropy';
        const r = this.riskWeights, e = this.exposureWeights;
        const fmt = (a) => a ? a.map(x => Math.round(x)).join(',') : '-';
        return `${method}|r:${fmt(r)}|e:${fmt(e)}`;
    }

    // 清除所有图层和缓存（参数变化时调用）
    clearAll() {
        for (const id of Object.keys(this.layers)) {
            window.map.removeLayer(this.layers[id]);
        }
        this.layers = {};
        this._hideLegend();
        this.riskData = null;
        this.currentParams = null;
    }

    // 仅清除地图图层，保留计算缓存（切换因子时调用）
    clearLayers() {
        for (const id of Object.keys(this.layers)) {
            window.map.removeLayer(this.layers[id]);
        }
        this.layers = {};
        this._hideLegend();
    }

    async _ensureRiskData(startDate, endDate, basin) {
        const newParams = `${startDate}|${endDate}|${basin}|${this._weightSignature()}`;
        // 参数未变则复用缓存，不重复请求后端（切换因子/权重时快速响应）
        if (this.riskData && this.currentParams === newParams) {
            return this.riskData;
        }
        if (this.loading) return null;
        this.loading = true;
        try {
            const body = {
                start_date: startDate || '2024-07-01',
                end_date: endDate || '2024-08-31',
                basin: basin || 'all',
                weight_method: this.weightMethod || 'entropy',
            };
            // 自定义权重时下发具体权重；熵权法由后端自动计算
            if (this.weightMethod === 'custom') {
                if (this.riskWeights) body.risk_weights = this.riskWeights;
                if (this.exposureWeights) body.exposure_weights = this.exposureWeights;
            }
            const resp = await fetch('/api/alert/risk_assessment', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await resp.json();
            if (!resp.ok) {
                if (data && data.status === 'NO_INUNDATION_DATA') {
                    const e = new Error(data.message || '缺少上游淹没范围数据，无法进行评估');
                    e.code = 'NO_INUNDATION_DATA';
                    e.detail = data;
                    throw e;
                }
                throw new Error(data.error || '风险评估失败');
            }
            this.riskData = data;
            this.currentParams = newParams;
            return data;
        } finally {
            this.loading = false;
        }
    }

    async loadLayer(layerId, startDate, endDate, basin) {
        startDate = startDate || '2024-07-01';
        endDate = endDate || '2024-08-31';
        basin = basin || 'all';

        // 参数变化则清缓存和旧图层（含权重签名）
        const newParams = `${startDate}|${endDate}|${basin}|${this._weightSignature()}`;
        if (this.currentParams && this.currentParams !== newParams) {
            this.clearAll();
        }

        // layerId: flood_risk / flood_hazard / flood_vulnerability
        if (this.layers[layerId]) {
            this.layers[layerId].setVisible(true);
            if (this.riskData) this._showLegend(layerId, this.riskData);
            return;
        }

        try {
            const data = await this._ensureRiskData(startDate, endDate, basin);
            if (!data) return;

            let url, mode;
            if (layerId === 'flood_risk') { url = data.risk_tif_url; mode = 'risk'; }
            else if (layerId === 'flood_hazard') { url = data.hazard_tif_url; mode = 'hazard'; }
            else if (layerId === 'flood_exposure') { url = data.exposure_tif_url; mode = 'exposure'; }
            else if (layerId === 'flood_vulnerability') { url = data.vulnerability_tif_url; mode = 'vulnerability'; }
            else { return; }

            const layer = await _renderRiskTif(url, mode);
            this.layers[layerId] = layer;
            window.map.addLayer(layer);

            // 缩放到图层范围
            try {
                const ext = layer.getSource().getImageExtent
                    ? layer.getSource().getImageExtent()
                    : null;
                if (ext) window.map.getView().fit(ext, { padding: [50, 50, 50, 50] });
            } catch (e) { /* 忽略缩放错误 */ }

            this._showLegend(layerId, data);
        } catch (e) {
            if (e.code === 'NO_INUNDATION_DATA') {
                showNoInundationGuide(e.detail, startDate, endDate);
                return;
            }
            console.error('加载风险图层失败:', e);
            showToast('加载风险图层失败: ' + e.message, 'error');
        }
    }

    removeLayer(layerId) {
        if (this.layers[layerId]) {
            window.map.removeLayer(this.layers[layerId]);
            delete this.layers[layerId];
        }
        // 若所有风险图层都移除，隐藏图例
        if (Object.keys(this.layers).length === 0) {
            this._hideLegend();
        }
    }

    _showLegend(layerId, data) {
        this._hideLegend();
        const legend = document.createElement('div');
        legend.id = 'risk-legend';
        // 默认贴左 16px（与图层管理悬浮岛面板一致）；随后按面板真实视口左坐标精确对齐
        legend.style.cssText = 'position:absolute;bottom:30px;left:16px;padding:10px 12px;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.4);z-index:10;font-size:12px;min-width:60px;max-width:80px;';
        let title = '', rows = '';
        const spanStyle = 'display:inline-block;width:14px;height:14px;margin-right:6px;border:1px solid rgba(255,255,255,0.3);';
        // 图例顺序：从下到上由低到高（顶部为高，底部为低），故渲染时倒序排列
        const orderedLevels = (lvArr) => [...(lvArr || [])].reverse();
        if (layerId === 'flood_risk' && data.stats) {
            title = '综合风险';
            orderedLevels(data.stats.levels).forEach(lv => {
                rows += `<div style="display:flex;align-items:center;margin:3px 0;"><span style="${spanStyle}background:${lv.color};"></span>${lv.name}</div>`;
            });
        } else if (layerId === 'flood_hazard' || layerId === 'flood_exposure' || layerId === 'flood_vulnerability') {
            title = layerId === 'flood_hazard' ? '危险性'
                : (layerId === 'flood_exposure' ? '暴露度' : '脆弱性');
            const levels = (data.stats && data.stats.levels)
                ? data.stats.levels
                : [
                    { name: '低', color: '#2c7bb6' }, { name: '较低', color: '#abd9e9' },
                    { name: '中', color: '#ffffbf' }, { name: '较高', color: '#fdae61' },
                    { name: '高', color: '#d7191c' },
                ];
            orderedLevels(levels).forEach(lv => {
                rows += `<div style="display:flex;align-items:center;margin:3px 0;"><span style="${spanStyle}background:${lv.color};"></span>${lv.name}</div>`;
            });
        }
        legend.innerHTML = `<div style="font-weight:bold;margin-bottom:2px;">${title}</div>${rows}`;
        document.body.appendChild(legend);
        // 使图例左边缘与「图层管理」面板左边缘在垂直方向精确对齐
        this._alignLegendLeft(legend);
    }

    // 将风险图例左边缘与图层管理面板(.sidepanel)左边缘对齐；
    // 面板展开时按真实视口坐标对齐；收起时落在视口外(left:-340px)，改用其展开态左边缘 16px，避免图例贴屏幕边
    _alignLegendLeft(legend) {
        if (!legend) return;
        const sp = document.querySelector('.sidepanel:not(.collapsed)');
        if (sp) {
            const left = Math.round(sp.getBoundingClientRect().left);
            legend.style.left = Math.max(0, left) + 'px';
        } else {
            legend.style.left = '16px';
        }
    }

    _hideLegend() {
        const el = document.getElementById('risk-legend');
        if (el) el.remove();
    }
}

window.alertLayerManager = new AlertLayerManager();

// ==================== Toast 提示（统一走 UI 组件库，保证全模块风格一致）====================
function showToast(msg, type) {
    // 优先使用 UI 组件库的 Toast（右上角、带图标、与设计系统一致）
    if (window.UI && typeof window.UI.toast === 'function') {
        const map = { error: 'error', success: 'success', warning: 'warning', info: 'info' };
        return window.UI.toast(msg, map[type] || 'info');
    }
    // 兜底实现
    let toast = document.getElementById('risk-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'risk-toast';
        toast.style.cssText = 'position:fixed;top:80px;left:50%;transform:translateX(-50%);padding:12px 22px;border-radius:6px;z-index:3000;font-size:14px;box-shadow:0 4px 16px rgba(0,0,0,.4);transition:opacity .3s;pointer-events:none;max-width:80vw;';
        document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.background = type === 'error' ? 'rgba(220,38,38,0.95)' : 'rgba(15,23,42,0.95)';
    toast.style.color = '#fff';
    toast.style.opacity = '1';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 3200);
}

// ==================== ECharts 风险评估结果面板 ====================
let _riskChart = null;
let _riskChartData = null;   // 当前弹窗的等级统计（含各维度 *_share 占比）
let _riskChartDim = 'gdp';  // 当前饼图展示维度（面积维度已移除：相对分级下各等级面积恒≈20%，无信息量）
let _lastModalArgs = null;   // 最近一次弹窗参数，用于最小化后重新打开

// 环形图可选维度（与后端 level_stats 的 *_share 字段对应）
// 注：已移除「面积」维度——风险等级为相对分位数分级，各等级面积恒≈20%，面积环无信息量。
const RISK_SHARE_DIMS = [
    { key: 'gdp',       name: 'GDP' },
    { key: 'pop',       name: '人口' },
    { key: 'arable',    name: '耕地' },
    { key: 'grain',     name: '粮食' },
    { key: 'livestock', name: '牲畜' },
];

// 取某等级在指定维度下的占比值（缺失/NaN 记为 0）
function _riskPieValue(dim, lv) {
    const v = lv[dim + '_share'];
    return (v != null && !isNaN(v)) ? v : 0;
}

// 维度是否可用（该维度下至少存在一个等级占比 > 0）
function _dimAvailable(dim) {
    return !!( _riskChartData && _riskChartData.some(l => {
        const v = l[dim + '_share'];
        return v != null && !isNaN(v) && v > 0;
    }));
}

// 构建维度切换按钮（覆盖全部相关维度，不可用者禁用）
function _buildChartToggle() {
    const box = document.getElementById('risk-chart-toggle');
    if (!box) return;
    box.innerHTML = '';
    RISK_SHARE_DIMS.forEach(d => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'risk-chart-toggle-btn' + (d.key === _riskChartDim ? ' active' : '');
        btn.dataset.dim = d.key;
        btn.textContent = d.name;
        box.appendChild(btn);
    });
}

// 渲染风险等级占比环形图（依据当前维度，扇区=风险等级，数值=该维度在等级内的占比）
function _renderRiskPie() {
    const chartBox = document.getElementById('risk-chart');
    if (!chartBox || !_riskChartData) return;

    const dimMeta = RISK_SHARE_DIMS.find(d => d.key === _riskChartDim) || RISK_SHARE_DIMS[0];

    if (_riskChart) { _riskChart.dispose(); _riskChart = null; }
    _riskChart = echarts.init(chartBox);

    // 仅展示占比 > 0 的等级，避免空扇区；扇区颜色沿用风险等级配色
    const pieData = _riskChartData
        .map(l => ({ name: l.name, value: _riskPieValue(_riskChartDim, l), color: l.color }))
        .filter(d => d.value > 0);

    _riskChart.setOption({
        backgroundColor: 'transparent',
        title: {
            text: dimMeta.name,
            left: 'center', top: 6,
            textStyle: { color: '#e2e8f0', fontSize: 15, fontWeight: 500 },
        },
        tooltip: {
            trigger: 'item',
            formatter: (p) => `${p.name}（${dimMeta.name}）：${p.value}%`,
            backgroundColor: 'rgba(15,23,42,0.92)',
            borderColor: 'rgba(255,255,255,0.15)',
            textStyle: { color: '#fff' },
        },
        legend: {
            bottom: 2, left: 'center',
            textStyle: { color: '#cbd5e1', fontSize: 11 },
            itemWidth: 12, itemHeight: 12,
        },
        series: [{
            type: 'pie',
            radius: ['46%', '70%'],
            center: ['50%', '50%'],
            avoidLabelOverlap: true,
            itemStyle: { borderColor: 'rgba(15,23,42,0.65)', borderWidth: 2 },
            label: { color: '#e2e8f0', fontSize: 11, formatter: (p) => `${p.name}\n${p.value}%` },
            labelLine: { length: 10, length2: 10, lineStyle: { color: '#94a3b8' } },
            emphasis: { scale: true, scaleSize: 6, label: { fontSize: 12, fontWeight: 500 } },
            data: pieData.map(d => ({ name: d.name, value: d.value, itemStyle: { color: d.color } })),
        }],
    });
    _riskChart.resize();
}

// 同步切换按钮高亮与可用状态（不可用维度禁用，并在当前维度失效时回退）
function _setRiskChartToggle() {
    if (!_riskChartData) return;
    if (!_dimAvailable(_riskChartDim)) {
        const firstAvail = RISK_SHARE_DIMS.find(d => _dimAvailable(d.key));
        if (firstAvail) _riskChartDim = firstAvail.key;
    }
    document.querySelectorAll('#risk-chart-toggle .risk-chart-toggle-btn').forEach(btn => {
        const d = RISK_SHARE_DIMS.find(x => x.key === btn.dataset.dim);
        const avail = d ? _dimAvailable(d.key) : false;
        btn.classList.toggle('active', btn.dataset.dim === _riskChartDim);
        btn.disabled = !avail;
        btn.title = (d && !avail) ? `${d.name}数据不可用（该维度无匹配县域汇总）` : '';
    });
}

function _showRiskReopenBtn() {
    const btn = document.getElementById('risk-modal-reopen');
    if (btn) btn.style.display = '';
}

function _hideRiskReopenBtn() {
    const btn = document.getElementById('risk-modal-reopen');
    if (btn) btn.style.display = 'none';
}

let _riskExportData = null;

// 导出：风险评估统计 CSV
function exportRiskCsv() {
    const data = _riskExportData;
    if (!data || !data.stats) { UI.showAlert('暂无风险评估结果可导出', 'warning'); return; }
    const s = data.stats, m = data.meta || {};
    const lines = [];
    lines.push('洪水灾害风险评估统计');
    lines.push('等级,名称,像元数,面积(km²),面积占比(%),GDP占比(%),人口占比(%),耕地占比(%),粮食占比(%),牲畜占比(%)');
    (s.levels || []).forEach(lv => {
        const v = (k) => (lv[k] != null ? lv[k] : '');
        lines.push([lv.level, lv.name, lv.pixels, lv.area_km2,
            v('area_share'), v('gdp_share'), v('pop_share'),
            v('arable_share'), v('grain_share'), v('livestock_share')].join(','));
    });
    lines.push('');
    lines.push('淹没总面积(km²),' + (s.total_flood_area_km2 || 0));
    lines.push('淹没区GDP总量(万元),' + (s.total_gdp_wan || 0));
    lines.push('淹没区人口(人),' + (s.total_pop != null ? s.total_pop : ''));
    lines.push('淹没区耕地面积(公顷),' + (s.total_arable_ha || 0));
    lines.push('淹没区粮食产量(吨),' + (s.total_grain_t || 0));
    lines.push('淹没区牲畜存栏(头),' + (s.total_livestock_head || 0));
    const cd = s.county_points_detail || {};
    lines.push('匹配县域-GDP(个),' + (cd.gdp != null ? cd.gdp : (s.county_points_used || 0)));
    lines.push('匹配县域-人口(个),' + (cd.pop != null ? cd.pop : ''));
    lines.push('匹配县域-耕地(个),' + (cd.arable != null ? cd.arable : ''));
    lines.push('匹配县域-粮食(个),' + (cd.grain != null ? cd.grain : ''));
    lines.push('匹配县域-牲畜(个),' + (cd.livestock != null ? cd.livestock : ''));
    lines.push('参与日期数(天),' + (s.dates_used ? s.dates_used.length : 0));
    lines.push('方法,' + (m.method || ''));
    lines.push('暴露度数据来源,' + (m.exposure_source || ''));
    lines.push('OSM像素调制,' + (m.exposure_osm_modulated ? '是' : '否'));
    if (m.date_range) lines.push('日期范围,' + m.date_range);
    if (m.basin) lines.push('流域,' + m.basin);
    lines.push('权重方法,' + (m.weight_method === 'custom' ? '自定义权重' : '熵权×AHP先验混合(客观+先验)'));
    lines.push('综合风险模型,' + (m.composite_model === 'product' ? '规范默认(H×E×V 乘法模型)' : '加权几何平均'));
    // 仅输出有限数值，避免缺键时导出 NaN
    const _wfmt = (o, ks) => ks
        .filter(k => o && typeof o[k] === 'number' && isFinite(o[k]))
        .map(k => (o[k] * 100).toFixed(1) + '%').join('/');
    if (m.risk_weights) lines.push('综合风险权重(H/E/V),' + _wfmt(m.risk_weights, ['hazard', 'exposure', 'vulnerability']));
    if (m.exposure_weights) lines.push('暴露度权重(GDP/人口/耕地/粮食/牲畜),' + _wfmt(m.exposure_weights, ['gdp', 'pop', 'arable', 'grain', 'livestock']));
    UI.downloadText('洪水风险评估统计_' + new Date().toISOString().slice(0, 10) + '.csv', '\ufeff' + lines.join('\r\n'), 'text/csv;charset=utf-8');
}

// 导出：下载综合风险 GeoTIFF
function downloadRiskTif() {
    const data = _riskExportData;
    if (!data || !data.risk_tif_url) { UI.showAlert('暂无风险栅格可下载', 'warning'); return; }
    UI.downloadUrl(data.risk_tif_url, data.risk_tif_url.split('/').pop());
}

// 导出：将整个结果弹窗（评分环/概要/关键指标/环形图/风险提示）保存为 PNG
async function exportRiskChartPng() {
    const modal = document.getElementById('risk-result-modal');
    if (!modal) { UI.showAlert('未找到结果弹窗', 'warning'); return; }

    // 兜底：截图库未加载时，仅导出当前环形图（旧行为，保证功能不崩）
    if (typeof domtoimage === 'undefined') {
        if (_riskChart) {
            const url = _riskChart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#ffffff' });
            UI.downloadUrl(url, '风险评估图表_' + new Date().toISOString().slice(0, 10) + '.png');
        } else {
            UI.showAlert('截图组件未加载，且无图表可导出', 'warning');
        }
        return;
    }

    if (typeof UI !== 'undefined' && UI.toast) UI.toast('正在生成 PNG…', 'info');

    // ① 把 ECharts 环形图画布替换为静态图片：foreignObject 下 cloneNode 不会复制 canvas 像素，须提前转图，否则导出空白
    const chartEl = _riskChart ? _riskChart.getDom() : null;
    let chartImg = null, chartCanvas = null;
    if (chartEl) {
        try {
            const url = _riskChart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#ffffff' });
            chartImg = document.createElement('img');
            chartImg.src = url;
            chartImg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;';
            chartImg.className = 'risk-chart-snapshot';
            chartCanvas = chartEl.querySelector('canvas');
            if (chartCanvas) chartCanvas.style.visibility = 'hidden';
            chartEl.style.position = 'relative';
            chartEl.appendChild(chartImg);
        } catch (e) { chartImg = null; }
    }

    // ② 暂存并放开弹窗的固定定位/滚动限制，确保完整捕获（含超出 88vh 的部分）
    const prev = {
        position: modal.style.position, top: modal.style.top, left: modal.style.left,
        transform: modal.style.transform, maxHeight: modal.style.maxHeight, overflow: modal.style.overflow
    };
    modal.style.position = 'relative';
    modal.style.top = 'auto'; modal.style.left = 'auto'; modal.style.transform = 'none';
    modal.style.maxHeight = 'none'; modal.style.overflow = 'visible';

    const scale = 2; // 2 倍高清
    try {
        if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) {} }
        const dataUrl = await domtoimage.toPng(modal, {
            bgcolor: '#0f172a',
            width: modal.offsetWidth * scale,
            height: modal.offsetHeight * scale,
            style: { transform: 'scale(' + scale + ')', transformOrigin: 'top left', margin: '0' }
        });
        UI.downloadUrl(dataUrl, '洪水风险评估结果_' + new Date().toISOString().slice(0, 10) + '.png');
    } catch (e) {
        console.error('导出 PNG 失败', e);
        UI.showAlert('导出 PNG 失败：' + (e && e.message ? e.message : e), 'danger');
    } finally {
        // ③ 还原现场
        if (chartImg && chartImg.parentNode) chartImg.parentNode.removeChild(chartImg);
        if (chartCanvas) chartCanvas.style.visibility = '';
        if (chartEl) chartEl.style.position = '';
        Object.assign(modal.style, prev);
    }
}

// ============================================================
//  评估模块「弹窗信息标准结构」（统一规范，供本类评估模块复用）
//  ── 结果模态框 (showRiskResultModal) ──
//     ① 评估结果概要  : 一句话结论（主导等级、淹没面积、涉及资产/人口、评估范围）
//     ② 评分/等级     : 综合风险评分(0-100) + 等级徽章(1-5) + 主导等级
//     ③ 关键指标数据  : 淹没面积 + 5 维暴露真实汇总(GDP/人口/耕地/粮食/牲畜)
//     ④ 风险提示与建议: 基于主导等级与暴露构成的处置建议
//     ⑤ 操作引导按钮  : 前往灾害过程模拟 / 导出 / 下载 / 保存图表
//  ── 引导模态框 (showNoInundationGuide) ──
//     ① 概要(无法评估原因) ② 缺失步骤徽章 ③ 工作流说明 ④ 操作引导(前往模拟/关闭)
//  ── Toast ── 瞬时状态(分析中/失败)，统一走 UI.toast
//  ── 确认/提示框 ── 简单二次确认，走 UI.modal / UI.confirm
// ============================================================

// 等级常量（与后端 RISK_LEVELS 一致），用于前端未返回 levels 时的兜底
const RISK_LEVELS_JS = [
    { level: 1, name: '低',   color: '#2c7bb6' },
    { level: 2, name: '较低', color: '#abd9e9' },
    { level: 3, name: '中',   color: '#f59e0b' },
    { level: 4, name: '较高', color: '#fdae61' },
    { level: 5, name: '高',   color: '#d7191c' },
];

// 等级 → 徽章语义色（风险越低越"安全"，越高越"危险"）
function _levelBadgeType(lv) {
    if (lv >= 4) return 'danger';
    if (lv === 3) return 'warning';
    return 'success';
}

function _fmt(v) {
    if (v == null || (typeof v === 'number' && isNaN(v))) return '—';
    return Number(v).toLocaleString('zh-CN');
}
// 自适应大单位：>=1e8 用 yiLabel（亿级），>=1e4 用 wanLabel（万级），否则保留原单位；最多 2 位小数、去尾零
function _num2(x) {
    return Number(x.toFixed(2)).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}
function _scaled(v, baseUnit, wanLabel, yiLabel) {
    if (v == null || isNaN(v)) return { value: '—', unit: baseUnit };
    if (yiLabel && v >= 1e8) return { value: _num2(v / 1e8), unit: yiLabel };
    if (wanLabel && v >= 1e4) return { value: _num2(v / 1e4), unit: wanLabel };
    return { value: _fmt(v), unit: baseUnit };
}
function _scaledStr(v, baseUnit, wanLabel, yiLabel) {
    const r = _scaled(v, baseUnit, wanLabel, yiLabel);
    return r.value + (r.unit ? ' ' + r.unit : '');
}
function _pct(a, b) {
    if (!b) return '0%';
    return ((a / b) * 100).toFixed(1) + '%';
}

// 计算综合风险等级与评分
// 注意：相对分级(level_grid)各等级面积均衡，若直接对等级做面积加权会得到恒为 ~3 的伪评分(≈50)。
// 因此综合评分/等级优先采用后端返回的「绝对连续风险」面积加权均值(risk_mean_norm，按峰值归一化 0-1)。
function _computeRiskGrade(data) {
    const s = (data && data.stats) || {};
    const levels = (s.levels && s.levels.length)
        ? s.levels
        : RISK_LEVELS_JS.map(l => ({ ...l, pixels: 0, area_km2: 0, gdp_share: 0, pop_share: null }));
    // 主导等级：面积最大的等级（用于风险提示与概要）
    let maxArea = -1, dominant = levels[0];
    levels.forEach(l => { const a = l.area_km2 || 0; if (a > maxArea) { maxArea = a; dominant = l; } });

    // ① 绝对法（真实量级，会随数据变化）
    if (typeof s.risk_mean_norm === 'number' && !isNaN(s.risk_mean_norm)) {
        const score = Math.round(s.risk_mean_norm * 100);                 // 0-100
        const gradeLevel = Math.max(1, Math.min(5, Math.round(s.risk_mean_norm * 5)));
        const grade = levels.find(l => l.level === gradeLevel) || levels[2];
        return { meanLevel: s.risk_mean_norm * 5, score, gradeLevel, grade, dominant, absolute: true };
    }
    // ② 兜底（旧数据缺 risk_mean_norm）：等级面积加权平均
    const totalArea = s.total_flood_area_km2 || levels.reduce((a, l) => a + (l.area_km2 || 0), 0);
    let wsum = 0;
    levels.forEach(l => { wsum += l.level * (l.area_km2 || 0); });
    const meanLevel = totalArea > 0 ? wsum / totalArea : 0;
    const score = totalArea > 0 ? Math.round((meanLevel - 1) / 4 * 100) : 0;
    const gradeLevel = Math.max(1, Math.min(5, Math.round(meanLevel)));
    const grade = levels.find(l => l.level === gradeLevel) || dominant || levels[0];
    return { meanLevel, score, gradeLevel, grade, dominant, absolute: false };
}

// 侧栏熵权法说明区：评估后回填客观赋权结果（仅 entropy 方法显示）
function _showEntropyReadout(m) {
    const box = document.getElementById('flood-entropy-readout');
    if (!box) return;
    if ((m.weight_method || 'entropy') !== 'entropy') { box.innerHTML = ''; return; }
    const fmt = (o, defs) => defs
        .filter(([k]) => o && typeof o[k] === 'number' && isFinite(o[k]))
        .map(([k, label]) => `${label} ${(o[k] * 100).toFixed(0)}%`).join(' · ');
    const rw = fmt(m.risk_weights, [['hazard', 'H'], ['exposure', 'E'], ['vulnerability', 'V']]);
    const ew = fmt(m.exposure_weights, [['gdp', 'GDP'], ['pop', '人口'], ['arable', '耕地'], ['grain', '粮食'], ['livestock', '牲畜']]);
    const prior = m.risk_prior_weights
        ? fmt(m.risk_prior_weights, [['hazard', 'H'], ['exposure', 'E'], ['vulnerability', 'V']]) : null;
    const alpha = (typeof m.risk_prior_strength === 'number') ? m.risk_prior_strength : null;
    const note = (prior && alpha != null) ? `<div class="entropy-hybrid-note">熵权×AHP先验混合（先验 ${prior}；α=${alpha}）</div>` : '';
    box.innerHTML = `<div>综合风险：${rw || '—'}</div><div>暴露度：${ew || '—'}</div>${note}`;
}

// ① 概要文案
function _buildSummaryText(data, grade, startDate, endDate, basinText) {
    const s = (data && data.stats) || {}, m = (data && data.meta) || {};
    const scope = (m.basin && m.basin !== 'all') ? `评估范围：${basinText}。` : '评估范围：青藏高原全域。';
    const method = m.weight_method || 'entropy';
    const fmt = (o, defs) => defs
        .filter(([k]) => o && typeof o[k] === 'number' && isFinite(o[k]))
        .map(([k, label]) => `${label} ${(o[k] * 100).toFixed(0)}%`)
        .join('、');
    const rw = fmt(m.risk_weights, [['hazard', 'H'], ['exposure', 'E'], ['vulnerability', 'V']]);
    const ew = fmt(m.exposure_weights, [
        ['gdp', 'GDP'], ['pop', '人口'], ['arable', '耕地'], ['grain', '粮食'], ['livestock', '牲畜'],
    ]);
    const segs = [];
    if (rw) segs.push(`综合风险权重[${rw}]`);
    if (ew) segs.push(`暴露度权重[${ew}]`);
    const wt = segs.length ? ' ' + segs.join(' ') : '';
    const wtxt = method === 'custom'
        ? ` 采用自定义权重。${wt}`
        : ` 采用熵权×AHP先验混合自动赋权。${wt}`;
    return `评估期内淹没区综合风险评定为「${grade.grade.name}」（综合评分 ${grade.score}）。${scope}${wtxt}`;
}

// ③ 关键指标数据（5 维暴露真实汇总）
function _buildKeyIndicators(s, m) {
    // 注意：UI.statGrid 内部会对每个元素再调用 statCard，因此这里必须传「配置对象」而非已渲染的 HTML 字符串
    const area = _scaled(s.total_flood_area_km2 || 0, 'km²', '万km²', '亿km²');
    const gdp = _scaled(s.total_gdp_wan || 0, '万元', '亿元', '万亿元');
    const pop = (s.total_pop != null) ? _scaled(s.total_pop, '人', '万人', '亿人') : { value: '—', unit: '' };
    const arable = _scaled(s.total_arable_ha || 0, '公顷', '万公顷', '亿公顷');
    const grain = _scaled(s.total_grain_t || 0, '吨', '万吨', '亿吨');
    const livestock = _scaled(s.total_livestock_head || 0, '头', '万头', '亿头');
    const items = [
        { label: '淹没总面积', value: area.value, unit: area.unit, icon: 'fa-tint', accent: 'ice' },
        { label: '淹没区GDP总量', value: gdp.value, unit: gdp.unit, icon: 'fa-building', accent: 'warning' },
        { label: '淹没区人口', value: pop.value, unit: pop.unit, icon: 'fa-users', accent: 'danger' },
        { label: '淹没区耕地面积', value: arable.value, unit: arable.unit, icon: 'fa-leaf', accent: 'success' },
        { label: '淹没区粮食产量', value: grain.value, unit: grain.unit, icon: 'fa-tree', accent: 'success' },
        { label: '淹没区牲畜存栏', value: livestock.value, unit: livestock.unit, icon: 'fa-paw', accent: 'warning' },
    ];
    const grid = UI.statGrid(items);
    return grid;
}

// ④ 风险提示与建议（基于主导等级 + 暴露构成）
function _buildRiskTips(data, grade) {
    const s = (data && data.stats) || {};
    const tips = [];
    const lvl = grade.dominant.level;
    if (lvl >= 5) tips.push({ t: '综合风险高，建议立即启动防汛应急响应，对淹没区高危网格周边人员实施转移安置。', type: 'danger' });
    else if (lvl === 4) tips.push({ t: '综合风险较高，建议提前部署防汛物资与抢险队伍，加密淹没区监测频次。', type: 'danger' });
    else if (lvl === 3) tips.push({ t: '综合风险中等，建议加强雨情水情监测与值班，做好重点区域防御准备。', type: 'warning' });
    else tips.push({ t: '综合风险较低，保持常规监测即可，重点关注局地高值网格。', type: 'success' });

    if (s.total_pop && s.total_pop > 0) tips.push({ t: `淹没区涉及人口约 ${_scaledStr(s.total_pop, '人', '万人', '亿人')}，人员转移与安置应作为优先事项。`, type: 'warning' });
    if (s.total_gdp_wan) tips.push({ t: `淹没区 GDP 约 ${_scaledStr(s.total_gdp_wan, '万元', '亿元', '万亿元')}，建议优先保障重要基础设施与产业资产安全。`, type: 'info' });
    if (s.total_arable_ha || s.total_grain_t) tips.push({ t: `淹没区耕地 ${_scaledStr(s.total_arable_ha || 0, '公顷', '万公顷', '亿公顷')}、粮食 ${_scaledStr(s.total_grain_t || 0, '吨', '万吨', '亿吨')}，需关注农业损失与灾后补种。`, type: 'info' });
    if (s.total_livestock_head && s.total_livestock_head > 0) tips.push({ t: `淹没区牲畜存栏约 ${_scaledStr(s.total_livestock_head, '头', '万头', '亿头')}，需做好畜禽转移安置与集中圈舍防护。`, type: 'purple' });

    return `<div class="risk-tips-head"><i class="fa fa-lightbulb"></i> 风险提示与处置建议</div>` +
        `<ul class="risk-tips-list">${tips.map(x => `<li class="risk-tip risk-tip-${x.type}">${x.t}</li>`).join('')}</ul>`;
}

// 持久概览面板已按需求移除（评估详情统一在结果模态框内呈现）

function showRiskResultModal(data, startDate, endDate, basinText) {
    const modal = document.getElementById('risk-result-modal');
    const overlay = document.getElementById('risk-result-overlay');
    const sub = document.getElementById('risk-modal-sub');
    const hero = document.getElementById('risk-hero');
    const statsBox = document.getElementById('risk-stats');
    const tipsBox = document.getElementById('risk-tips');

    _lastModalArgs = [data, startDate, endDate, basinText];
    _riskExportData = data;
    sub.textContent = `${startDate} 至 ${endDate} | ${basinText}`;

    const s = data.stats || {}, m = data.meta || {};

    // ② 评分/等级 + ① 概要
    const grade = _computeRiskGrade(data);
    hero.innerHTML = '';
    const ringEl = UI.ring(grade.score, { size: 92, color: grade.grade.color, label: grade.score, sub: '综合评分' });
    hero.appendChild(ringEl);
    const info = document.createElement('div');
    info.className = 'risk-hero-info';
    info.innerHTML = `
        <div class="risk-hero-grade">
            ${UI.badge(`综合风险等级：${grade.grade.name}`, _levelBadgeType(grade.gradeLevel))}
            <span class="risk-hero-level">第 ${grade.gradeLevel} 级 / 5</span>
        </div>
        <div class="risk-hero-summary">${_buildSummaryText(data, grade, startDate, endDate, basinText)}</div>
    `;
    hero.appendChild(info);

    // ③ 关键指标数据（5 维暴露真实汇总）
    statsBox.innerHTML = _buildKeyIndicators(s, m);

    // ④ 风险提示与建议
    tipsBox.innerHTML = _buildRiskTips(data, grade);

    // 先显示弹窗，再初始化图表（否则容器不可见时 ECharts 宽度为 0，图不显示）
    modal.classList.add('active');
    overlay.classList.add('active');
    _hideRiskReopenBtn();

    // 记录当前等级数据并重置为默认维度（面积维度已移除），构建维度切换按钮后渲染饼图
    _riskChartData = s.levels || [];
    _riskChartDim = 'gdp';
    _buildChartToggle();
    _setRiskChartToggle();
    _renderRiskPie();
}

function hideRiskResultModal() {
    document.getElementById('risk-result-modal').classList.remove('active');
    document.getElementById('risk-result-overlay').classList.remove('active');
    if (_riskChart) { _riskChart.dispose(); _riskChart = null; }
    if (_lastModalArgs) _showRiskReopenBtn();
}

// 评估前缺少上游淹没数据时的阻断式引导面板（模拟→评估工作流串联）
function showNoInundationGuide(detail, startDate, endDate) {
    const old = document.getElementById('no-inundation-guide');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = 'no-inundation-guide';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(2,6,23,0.55);z-index:4000;display:flex;align-items:center;justify-content:center;';

    const stepText = {
        runoff: '上游缺失：径流模拟结果',
        flood_inundation: '上游缺失：洪水淹没范围',
        range_mismatch: '时段不匹配：现有淹没数据不在所选评估日期内',
    };
    const step = (detail && detail.missing_step) || 'flood_inundation';
    const stepLabel = stepText[step] || '上游缺失：洪水淹没范围';
    const msg = (detail && detail.message) ||
        '评估前须先生成洪水淹没范围（flood_inundation）数据。请前往「灾害过程模拟」运行径流模拟与淹没模拟后，再返回此处评估。';

    const card = document.createElement('div');
    card.style.cssText = 'width:min(520px,92vw);max-height:86vh;overflow:auto;background:#0f172a;border:1px solid rgba(148,163,184,0.25);border-radius:12px;box-shadow:0 12px 48px rgba(0,0,0,.55);padding:22px 24px;color:#e2e8f0;font-size:14px;line-height:1.65;';
    card.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
            <span style="display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:50%;background:rgba(250,204,21,0.15);color:#facc15;font-size:18px;">!</span>
            <div style="font-size:17px;font-weight:600;color:#f8fafc;">无法评估：缺少淹没范围数据</div>
        </div>
        <div style="font-size:12px;color:#94a3b8;margin-bottom:14px;">工作流前置依赖未满足</div>
        <div style="display:inline-block;padding:3px 10px;border-radius:999px;background:rgba(56,189,248,0.12);color:#7dd3fc;font-size:12px;margin-bottom:12px;">${stepLabel}</div>
        <div style="margin:0 0 16px;color:#cbd5e1;">${msg}</div>
        <div style="background:rgba(15,23,42,0.6);border:1px solid rgba(148,163,184,0.18);border-radius:8px;padding:10px 12px;font-size:12px;color:#94a3b8;margin-bottom:18px;">
            评估日期：<span style="color:#e2e8f0;">${startDate} ~ ${endDate}</span><br>
            完整流程：径流模拟 → 洪水淹没模拟（flood_inundation）→ 洪水灾害风险评估
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end;">
            <button id="no-inundation-close" style="padding:8px 16px;border:1px solid rgba(148,163,184,0.3);background:transparent;color:#cbd5e1;border-radius:8px;cursor:pointer;">关闭</button>
            <button id="no-inundation-go" style="padding:8px 16px;border:none;background:#2563eb;color:#fff;border-radius:8px;cursor:pointer;font-weight:600;">前往灾害过程模拟</button>
        </div>
    `;
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    card.querySelector('#no-inundation-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    card.querySelector('#no-inundation-go').addEventListener('click', () => {
        try {
            sessionStorage.setItem('pendingFloodSim', JSON.stringify({
                start: startDate, end: endDate, missing_step: step,
            }));
        } catch (e) { /* 忽略存储失败 */ }
        window.location.href = 'simulate.html?cat=flood-simulate';
    });
}

// 弹窗标题栏拖动
function _makeRiskModalDraggable() {
    const modal = document.getElementById('risk-result-modal');
    const header = modal.querySelector('.risk-result-modal-header');
    let dragging = false, startX = 0, startY = 0, origLeft = 0, origTop = 0;
    header.addEventListener('mousedown', (e) => {
        if (e.target.closest('button')) return;  // 点按钮不拖动
        dragging = true;
        const rect = modal.getBoundingClientRect();
        // 由 translate(-50%,-50%) 居中对齐切换为 left/top 定位，便于拖动
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

// 绑定结果面板事件（script 在 body 末尾，DOM 已就绪）
(function() {
    const closeBtn = document.getElementById('risk-modal-close');
    const minBtn = document.getElementById('risk-modal-min');
    const reopenBtn = document.getElementById('risk-modal-reopen');
    const overlay = document.getElementById('risk-result-overlay');
    if (closeBtn) closeBtn.addEventListener('click', hideRiskResultModal);
    if (minBtn) minBtn.addEventListener('click', hideRiskResultModal);
    if (overlay) overlay.addEventListener('click', hideRiskResultModal);
    if (reopenBtn) reopenBtn.addEventListener('click', () => {
        if (_lastModalArgs) showRiskResultModal(..._lastModalArgs);
    });

    // 饼图维度切换（事件委托，兼容动态生成的按钮）
    const toggleBox = document.getElementById('risk-chart-toggle');
    if (toggleBox) {
        toggleBox.addEventListener('click', (e) => {
            const btn = e.target.closest('.risk-chart-toggle-btn');
            if (!btn || btn.disabled) return;
            _riskChartDim = btn.dataset.dim;
            _setRiskChartToggle();
            _renderRiskPie();
        });
    }

    const exportCsvBtn = document.getElementById('risk-export-csv');
    const downloadTifBtn = document.getElementById('risk-download-tif');
    const exportChartBtn = document.getElementById('risk-export-chart');
    const goSimBtn = document.getElementById('risk-go-simulate');
    if (exportCsvBtn) exportCsvBtn.addEventListener('click', exportRiskCsv);
    if (downloadTifBtn) downloadTifBtn.addEventListener('click', downloadRiskTif);
    if (exportChartBtn) exportChartBtn.addEventListener('click', exportRiskChartPng);
    // ⑤ 操作引导：前往灾害过程模拟（与缺数据引导面板的工作流一致）
    if (goSimBtn) goSimBtn.addEventListener('click', () => {
        hideRiskResultModal();
        try { sessionStorage.setItem('pendingFloodSim', JSON.stringify({ from: 'risk-result' })); } catch (e) {}
        window.location.href = 'simulate.html?cat=flood-simulate';
    });

    _makeRiskModalDraggable();
})();