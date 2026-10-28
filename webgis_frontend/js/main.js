// -------- 底图切换相关 --------
// 高德瓦片服务地址：三个底图层共用同一 host，仅 style 参数不同。
// 收口为常量，换服务商/换 style 时只改这一处。
const AMAP_TILE_BASE = 'https://webst0{1-4}.is.autonavi.com/appmaptile';
const AMAP_TILE_URL = {
  // style=7 矢量底图
  normal: `${AMAP_TILE_BASE}?style=7&x={x}&y={y}&z={z}`,
  // style=6 卫星影像（hybrid 底层）
  satellite: `${AMAP_TILE_BASE}?style=6&x={x}&y={y}&z={z}`,
  // style=8 中文路网标注（hybrid 上层）
  roadnet: `${AMAP_TILE_BASE}?style=8&x={x}&y={y}&z={z}`
};

function createAMapLayer(type) {
  if (type === 'normal') {
    return new ol.layer.Tile({
      source: new ol.source.XYZ({
        url: AMAP_TILE_URL.normal,
        crossOrigin: 'anonymous'
      }),
      visible: false,
      title: 'amap-normal',
      type: 'normal-map',
      zIndex: 1
    });
  }

  if (type === 'hybrid') {
    // 卫星图图层（底层）
    const satellite = new ol.layer.Tile({
      source: new ol.source.XYZ({
        url: AMAP_TILE_URL.satellite,
        crossOrigin: 'anonymous'
      }),
      visible: true,
      title: 'amap-hybrid-satellite',
      type: 'satellite-map',
      zIndex: 1
    });

    // 中文路网标注层（上层，style=8 显示中文文字和河流）
    const roadnet = new ol.layer.Tile({
      source: new ol.source.XYZ({
        url: AMAP_TILE_URL.roadnet,
        crossOrigin: 'anonymous'
      }),
      visible: true,
      title: 'amap-hybrid-roadnet',
      type: 'roadnet-map',
      zIndex: 2
      // opacity: 0.6  // 已去掉，保证中文标注清晰
    });

    return [satellite, roadnet];
  }
}

// 图层配置
let baseLayers = {
  'normal': createAMapLayer('normal'),
  'hybrid': createAMapLayer('hybrid')
};

// 存储专题图层引用
let basinLayer = window.basinLayer = null;
let basin5Layer = window.basin5Layer = null;
let riverLayer = window.riverLayer = null;
let cmaLayer = window.cmaLayer = null;
// 气象站图层控制变量
let weatherStationLayer = null;
// 湖泊图层控制变量
let lakeLayer = null;
// 冻土图层控制变量
let permafrostLayer = null;
let glacierLayer = null;
// 青藏高原边界图层控制变量（loadTPChinaData 使用；tpChinaLoading 防并发重复加载）
let tpChinaLayer = null;
let tpChinaLoading = false;
// 铁路图层控制变量
let railwayLayer = null;
// 公路图层控制变量
let roadLayer = null;
// 居民地图层控制变量
let settlementLayer = null;
// 地市级居民地图层控制变量
let citySettlementLayer = null;
// 首都和省级行政中心图层控制变量
let capitalSettlementLayer = null;
// 行政边界图层控制变量
let boundaryCountryLayer = null;
let boundaryProvinceLayer = null;
let boundaryCityLayer = null;
let boundaryCountyLayer = null;
// 经济数据图层控制变量
let economyLayer = null;
let powerplantLayer = null;
let damLayer = null;
let reservoirLayer = null;
// 冰冻圈图层控制变量
let snowDepthLayer = null;
let snowWaterEquivalentLayer = null;
let snowCoverLayer = null;
let snowDensityLayer = null;

// 存储原始数据源，用于过滤
let originalRiverSource = null;
let originalCmaSource = null;
let originalWeatherStationSource = null;

// OpenLayers 地图
const map = window.map = new ol.Map({
  target: 'map',
  layers: [
    ...baseLayers['hybrid'],
    baseLayers['normal']
  ],
  view: new ol.View({
    // 子页面（非首页）默认聚焦位置（用户设定：东经94.1691度，北纬32.8524度，缩放5.5）
    center: ol.proj.fromLonLat([94.1691, 32.8524]),
    zoom: 5.5
  }),
  controls: []
});

// 初始设置：只显示普通地图
baseLayers['normal'].setVisible(true);
baseLayers['hybrid'].forEach(layer => layer.setVisible(false));

// 当前是否首页：首页加载完整的流域要素；其他页面只加载默认青藏高原边界以提升性能
const isHomePage = window.location.pathname.endsWith('index.html') ||
                   window.location.pathname.endsWith('/') ||
                   window.location.pathname === '';

// 首页与子页面使用不同的默认聚焦位置（用户分别设定）
if (isHomePage) {
  // 首页：聚焦青藏高原西部（东经84.7950度，北纬32.9394度，缩放5.5）
  map.getView().setCenter(ol.proj.fromLonLat([84.7950, 32.9394]));
  map.getView().setZoom(5.5);
}
// 非首页（query/simulate/alert/decision 等）保持上面 View 定义的东部默认聚焦
// （东经94.1691度，北纬32.8524度，缩放5.5）

// 底图切换函数
function switchBasemap(type) {
  baseLayers['normal'].setVisible(false);
  baseLayers['hybrid'].forEach(layer => layer.setVisible(false));

  if (type === 'normal') {
    baseLayers['normal'].setVisible(true);
    document.getElementById('btn-map').classList.add('active');
    document.getElementById('btn-mix').classList.remove('active');
  } else if (type === 'hybrid') {
    baseLayers['hybrid'].forEach(layer => layer.setVisible(true));
    document.getElementById('btn-map').classList.remove('active');
    document.getElementById('btn-mix').classList.add('active');
    
    // 如果是第一次切换到卫星地图，创建高程图例
    if (!elevationLegendControl) {
      createElevationLegend();
    } else {
      // 否则更新图例内容
      createElevationLegend();
    }
  }

  // 更新高程图例可见性
  updateElevationLegendVisibility();
  
  map.render();
  // 添加底图切换成功提示
  const mapType = type === 'normal' ? '普通地图' : '卫星地图';
  console.log(`已切换到${mapType}！`);
}

// 右侧按钮联动
document.getElementById('btn-map').addEventListener('click', function () {
  switchBasemap('normal');
});
document.getElementById('btn-mix').addEventListener('click', function () {
  switchBasemap('hybrid');
});

// ============ 页面要素加载跟踪器（系统加载动效） ============
// 替代原来的假定时器逻辑：当前页面注册的所有要素都加载完成后，才移除加载动画。
// 首页要素多（流域/河网/湖泊/冻土/冰川/TP边界等），其他页面要素少（TP边界等）。
// 通过 tag 去重：同一要素因默认勾选+按需加载被触发多次也只计一次，防止总数虚增。
const pageLoadState = {
  tasks: {},        // tag -> true（已注册的要素）
  completed: {},    // tag -> true（已完成的要素）
  init: false,      // 系统加载动效是否已开启（锁定文案/遮罩，见 showLoading）
  started: false,  // 是否已开始跟踪
  finished: false,  // 是否已全部完成

  // 注册一个待加载要素（在对应加载函数开始处调用；同一 tag 去重）
  register(tag) {
    if (this.tasks[tag]) return;
    this.tasks[tag] = true;
    if (this.started) this.check();
  },
  // 标记一个要素加载完成（在对应加载函数所有成功/失败出口调用；同一 tag 只计一次）
  complete(tag) {
    if (!this.tasks[tag] || this.completed[tag]) return;
    this.completed[tag] = true;
    if (this.started) this.check();
  },
  // 开始跟踪：当前页面所有要素的加载函数都已被触发后调用
  start() {
    if (this.started) return;
    this.started = true;
    this.check();
  },
  check() {
    if (this.finished || !this.started) return;
    if (Object.keys(this.completed).length >= Object.keys(this.tasks).length) {
      this.finish();
    }
  },
  finish() {
    if (this.finished) return;
    this.finished = true;
    console.log(`[系统加载] 页面要素加载完成（${Object.keys(this.completed).length}/${Object.keys(this.tasks).length}），移除加载动画`);
    // 延迟一小段，等待页面渲染稳定后再隐藏遮罩
    setTimeout(() => showLoading(false), 200);
  }
};

// 页面加载完成后执行系统级初始化（所有页面通用：打开即显示加载动效，要素加载完才移除）
document.addEventListener('DOMContentLoaded', function () {
  // 所有页面打开时立即显示系统加载动效，文案固定为"系统正在加载"
  showLoading(true, '系统正在加载，请稍候...');
  // 立即锁定：在全部要素加载完成前，忽略单个要素的加载提示/提前隐藏（见 showLoading 守卫）
  pageLoadState.init = true;
  console.log('🌐 开始系统级加载流程...');
});


// ---------- 其它业务代码 ----------
// 经济数据加载函数
function loadEconomyData() {
  showLoading(true, '正在加载经济数据...');
  
  // 优先从GEO文件加载经济数据
  fetch('/data/raw/geo/socioeconomic/economy_counties.geojson')
    .then(res => {
      if (!res.ok) throw new Error('经济数据GEO文件加载失败');
      return res.json();
    })
    .then(geoData => {
      console.log('经济数据GEO文件加载成功，特征数量:', geoData.features ? geoData.features.length : 0);
      // 直接从GEO文件创建气泡图图层
      createEconomyBubbleLayerFromGeoJSON(geoData);
      showLoading(false);
    })
    .catch(error => {
      console.error('经济数据GEO文件加载失败，回退到API方式:', error);
      // 回退到原来的API方式
      loadEconomyDataFallback();
    });
}

// 回退加载函数（API方式）
function loadEconomyDataFallback() {
  // 同时加载GDP数据和县区中心点数据
  Promise.all([
    fetch('/api/economy/gdp_data').then(res => res.json()),
    fetch('/data/raw/geo/settlement/XianCh_point.geojson').then(res => res.json())
  ])
  .then(([gdpData, countyData]) => {
    // 处理经济数据，创建气泡图图层
    createEconomyBubbleLayer(gdpData, countyData);
    showLoading(false);
  })
  .catch(error => {
    console.error('经济数据加载失败:', error);
    showLoading(false);
  });
}

// 加载能源站点数据
function loadPowerplantData() {
  showLoading(true, '正在加载能源站点数据...');
  
  // 从API加载能源站点数据
  fetch('/api/economy/powerplant_data')
    .then(res => {
      if (!res.ok) throw new Error('能源站点数据加载失败');
      return res.json();
    })
    .then(powerplantData => {
      console.log('能源站点数据加载成功，数量:', powerplantData.length);
      // 创建能源站点图层
      createPowerplantLayer(powerplantData);
      showLoading(false);
    })
    .catch(error => {
      console.error('能源站点数据加载失败:', error);
      showLoading(false);
    });
}

// 创建能源站点图层
function createPowerplantLayer(powerplantData) {
  // 创建矢量数据源
  const vectorSource = new ol.source.Vector();
  
  // 处理能源站点数据
  powerplantData.forEach(item => {
    const name = item.name || '未知站点';
    const type = item.type || '未知类型';
    const capacity = item.capacity || 0;
    const geometry = item.geometry || {};
    
    // 确保有坐标数据
    if (geometry.type === 'Point' && geometry.coordinates && geometry.coordinates.length === 2) {
      try {
        // 转换坐标到地图投影
        const coordinates = ol.proj.fromLonLat([
          geometry.coordinates[0],
          geometry.coordinates[1]
        ]);
        
        // 创建站点特征
        const feature = new ol.Feature({
          geometry: new ol.geom.Point(coordinates),
          name: name,
          type: type,
          commission: item.commission || '',
          capacity: capacity
        });
        
        vectorSource.addFeature(feature);
      } catch (error) {
        console.error('创建能源站点特征失败:', error, '站点数据:', item);
      }
    }
  });
  
  console.log('创建的能源站点特征数量:', vectorSource.getFeatures().length);
  
  // 创建能源站点图层
  powerplantLayer = new ol.layer.Vector({
    source: vectorSource,
    style: createPowerplantStyle,
    type: 'powerplant-layer',
    zIndex: 55
  });
  
  map.addLayer(powerplantLayer);
  
  // 添加交互功能
  addPowerplantInteraction();
  
  console.log('能源站点图层加载完成！');
}

// 创建能源站点样式
function createPowerplantStyle(feature) {
  const type = feature.get('type') || '未知类型';
  let color = '#FF0000'; // 默认红色
  
  // 根据能源类型设置不同颜色
  switch (type.toLowerCase()) {
    case '水力发电':
    case 'hydro':
    case 'water':
      color = '#1E90FF'; // 蓝色
      break;
    case '风力发电':
    case 'wind':
    case 'wind power':
      color = '#32CD32'; // 绿色
      break;
    case '太阳能发电':
    case 'solar':
    case 'solar power':
      color = '#FFD700'; // 金色
      break;
    case '火力发电':
    case 'thermal':
    case 'coal':
    case 'fossil fuel':
      color = '#FF4500'; // 橙色
      break;
    case '核能发电':
    case 'nuclear':
    case 'nuclear power':
      color = '#9932CC'; // 紫色
      break;
  }
  
  return new ol.style.Style({
    image: new ol.style.Circle({
      radius: 6,
      fill: new ol.style.Fill({
        color: color
      }),
      stroke: new ol.style.Stroke({
        color: '#FFFFFF',
        width: 2
      })
    })
    // 移除文本显示，不在地图上显示站点名称
  });
}

// 添加能源站点交互功能
function addPowerplantInteraction() {
  // 添加点击弹出信息框，限定只响应能源站点图层
  const clickInteraction = new ol.interaction.Select({
    condition: ol.events.condition.click,
    layers: [powerplantLayer]
  });

  clickInteraction.on('select', function(e) {
    if (e.selected.length > 0) {
      const feature = e.selected[0];
      showPowerplantPopup(feature);
    }
  });

  map.addInteraction(clickInteraction);
}

// 显示能源站点弹出信息框
function showPowerplantPopup(feature) {
  // 获取特征坐标
  const geometry = feature.getGeometry();
  const coordinates = geometry.getCoordinates();
  
  // 获取站点信息
  const name = feature.get('name') || '未知站点';
  const type = feature.get('type') || '未知类型';
  const commission = feature.get('commission') || '未知年份';
  
  // 能源类型中文转换
  const typeMapping = {
    'Coal': '煤炭',
    'Hydro': '水力',
    'Wind': '风力',
    'Solar': '太阳能',
    'Nuclear': '核能',
    'Gas': '天然气',
    'Oil': '石油',
    'Biomass': '生物质能',
    'Geothermal': '地热能'
  };
  
  const chineseType = typeMapping[type] || type;
  
  // 构建弹窗内容
  let content = '<div class="disaster-popup-container">';
  content += '<div class="disaster-popup">';
  content += '<div class="popup-header">';
  content += '<h3>能源站点详情</h3>';
  content += '<button class="close-popup" title="关闭">&times;</button>';
  content += '</div>';
  
  content += `<p><strong>站点名称:</strong> ${name}</p>`;
  content += `<p><strong>能源类型:</strong> ${chineseType}</p>`;
  content += `<p><strong>启用时间:</strong> ${commission}</p>`;
  
  content += '</div>';
  content += '</div>';
  
  // 创建弹窗元素
  const popupElement = document.createElement('div');
  popupElement.innerHTML = content;
  
  // 关闭按钮事件
  const closeButton = popupElement.querySelector('.close-popup');
  closeButton.addEventListener('click', function() {
    if (window.powerplantPopup) {
      window.map.removeOverlay(window.powerplantPopup);
      window.powerplantPopup = null;
    }
  });
  
  // 移除现有的弹窗
  if (window.powerplantPopup) {
    window.map.removeOverlay(window.powerplantPopup);
  }
  
  // 创建新弹窗
  window.powerplantPopup = new ol.Overlay({
    element: popupElement,
    positioning: 'bottom-center',
    stopEvent: false,
    offset: [0, -10]
  });
  
  window.map.addOverlay(window.powerplantPopup);
  window.powerplantPopup.setPosition(coordinates);
  
  // 点击地图其他地方关闭弹窗
  window.map.on('click', function(e) {
    if (window.powerplantPopup && !popupElement.contains(e.originalEvent.target)) {
      window.map.removeOverlay(window.powerplantPopup);
      window.powerplantPopup = null;
    }
  });
}

// 加载水坝数据
function loadDamData() {
  showLoading(true, '正在加载水坝数据...');
  
  // 从API加载水坝数据
  fetch('/api/economy/dam_data')
    .then(res => {
      if (!res.ok) throw new Error('水坝数据加载失败');
      return res.json();
    })
    .then(damData => {
      console.log('水坝数据加载成功，数量:', damData.length);
      // 创建水坝图层
      createDamLayer(damData);
      showLoading(false);
    })
    .catch(error => {
      console.error('水坝数据加载失败:', error);
      showLoading(false);
    });
}

// 创建水坝图层
function createDamLayer(damData) {
  // 创建矢量数据源
  const vectorSource = new ol.source.Vector();
  
  // 处理水坝数据
  damData.forEach(item => {
    const name = item.name || '未知水坝';
    const river = item.river || '未知河流';
    const geometry = item.geometry || {};
    
    // 确保有坐标数据
    if (geometry.type === 'Point' && geometry.coordinates && geometry.coordinates.length === 2) {
      try {
        // 转换坐标到地图投影
        const coordinates = ol.proj.fromLonLat([
          geometry.coordinates[0],
          geometry.coordinates[1]
        ]);
        
        // 创建水坝特征
        const feature = new ol.Feature({
          geometry: new ol.geom.Point(coordinates),
          name: name,
          river: river,
          country: item.country || '',
          admin_unit: item.admin_unit || '',
          year_built: item.year_built || '',
          year_txt: item.year_txt || '',
          dam_height: item.dam_height || 0,
          dam_length: item.dam_length || 0,
          capacity: item.capacity || 0,
          power: item.power || 0,
          main_use: item.main_use || ''
        });
        
        vectorSource.addFeature(feature);
      } catch (error) {
        console.error('创建水坝特征失败:', error, '水坝数据:', item);
      }
    }
  });
  
  console.log('创建的水坝特征数量:', vectorSource.getFeatures().length);
  
  // 创建水坝图层
  damLayer = new ol.layer.Vector({
    source: vectorSource,
    style: createDamStyle,
    type: 'dam-layer',
    zIndex: 60
  });
  
  map.addLayer(damLayer);
  
  // 添加交互功能
  addDamInteraction();
  
  console.log('水坝图层加载完成！');
}

// 创建水坝样式
function createDamStyle(feature) {
  return new ol.style.Style({
    image: new ol.style.Circle({
      radius: 7,
      fill: new ol.style.Fill({
        color: '#FF6B35' // 统一使用橙色
      }),
      stroke: new ol.style.Stroke({
        color: '#FFFFFF',
        width: 2
      })
    })
    // 不在地图上显示名称，保持简洁
  });
}

// 添加水坝交互功能
function addDamInteraction() {
  // 添加点击弹出信息框
  const clickInteraction = new ol.interaction.Select({
    condition: ol.events.condition.click,
    layers: [damLayer] // 只监听水坝图层
  });
  
  clickInteraction.on('select', function(e) {
    if (e.selected.length > 0) {
      const feature = e.selected[0];
      showDamPopup(feature);
    }
  });
  
  map.addInteraction(clickInteraction);
}

// 显示水坝弹出信息框
function showDamPopup(feature) {
  // 获取特征坐标
  const geometry = feature.getGeometry();
  const coordinates = geometry.getCoordinates();
  
  // 获取水坝信息
  const name = feature.get('name') || '未知水坝';
  const river = feature.get('river') || '未知河流';
  const country = feature.get('country') || '未知国家';
  const adminUnit = feature.get('admin_unit') || '未知地区';
  const yearBuilt = feature.get('year_built') || '未知年份';
  const yearTxt = feature.get('year_txt') || '';
  const damHeight = feature.get('dam_height') || 0;
  const damLength = feature.get('dam_length') || 0;
  const capacity = feature.get('capacity') || 0;
  const power = feature.get('power') || 0;
  const mainUse = feature.get('main_use') || '未知用途';
  
  // 用途中文转换
  const useMapping = {
    'Hydroelectricity': '水力发电',
    'Flood Control': '防洪',
    'Irrigation': '灌溉',
    'Water Supply': '供水',
    'Navigation': '航运',
    'Recreation': '娱乐'
  };
  
  const chineseUse = useMapping[mainUse] || mainUse;
  
  // 构建弹窗内容
  let content = '<div class="disaster-popup-container">';
  content += '<div class="disaster-popup">';
  content += '<div class="popup-header">';
  content += '<h3>水坝详情</h3>';
  content += '<button class="close-popup" title="关闭">&times;</button>';
  content += '</div>';
  
  content += `<p><strong>水坝名称:</strong> ${name}</p>`;
  content += `<p><strong>所属河流:</strong> ${river}</p>`;
  content += `<p><strong>国家:</strong> ${country}</p>`;
  content += `<p><strong>地区:</strong> ${adminUnit}</p>`;
  if (yearBuilt !== -99) {
    content += `<p><strong>建成年份:</strong> ${yearBuilt} ${yearTxt}</p>`;
  }
  if (damHeight !== -99) {
    content += `<p><strong>坝高:</strong> ${damHeight} 米</p>`;
  }
  if (damLength !== -99) {
    content += `<p><strong>坝长:</strong> ${damLength} 米</p>`;
  }
  if (capacity !== -99) {
    content += `<p><strong>库容:</strong> ${capacity} 万立方米</p>`;
  }
  if (power !== -99) {
    content += `<p><strong>装机容量:</strong> ${power} MW</p>`;
  }
  content += `<p><strong>主要用途:</strong> ${chineseUse}</p>`;
  
  content += '</div>';
  content += '</div>';
  
  // 创建弹窗元素
  const popupElement = document.createElement('div');
  popupElement.innerHTML = content;
  
  // 关闭按钮事件
  const closeButton = popupElement.querySelector('.close-popup');
  closeButton.addEventListener('click', function() {
    if (window.damPopup) {
      window.map.removeOverlay(window.damPopup);
      window.damPopup = null;
    }
  });
  
  // 移除现有的弹窗
  if (window.damPopup) {
    window.map.removeOverlay(window.damPopup);
  }
  
  // 创建新弹窗
  window.damPopup = new ol.Overlay({
    element: popupElement,
    positioning: 'bottom-center',
    stopEvent: false,
    offset: [0, -10]
  });
  
  window.map.addOverlay(window.damPopup);
  window.damPopup.setPosition(coordinates);
  
  // 点击地图其他地方关闭弹窗
  window.map.on('click', function(e) {
    if (window.damPopup && !popupElement.contains(e.originalEvent.target)) {
      window.map.removeOverlay(window.damPopup);
      window.damPopup = null;
    }
  });
}

// 加载水库数据
function loadReservoirData() {
  showLoading(true, '正在加载水库数据...');
  
  // 从API加载水库数据
  fetch('/api/economy/reservoir_data')
    .then(res => {
      if (!res.ok) throw new Error('水库数据加载失败');
      return res.json();
    })
    .then(reservoirData => {
      console.log('水库数据加载成功，数量:', reservoirData.length);
      // 创建水库图层
      createReservoirLayer(reservoirData);
      showLoading(false);
    })
    .catch(error => {
      console.error('水库数据加载失败:', error);
      showLoading(false);
    });
}

// 创建水库图层
function createReservoirLayer(reservoirData) {
  // 创建矢量数据源
  const vectorSource = new ol.source.Vector();
  
  // 处理水库数据
  reservoirData.forEach(item => {
    const name = item.name || '未知水库';
    const river = item.river || '未知河流';
    const geometry = item.geometry || {};
    
    // 确保有坐标数据
    if (geometry.type === 'Polygon' && geometry.coordinates && geometry.coordinates.length > 0) {
      try {
        // 转换坐标到地图投影
        const coordinates = geometry.coordinates.map(ring => {
          return ring.map(point => ol.proj.fromLonLat(point));
        });
        
        // 创建水库特征
        const feature = new ol.Feature({
          geometry: new ol.geom.Polygon(coordinates),
          name: name,
          river: river,
          country: item.country || '',
          admin_unit: item.admin_unit || '',
          year_built: item.year_built || '',
          year_txt: item.year_txt || '',
          area: item.area || 0,
          capacity: item.capacity || 0,
          depth: item.depth || 0,
          power: item.power || 0,
          main_use: item.main_use || ''
        });
        
        vectorSource.addFeature(feature);
      } catch (error) {
        console.error('创建水库特征失败:', error, '水库数据:', item);
      }
    }
  });
  
  console.log('创建的水库特征数量:', vectorSource.getFeatures().length);
  
  // 创建水库图层
  reservoirLayer = new ol.layer.Vector({
    source: vectorSource,
    style: createReservoirStyle,
    type: 'reservoir-layer',
    zIndex: 50
  });
  
  map.addLayer(reservoirLayer);
  
  // 添加交互功能
  addReservoirInteraction();
  
  console.log('水库图层加载完成！');
}

// 创建水库样式
function createReservoirStyle(feature) {
  return new ol.style.Style({
    stroke: new ol.style.Stroke({
      color: '#FF6B35', // 橙色边框
      width: 2
    }),
    fill: new ol.style.Fill({
      color: 'rgba(255, 107, 53, 0.3)' // 半透明橙色填充
    })
  });
}

// 添加水库交互功能
function addReservoirInteraction() {
  // 添加点击弹出信息框
  const clickInteraction = new ol.interaction.Select({
    condition: ol.events.condition.click,
    layers: [reservoirLayer] // 只监听水库图层
  });
  
  clickInteraction.on('select', function(e) {
    if (e.selected.length > 0) {
      const feature = e.selected[0];
      showReservoirPopup(feature);
    }
  });
  
  map.addInteraction(clickInteraction);
}

// 显示水库弹出信息框
function showReservoirPopup(feature) {
  // 获取特征中心坐标
  const geometry = feature.getGeometry();
  const coordinates = geometry.getFirstCoordinate();
  
  // 获取水库信息
  const name = feature.get('name') || '未知水库';
  const river = feature.get('river') || '未知河流';
  const country = feature.get('country') || '未知国家';
  const adminUnit = feature.get('admin_unit') || '未知地区';
  const yearBuilt = feature.get('year_built') || '未知年份';
  const yearTxt = feature.get('year_txt') || '';
  const area = feature.get('area') || 0;
  const capacity = feature.get('capacity') || 0;
  const depth = feature.get('depth') || 0;
  const power = feature.get('power') || 0;
  const mainUse = feature.get('main_use') || '未知用途';
  
  // 用途中文转换
  const useMapping = {
    'Hydroelectricity': '水力发电',
    'Flood Control': '防洪',
    'Irrigation': '灌溉',
    'Water Supply': '供水',
    'Navigation': '航运',
    'Recreation': '娱乐'
  };
  
  const chineseUse = useMapping[mainUse] || mainUse;
  
  // 构建弹窗内容
  let content = '<div class="disaster-popup-container">';
  content += '<div class="disaster-popup">';
  content += '<div class="popup-header">';
  content += '<h3>水库详情</h3>';
  content += '<button class="close-popup" title="关闭">&times;</button>';
  content += '</div>';
  
  content += `<p><strong>水库名称:</strong> ${name}</p>`;
  content += `<p><strong>所属河流:</strong> ${river}</p>`;
  content += `<p><strong>国家:</strong> ${country}</p>`;
  content += `<p><strong>地区:</strong> ${adminUnit}</p>`;
  if (yearBuilt !== -99) {
    content += `<p><strong>建成年份:</strong> ${yearBuilt} ${yearTxt}</p>`;
  }
  if (area !== -99) {
    content += `<p><strong>面积:</strong> ${area} 平方公里</p>`;
  }
  if (capacity !== -99) {
    content += `<p><strong>库容:</strong> ${capacity} 万立方米</p>`;
  }
  if (depth !== -99) {
    content += `<p><strong>平均水深:</strong> ${depth} 米</p>`;
  }
  if (power !== -99) {
    content += `<p><strong>装机容量:</strong> ${power} MW</p>`;
  }
  content += `<p><strong>主要用途:</strong> ${chineseUse}</p>`;
  
  content += '</div>';
  content += '</div>';
  
  // 创建弹窗元素
  const popupElement = document.createElement('div');
  popupElement.innerHTML = content;
  
  // 关闭按钮事件
  const closeButton = popupElement.querySelector('.close-popup');
  closeButton.addEventListener('click', function() {
    if (window.reservoirPopup) {
      window.map.removeOverlay(window.reservoirPopup);
      window.reservoirPopup = null;
    }
  });
  
  // 移除现有的弹窗
  if (window.reservoirPopup) {
    window.map.removeOverlay(window.reservoirPopup);
  }
  
  // 创建新弹窗
  window.reservoirPopup = new ol.Overlay({
    element: popupElement,
    positioning: 'bottom-center',
    stopEvent: false,
    offset: [0, -10]
  });
  
  window.map.addOverlay(window.reservoirPopup);
  window.reservoirPopup.setPosition(coordinates);
  
  // 点击地图其他地方关闭弹窗
  window.map.on('click', function(e) {
    if (window.reservoirPopup && !popupElement.contains(e.originalEvent.target)) {
      window.map.removeOverlay(window.reservoirPopup);
      window.reservoirPopup = null;
    }
  });
}

// 从GEO文件创建经济数据气泡图层
function createEconomyBubbleLayerFromGeoJSON(geoData) {
  // 创建矢量数据源
  const vectorSource = new ol.source.Vector();
  
  // 用于去重，避免重复显示同一个县
  const processedCounties = new Set();
  
  console.log('GEO文件特征数量:', geoData.features ? geoData.features.length : 0);
  
  // 直接从GEO文件处理特征数据
  geoData.features.forEach(feature => {
    const properties = feature.properties;
    // 优先使用中文县名，显示更友好的名称
    const county = properties.NAME_DECODED || properties.NAME || properties.PYNAME || properties.county || '';
    
    // 跳过重复的县
    if (processedCounties.has(county)) {
      return;
    }
    processedCounties.add(county);
    
    // 计算最新GDP（2015年数据）
    const gdp2015 = parseFloat(properties['GDP_2015'] || 0);
    const gdp2000 = parseFloat(properties['GDP_2000'] || 0);
    
    // 计算年均增长率
    const growth_rate = gdp2000 > 0 ? ((gdp2015 / gdp2000) ** (1/15) - 1) * 100 : 0;
    
    if (county && gdp2015 > 0) {
      // 数据已经是EPSG:3857投影坐标，直接使用
      const coordinates = feature.geometry.coordinates;
      
      // 创建气泡特征
      const bubbleFeature = new ol.Feature({
        geometry: new ol.geom.Point(coordinates),
        county: county,
        latest_gdp: gdp2015,
        growth_rate: growth_rate,
        all_years: {
          2000: gdp2000,
          2001: parseFloat(properties['GDP_2001'] || 0),
          2002: parseFloat(properties['GDP_2002'] || 0),
          2003: parseFloat(properties['GDP_2003'] || 0),
          2004: parseFloat(properties['GDP_2004'] || 0),
          2005: parseFloat(properties['GDP_2005'] || 0),
          2006: parseFloat(properties['GDP_2006'] || 0),
          2007: parseFloat(properties['GDP_2007'] || 0),
          2008: parseFloat(properties['GDP_2008'] || 0),
          2009: parseFloat(properties['GDP_2009'] || 0),
          2010: parseFloat(properties['GDP_2010'] || 0),
          2011: parseFloat(properties['GDP_2011'] || 0),
          2012: parseFloat(properties['GDP_2012'] || 0),
          2013: parseFloat(properties['GDP_2013'] || 0),
          2014: parseFloat(properties['GDP_2014'] || 0),
          2015: gdp2015
        }
      });
      
      vectorSource.addFeature(bubbleFeature);
      console.log('添加经济数据点:', county, 'GDP:', gdp2015, '坐标:', coordinates);
    }
  });
  
  console.log('创建的经济数据特征数量:', vectorSource.getFeatures().length);
  
  // 创建气泡图层
  economyLayer = new ol.layer.Vector({
    source: vectorSource,
    style: createEconomyBubbleStyle,
    type: 'economy-layer',
    zIndex: 50
  });
  
  map.addLayer(economyLayer);
  
  // 添加交互功能
  addEconomyInteraction();
  
  console.log('经济数据气泡图（GEO文件）加载完成！特征数量:', vectorSource.getFeatures().length);
}

// 创建经济数据气泡图层（API方式）
function createEconomyBubbleLayer(gdpData, countyData) {
  // 创建矢量数据源
  const vectorSource = new ol.source.Vector();
  
  // 处理县区中心点数据，添加经济属性
  countyData.features.forEach(feature => {
    // 使用拼音名称进行匹配，因为中文名称有编码问题
    const pinyinName = feature.properties.PYNAME || '';
    
    // 将拼音名称转换为与GDP数据匹配的格式（去掉空格，转换为小写）
    const normalizedPinyin = pinyinName.replace(/\s+/g, '').toLowerCase();
    
    // 查找匹配的GDP数据
    const countyGDPData = gdpData.find(item => {
      const itemCounty = item.county || '';
      const normalizedItemCounty = itemCounty.replace(/\s+/g, '').toLowerCase();
      
      // 使用包含匹配，因为名称可能有细微差异
      return normalizedPinyin.includes(normalizedItemCounty) || 
             normalizedItemCounty.includes(normalizedPinyin) ||
             normalizedPinyin === normalizedItemCounty;
    });
    
    if (countyGDPData) {
      // 创建气泡特征
      const bubbleFeature = new ol.Feature({
        geometry: new ol.geom.Point(ol.proj.fromLonLat([
          feature.geometry.coordinates[0],
          feature.geometry.coordinates[1]
        ])),
        county: countyGDPData.county, // 使用GDP数据中的县区名称
        latest_gdp: countyGDPData.latest_gdp,
        growth_rate: countyGDPData.growth_rate,
        all_years: countyGDPData.all_years
      });
      
      vectorSource.addFeature(bubbleFeature);
    }
  });
  
  // 创建气泡图层
  economyLayer = new ol.layer.Vector({
    source: vectorSource,
    style: createEconomyBubbleStyle,
    type: 'economy-layer',
    zIndex: 50
  });
  
  map.addLayer(economyLayer);
  
  // 添加交互功能
  addEconomyInteraction();
  
  console.log('经济数据气泡图（API方式）加载完成！');
}

// 创建经济数据圆圈样式（类似水文站点）
function createEconomyBubbleStyle(feature) {
  const county = feature.get('county') || '未知县区';
  const gdp = feature.get('latest_gdp') || 0;
  const growthRate = feature.get('growth_rate') || 0;
  
  // 所有GDP数据都使用橙色显示
  const color = '#FFA500'; // 橙色
  
  return new ol.style.Style({
    // 点样式 - 调小气泡大小
    image: new ol.style.Circle({
      radius: 5, // 调小半径
      fill: new ol.style.Fill({
        color: color
      }),
      stroke: new ol.style.Stroke({
        color: '#000000', // 黑色边框
        width: 1
      })
    }),
    // 文字标签样式 - 显示县区名称
    text: new ol.style.Text({
      text: county,
      font: 'bold 10px Microsoft YaHei, sans-serif',
      fill: new ol.style.Fill({
        color: '#000000' // 黑色文字
      }),
      stroke: new ol.style.Stroke({
        color: '#FFFFFF',
        width: 2
      }),
      offsetY: 20, // 调整偏移量
      offsetX: 0,
      padding: [2, 5, 2, 5]
    })
  });
}

// 添加经济数据交互功能
function addEconomyInteraction() {
  // 添加点击弹出信息框，限定只响应经济数据图层
  const clickInteraction = new ol.interaction.Select({
    condition: ol.events.condition.click,
    layers: [economyLayer]
  });

  clickInteraction.on('select', function(e) {
    if (e.selected.length > 0) {
      const feature = e.selected[0];
      showEconomyPopup(feature);
    }
  });

  map.addInteraction(clickInteraction);
}

// 显示经济数据弹出信息框
function showEconomyPopup(feature) {
  // 获取特征坐标
  const geometry = feature.getGeometry();
  const coordinates = geometry.getCoordinates();
  
  // 只获取需要的两个字段
  const county = feature.get('county') || '未知县区';
  const allYears = feature.get('all_years') || {};
  
  // 构建与洪水事件弹窗风格一致的弹窗内容
  let content = '<div class="disaster-popup">';
  content += '<div class="popup-header">';
  content += '<h3>经济数据详情</h3>';
  content += '<button class="close-popup" title="关闭">&times;</button>';
  content += '</div>';
  
  // 只显示县区名称和所有年份的GDP数据
  content += `<p><strong>县区:</strong> ${county}</p>`;
  
  // 显示所有年份的GDP数据（只显示有数据的年份）
   if (Object.keys(allYears).length > 0) {
     content += '<p><strong>GDP数据:</strong></p>';
     const sortedYears = Object.keys(allYears).sort((a, b) => a - b);
     let hasData = false;
     
     sortedYears.forEach(year => {
       const gdpValue = allYears[year];
       // 只显示有实际数据的年份（排除null、undefined、0等无效值）
       if (gdpValue && gdpValue > 0) {
         content += `<p style="margin-left: 20px;"><strong>${year}年:</strong> ${gdpValue} 万元</p>`;
         hasData = true;
       }
     });
     
     // 如果没有有效数据，显示提示
     if (!hasData) {
       content += '<p style="margin-left: 20px;">暂无有效数据</p>';
     }
   } else {
     content += '<p><strong>GDP数据:</strong> 暂无数据</p>';
   }
  
  // 移除现有弹窗
  if (window.economyPopup) {
    window.map.removeOverlay(window.economyPopup);
  }
  
  // 创建弹窗元素
  const popupElement = document.createElement('div');
  popupElement.className = 'disaster-popup-container';
  popupElement.innerHTML = content;
  
  // 创建弹窗覆盖层
  window.economyPopup = new ol.Overlay({
    element: popupElement,
    positioning: 'bottom-center',
    stopEvent: false,
    offset: [0, -10]
  });
  
  window.map.addOverlay(window.economyPopup);
  window.economyPopup.setPosition(coordinates);
  
  // 添加关闭按钮事件
  const closeBtn = popupElement.querySelector('.close-popup');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      if (window.economyPopup) {
        window.map.removeOverlay(window.economyPopup);
        window.economyPopup = null;
      }
    });
  }
  
  // 点击地图其他地方关闭弹窗
  window.map.once('click', () => {
    if (window.economyPopup) {
      window.map.removeOverlay(window.economyPopup);
      window.economyPopup = null;
    }
  });
}

// 流域边界GeoJSON加载
function loadBasinData() {
  // 幂等守卫：已加载过则不再重复请求
  if (basinLayer) return;
  pageLoadState.register('basin');
  showLoading(true, '正在加载流域边界数据...');
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
              fill: null // 移除填充色，只显示边界线
            }),
            new ol.style.Style({
              text: new ol.style.Text({
                text: name,
                font: 'bold 18px Microsoft YaHei, Arial, sans-serif',
                fill: new ol.style.Fill({ color: '#000000' }),
                stroke: new ol.style.Stroke({ color: '#ffffff', width: 3 }),
                textAlign: 'center',
                textBaseline: 'middle',
                placement: 'polygon',
                overflow: true,
                maxAngle: Math.PI / 4,
                offsetY: -10,
                scale: 1.2
              })
            })
          ];
        },
        type: 'basin-layer',
        zIndex: 60,
        visible: false
      });
      map.addLayer(basinLayer);
      // 按面板勾选状态同步可见性（面板勾选状态为唯一事实来源）
      const basinCheckbox = document.getElementById('layer-basin');
      basinLayer.setVisible(!!(basinCheckbox && basinCheckbox.checked));
      // 移除自动调整到整个数据范围的代码，保持地图在青藏高原的正确位置
      // 如果需要，可以设置一个适合青藏高原显示的缩放级别
      map.getView().setZoom(5.5);
      // 添加流域数据加载完成提示
      console.log('流域边界数据加载完成！');
      pageLoadState.complete('basin');
      showLoading(false);
    })
    .catch(error => {
      console.error('流域边界接口加载失败:', error);
      pageLoadState.complete('basin');
    });
}
// 首页才加载流域边界、河网等完整要素；其他页面只保留默认青藏高原边界（loadTPChinaData）以提升性能
if (isHomePage) {
  loadBasinData();
}

// 加载五级流域边界数据
function loadBasin5Data() {
  // 幂等守卫：已加载过则不再重复请求
  if (basin5Layer) return;
  pageLoadState.register('basin5');
  fetch('data/raw/geo/hydrology/TP_China_lev05.geojson')
    .then(res => {
      if (!res.ok) throw new Error('五级流域数据加载失败');
      return res.json();
    })
    .then(data => {
      const vectorSource = new ol.source.Vector({
        features: new ol.format.GeoJSON().readFeatures(data, {
          featureProjection: 'EPSG:3857'
        })
      });
      basin5Layer = new ol.layer.Vector({
        source: vectorSource,
        style: function(feature) {
          const name = feature.get('BasinName') || feature.get('name') || '';
          return [
            new ol.style.Style({
              stroke: new ol.style.Stroke({ color: '#5D4037', width: 1.5 }),
              fill: null // 不要填充，只显示边界线
            }),
            new ol.style.Style({
              text: new ol.style.Text({
                text: name,
                font: '12px Microsoft YaHei, Arial, sans-serif',
                fill: new ol.style.Fill({ color: '#5D4037' }),
                stroke: new ol.style.Stroke({ color: '#ffffff', width: 1 }),
                textAlign: 'center',
                textBaseline: 'middle',
                placement: 'polygon',
                overflow: true,
                maxAngle: Math.PI / 4
              })
            })
          ];
        },
        type: 'basin5-layer',
        zIndex: 59,
        visible: false
      });
      map.addLayer(basin5Layer);
      // 按面板勾选状态同步可见性（面板勾选状态为唯一事实来源）
      const basin5Checkbox = document.getElementById('layer-basin-5');
      basin5Layer.setVisible(!!(basin5Checkbox && basin5Checkbox.checked));
      console.log('五级流域划分数据加载完成！');
      pageLoadState.complete('basin5');
    })
    .catch(error => {
      console.error('加载五级流域数据错误:', error);
      console.log('五级流域数据加载失败，部分功能可能受限');
      pageLoadState.complete('basin5');
    });
}
if (isHomePage) {
  loadBasin5Data();
}

// ---------- TP_China边界加载 ----------
function loadTPChinaData() {
  // 防重入/防并发守卫：已加载或正在加载时直接返回，避免异步期间二次触发产生重复图层
  if (tpChinaLayer || tpChinaLoading) return;
  tpChinaLoading = true;
  pageLoadState.register('tp-china');
  fetch('/data/raw/geo/boundary/TP_China.geojson')
    .then(res => {
      if (!res.ok) throw new Error('TP_China数据加载失败');
      return res.json();
    })
    .then(data => {
      const vectorSource = new ol.source.Vector({
        features: new ol.format.GeoJSON().readFeatures(data, {
          featureProjection: 'EPSG:3857'
        })
      });
      tpChinaLayer = new ol.layer.Vector({
        source: vectorSource,
        style: function(feature) {
          return [
            new ol.style.Style({
              stroke: new ol.style.Stroke({ color: '#5D4037', width: 3 }),
              fill: null // 只显示边界线
            })
          ];
        },
        type: 'tp-china-layer',
      zIndex: 55
      });
      map.addLayer(tpChinaLayer);
      // 移除自动调整到整个数据范围的代码，保持地图在青藏高原的正确位置
      // 如果需要，可以设置一个适合青藏高原显示的缩放级别
      map.getView().setZoom(5.5);
      // 添加TP_China数据加载完成提示
      console.log('TP_China边界数据加载完成！');
      console.log('加载的要素数量:', vectorSource.getFeatures().length);
      pageLoadState.complete('tp-china');
    })
    .catch(error => {
      console.error('加载TP_China数据错误:', error);
      tpChinaLoading = false; // 失败时释放守卫，允许后续重试
      pageLoadState.complete('tp-china');
    });
}
loadTPChinaData();

// ---------- 河网矢量加载 ----------
function loadRiverData() {
  // 幂等守卫：已加载过则不再重复请求（防止双重触发产生两个同名图层）
  if (riverLayer) return;
  pageLoadState.register('river');
  showLoading(true, '正在加载河网数据...');
  fetch('/api/basin/river')
    .then(res => {
      if (!res.ok) throw new Error('接口河网数据加载失败');
      return res.json();
    })
    .then(data => {
      const riverSource = new ol.source.Vector({
        features: new ol.format.GeoJSON().readFeatures(data, {
          featureProjection: 'EPSG:3857'
        })
      });
      // 保存原始数据源
      originalRiverSource = riverSource;
      riverLayer = new ol.layer.Vector({
        source: riverSource,
        style: new ol.style.Style({
          stroke: new ol.style.Stroke({
            color: '#1E90FF',
            width: 1.5
          })
        }),
        type: 'river-layer',
        zIndex: 50
      });
      map.addLayer(riverLayer);
      // 按面板勾选状态同步可见性（面板勾选状态为唯一事实来源）
      const riverCheckbox = document.getElementById('layer-river');
      riverLayer.setVisible(!!(riverCheckbox && riverCheckbox.checked));
      // 添加河网数据加载完成提示
      console.log('河网数据加载完成！');
      pageLoadState.complete('river');
      showLoading(false);
    })
    .catch(error => {
      console.error('河网接口加载失败:', error);
      pageLoadState.complete('river');
    });
}

// ---------- 水文站矢量加载（适配实际数据结构） ----------
function loadCmaData() {
  showLoading(true, '正在加载水文站数据...');
  // 定义带文字标签的样式函数，使用"台站名称"属性
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
      console.log('加载到的水文站数据:', data);
      const cmaSource = new ol.source.Vector({
        features: new ol.format.GeoJSON().readFeatures(data, {
          featureProjection: 'EPSG:3857'
        })
      });
      // 保存原始数据源
      originalCmaSource = cmaSource;

      cmaLayer = new ol.layer.Vector({
        source: cmaSource,
        style: cmaStyleFunction,
        type: 'cma-layer',
        zIndex: 70
      });

      map.addLayer(cmaLayer);
      // 添加水文站数据加载完成提示
      console.log('水文站数据加载完成！');
      showLoading(false);
    })
    .catch(error => {
      console.error('水文站接口加载失败:', error);
      showLoading(false);
    });
}

// ---------- 气象站矢量加载（适配实际数据结构） ----------
function loadWeatherStationData() {
  showLoading(true, '正在加载气象站数据...');
  // 定义带文字标签的样式函数，使用"台站名称"属性
  const weatherStationStyleFunction = function(feature) {
    // 从属性中获取站点名称，使用"台站名"字段
    const stationName = feature.get('台站名') || feature.get('台站名称') || feature.get('站点名称') || '未知站点';

    return new ol.style.Style({
      // 点样式
      image: new ol.style.Circle({
        radius: 6,
        fill: new ol.style.Fill({
          color: '#ff6b35' // 橙色，区别于水文站的绿色
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
        offsetY: 18,
        offsetX: 0,
        padding: [2, 5, 2, 5]
      })
    });
  };

  fetch('/api/basin/weather_station')
    .then(res => {
      if (!res.ok) throw new Error('接口气象站数据加载失败');
      return res.json();
    })
    .then(data => {
      console.log('加载到的气象站数据:', data);
      const weatherStationSource = new ol.source.Vector({
        features: new ol.format.GeoJSON().readFeatures(data, {
          featureProjection: 'EPSG:3857'
        })
      });
      // 保存原始数据源
      originalWeatherStationSource = weatherStationSource;

      weatherStationLayer = new ol.layer.Vector({
        source: weatherStationSource,
        style: weatherStationStyleFunction,
        type: 'weather-station-layer',
        zIndex: 71 // 略高于水文站图层
      });

      map.addLayer(weatherStationLayer);
      // 添加气象站数据加载完成提示
      console.log('气象站数据加载完成！');
      showLoading(false);
    })
    .catch(error => {
      console.error('加载气象站数据错误:', error);
      console.log('气象站数据加载失败，部分功能可能受限');
      showLoading(false);
    });
}

// ---------- 铁路数据加载 ----------
function loadRailwayData() {
  showLoading(true, '正在加载铁路数据...');
  
  fetch('/api/basin/railway')
    .then(res => {
      if (!res.ok) throw new Error('接口铁路数据加载失败');
      return res.json();
    })
    .then(data => {
      const railwaySource = new ol.source.Vector({
        features: new ol.format.GeoJSON().readFeatures(data, {
          featureProjection: 'EPSG:3857'
        })
      });
      
      railwayLayer = new ol.layer.Vector({
        source: railwaySource,
        style: new ol.style.Style({
          stroke: new ol.style.Stroke({
            color: '#808080', // 标准铁路灰色
            width: 2,
            lineDash: [5, 5] // 虚线样式表示铁路
          })
        }),
        type: 'railway-layer',
        zIndex: 60
      });
      
      map.addLayer(railwayLayer);
      console.log('铁路数据加载完成！');
      showLoading(false);
    })
    .catch(error => {
      console.error('加载铁路数据错误:', error);
      console.log('铁路数据加载失败，部分功能可能受限');
      showLoading(false);
    });
}

// ---------- 公路数据加载 ----------
function loadRoadData() {
  showLoading(true, '正在加载公路数据...');
  
  fetch('/api/basin/road')
    .then(res => {
      if (!res.ok) throw new Error('接口公路数据加载失败');
      return res.json();
    })
    .then(data => {
      const roadSource = new ol.source.Vector({
        features: new ol.format.GeoJSON().readFeatures(data, {
          featureProjection: 'EPSG:3857'
        })
      });
      
      roadLayer = new ol.layer.Vector({
        source: roadSource,
        style: new ol.style.Style({
          stroke: new ol.style.Stroke({
            color: '#FF8C00', // 标准公路橙色
            width: 1.5
          })
        }),
        type: 'road-layer',
        zIndex: 55
      });
      
      map.addLayer(roadLayer);
      console.log('公路数据加载完成！');
      showLoading(false);
    })
    .catch(error => {
      console.error('加载公路数据错误:', error);
      console.log('公路数据加载失败，部分功能可能受限');
      showLoading(false);
    });
}

// ---------- 居民地数据加载 ----------
function loadSettlementData() {
  showLoading(true, '正在加载县级居民地数据...');
  
  fetch('/api/basin/settlement')
    .then(res => {
      if (!res.ok) throw new Error('接口居民地数据加载失败');
      return res.json();
    })
    .then(data => {
      const settlementSource = new ol.source.Vector({
        features: new ol.format.GeoJSON().readFeatures(data, {
          featureProjection: 'EPSG:3857'
        })
      });
      
      settlementLayer = new ol.layer.Vector({
        source: settlementSource,
        style: function(feature) {
          const name = feature.get('CHINESE_NAME') || feature.get('PINYIN') || feature.get('PYNAME') || feature.get('name') || feature.get('NAME') || '';
          return [
            new ol.style.Style({
              image: new ol.style.Circle({
                radius: 4,
                fill: new ol.style.Fill({
                  color: '#000000'
                }),
                stroke: new ol.style.Stroke({
                  color: '#FFFFFF',
                  width: 1
                })
              })
            }),
            new ol.style.Style({
              text: new ol.style.Text({
                text: name,
                font: '8px Microsoft YaHei',
                fill: new ol.style.Fill({
                  color: '#000000'
                }),
                stroke: new ol.style.Stroke({
                  color: '#FFFFFF',
                  width: 1
                }),
                offsetY: 10 // 将文字显示在圆点下方
              })
            })
          ];
        },
        type: 'settlement-layer',
        zIndex: 70
      });
      
      map.addLayer(settlementLayer);
      console.log('县级居民地数据加载完成！');
      showLoading(false);
    })
    .catch(error => {
      console.error('加载居民地数据错误:', error);
      console.log('居民地数据加载失败，部分功能可能受限');
      showLoading(false);
    });
}

// ---------- 地市级居民地数据加载 ----------
function loadCitySettlementData() {
  showLoading(true, '正在加载地市级居民地数据...');
  
  fetch('/api/basin/city_settlement')
    .then(res => {
      if (!res.ok) throw new Error('接口地市级居民地数据加载失败');
      return res.json();
    })
    .then(data => {
      const citySettlementSource = new ol.source.Vector({
        features: new ol.format.GeoJSON().readFeatures(data, {
          featureProjection: 'EPSG:3857'
        })
      });
      
      citySettlementLayer = new ol.layer.Vector({
        source: citySettlementSource,
        style: function(feature) {
          const name = feature.get('CHINESE_NAME') || feature.get('PINYIN') || feature.get('PYNAME') || feature.get('name') || feature.get('NAME') || '';
          return [
            new ol.style.Style({
              image: new ol.style.Circle({
                radius: 6,
                fill: new ol.style.Fill({
                  color: '#000000'
                }),
                stroke: new ol.style.Stroke({
                  color: '#FFFFFF',
                  width: 2
                })
              })
            }),
            new ol.style.Style({
              text: new ol.style.Text({
                text: name,
                font: '10px Microsoft YaHei',
                fill: new ol.style.Fill({
                  color: '#000000'
                }),
                stroke: new ol.style.Stroke({
                  color: '#FFFFFF',
                  width: 2
                }),
                offsetY: 12 // 将文字显示在圆点下方
              })
            })
          ];
        },
        type: 'city-settlement-layer',
        zIndex: 75
      });
      
      map.addLayer(citySettlementLayer);
      console.log('地市级居民地数据加载完成！');
      showLoading(false);
    })
    .catch(error => {
      console.error('加载地市级居民地数据错误:', error);
      console.log('地市级居民地数据加载失败，部分功能可能受限');
      showLoading(false);
    });
}

// ---------- 首都和省级行政中心数据加载 ----------
function loadCapitalSettlementData() {
  showLoading(true, '正在加载省级行政中心数据...');
  
  fetch('/api/basin/capital_settlement')
    .then(res => {
      if (!res.ok) throw new Error('接口省级行政中心数据加载失败');
      return res.json();
    })
    .then(data => {
      const capitalSettlementSource = new ol.source.Vector({
        features: new ol.format.GeoJSON().readFeatures(data, {
          featureProjection: 'EPSG:3857'
        })
      });
      
      capitalSettlementLayer = new ol.layer.Vector({
        source: capitalSettlementSource,
        style: function(feature) {
          const name = feature.get('CHINESE_NAME') || feature.get('PINYIN') || feature.get('PYNAME') || feature.get('name') || feature.get('NAME') || '';
          return [
            new ol.style.Style({
              image: new ol.style.Circle({
                radius: 8,
                fill: new ol.style.Fill({
                  color: '#000000'
                }),
                stroke: new ol.style.Stroke({
                  color: '#FFFFFF',
                  width: 3
                })
              })
            }),
            new ol.style.Style({
              text: new ol.style.Text({
                text: name,
                font: '12px Microsoft YaHei',
                fill: new ol.style.Fill({
                  color: '#000000'
                }),
                stroke: new ol.style.Stroke({
                  color: '#FFFFFF',
                  width: 2
                }),
                offsetY: 15 // 将文字显示在圆点下方
              })
            })
          ];
        },
        type: 'capital-settlement-layer',
        zIndex: 80
      });
      
      map.addLayer(capitalSettlementLayer);
      console.log('首都和省级行政中心数据加载完成！');
      showLoading(false);
    })
    .catch(error => {
      console.error('加载首都和省级行政中心数据错误:', error);
      console.log('首都和省级行政中心数据加载失败，部分功能可能受限');
      showLoading(false);
    });
}

// ---------- 国界数据加载 ----------
function loadBoundaryCountryData() {
  showLoading(true, '正在加载国界数据...');
  
  fetch('/api/basin/boundary_country')
    .then(res => {
      if (!res.ok) throw new Error('接口国界数据加载失败');
      return res.json();
    })
    .then(data => {
      const boundaryCountrySource = new ol.source.Vector({
        features: new ol.format.GeoJSON().readFeatures(data, {
          featureProjection: 'EPSG:3857'
        })
      });
      
      boundaryCountryLayer = new ol.layer.Vector({
        source: boundaryCountrySource,
        style: new ol.style.Style({
          stroke: new ol.style.Stroke({
            color: '#FF0000', // 红色国界，符合地图规范
            width: 3
          })
        }),
        type: 'boundary-country-layer',
        zIndex: 85
      });
      
      map.addLayer(boundaryCountryLayer);
      console.log('国界数据加载完成！');
      showLoading(false);
    })
    .catch(error => {
      console.error('加载国界数据错误:', error);
      console.log('国界数据加载失败，部分功能可能受限');
      showLoading(false);
    });
}

// ---------- 国界与省界数据加载 ----------
function loadBoundaryProvinceData() {
  showLoading(true, '正在加载国界与省界数据...');
  
  fetch('/api/basin/boundary_province')
    .then(res => {
      if (!res.ok) throw new Error('接口国界与省界数据加载失败');
      return res.json();
    })
    .then(data => {
      const boundaryProvinceSource = new ol.source.Vector({
        features: new ol.format.GeoJSON().readFeatures(data, {
          featureProjection: 'EPSG:3857'
        })
      });
      
      boundaryProvinceLayer = new ol.layer.Vector({
        source: boundaryProvinceSource,
        style: new ol.style.Style({
          stroke: new ol.style.Stroke({
            color: '#000080', // 深蓝色省界，符合地图规范
            width: 2
          })
        }),
        type: 'boundary-province-layer',
        zIndex: 84
      });
      
      map.addLayer(boundaryProvinceLayer);
      console.log('国界与省界数据加载完成！');
      showLoading(false);
    })
    .catch(error => {
      console.error('加载国界与省界数据错误:', error);
      console.log('国界与省界数据加载失败，部分功能可能受限');
      showLoading(false);
    });
}

// ---------- 地级行政界线数据加载 ----------
function loadBoundaryCityData() {
  showLoading(true, '正在加载地级行政界线数据...');
  
  fetch('/api/basin/boundary_city')
    .then(res => {
      if (!res.ok) throw new Error('接口地级行政界线数据加载失败');
      return res.json();
    })
    .then(data => {
      const boundaryCitySource = new ol.source.Vector({
        features: new ol.format.GeoJSON().readFeatures(data, {
          featureProjection: 'EPSG:3857'
        })
      });
      
      boundaryCityLayer = new ol.layer.Vector({
        source: boundaryCitySource,
        style: new ol.style.Style({
          stroke: new ol.style.Stroke({
            color: '#006400', // 深绿色地市界，符合地图规范
            width: 1.5
          })
        }),
        type: 'boundary-city-layer',
        zIndex: 83
      });
      
      map.addLayer(boundaryCityLayer);
      console.log('地级行政界线数据加载完成！');
      showLoading(false);
    })
    .catch(error => {
      console.error('加载地级行政界线数据错误:', error);
      console.log('地级行政界线数据加载失败，部分功能可能受限');
      showLoading(false);
    });
}

// ---------- 县级行政界线数据加载 ----------
function loadBoundaryCountyData() {
  showLoading(true, '正在加载县级行政界线数据...');
  
  fetch('/api/basin/boundary_county')
    .then(res => {
      if (!res.ok) throw new Error('接口县级行政界线数据加载失败');
      return res.json();
    })
    .then(data => {
      const boundaryCountySource = new ol.source.Vector({
        features: new ol.format.GeoJSON().readFeatures(data, {
          featureProjection: 'EPSG:3857'
        })
      });
      
      boundaryCountyLayer = new ol.layer.Vector({
        source: boundaryCountySource,
        style: new ol.style.Style({
          stroke: new ol.style.Stroke({
            color: '#808080', // 灰色县界，符合地图规范
            width: 1
          })
        }),
        type: 'boundary-county-layer',
        zIndex: 82
      });
      
      map.addLayer(boundaryCountyLayer);
      console.log('县级行政界线数据加载完成！');
      showLoading(false);
    })
    .catch(error => {
      console.error('加载县级行政界线数据错误:', error);
      console.log('县级行政界线数据加载失败，部分功能可能受限');
      showLoading(false);
    });
}

  // 加载冻土图层 - 重写版本，增强稳定性和调试能力
  function loadPermafrostLayer() {
    // 幂等守卫：已加载过则不再重复请求（防止双重触发产生两个同名图层）
    if (permafrostLayer) return;
    pageLoadState.register('permafrost');
    console.log('开始加载冻土图层...');
    showLoading(true, '正在加载冻土数据...');
    
    // 使用API加载，优化错误处理和数据解析
    fetch('/api/basin/permafrost')
      .then(response => {
        if (!response.ok) throw new Error(`API响应错误: ${response.status}`);
        return response.json();
      })
      .then(data => {
        console.log('冻土数据加载成功');
        
        // 验证数据结构
        if (!data) {
          throw new Error('获取到的数据为空');
        }
        
        try {
          
          // 关键问题：从日志看坐标范围异常大，可能是投影问题
          // 定义不同gridcode值对应的样式
          const permafrostStyles = {
            0: new ol.style.Style({
              fill: new ol.style.Fill({ color: 'rgba(255, 255, 190, 0.7)' }),  // 橙色表示季节性冻土 (Seasonally frozen ground)
              stroke: new ol.style.Stroke({ color: 'rgba(0, 0, 0, 0)', width: 3 })  // 透明外边框
            }),
            1: new ol.style.Style({
              fill: new ol.style.Fill({ color: 'rgba(205, 205, 102, 0.7)' }),  // 蓝色表示永久冻土 (Permafrost)
              stroke: new ol.style.Stroke({ color: 'rgba(0, 0, 0, 0)', width: 3 })  // 透明外边框
            }),
            2: new ol.style.Style({
              fill: new ol.style.Fill({ color: 'rgba(255, 255, 255, 0.7)' }),  // 绿色表示未冻结 (Unfrozen ground)
              stroke: new ol.style.Stroke({ color: 'rgba(0, 0, 0, 0)', width: 3 })  // 透明外边框
            })
          };
          
          // 创建基于gridcode的样式函数
          const styleFunction = function(feature) {
            const gridcode = feature.get('gridcode');
            // 移除console.log以减少控制台输出
            // 返回对应样式或默认样式
            return permafrostStyles[gridcode] || new ol.style.Style({
              fill: new ol.style.Fill({ color: 'rgba(255, 0, 255, 0.7)' }),  // 紫色作为默认
              stroke: new ol.style.Stroke({ color: 'rgba(200, 0, 200, 1)', width: 3 })
            });
          };
          
          // 使用单独的GeoJSON格式化器实例
          const geoJsonFormat = new ol.format.GeoJSON();
          
          // 坐标问题解决方案：尝试多种数据投影，实现智能检测
          let features;
          
          // 定义要尝试的投影选项
          const projectionAttempts = [
            { dataProjection: null, name: '自动检测' },
            { dataProjection: 'EPSG:4326', name: 'EPSG:4326 (经纬度)' },
            { dataProjection: 'EPSG:3857', name: 'EPSG:3857 (Web墨卡托)' },
            { dataProjection: 'EPSG:3395', name: 'EPSG:3395 (墨卡托)' },
            { dataProjection: 'EPSG:4544', name: 'EPSG:4544 (CGCS2000)' },
            { dataProjection: 'EPSG:4490', name: 'EPSG:4490 (CGCS2000经纬度)' }
          ];
          
          let successfulProjection = null;
          
          // 尝试每种投影选项
          for (const attempt of projectionAttempts) {
            try {
              
              const options = { featureProjection: 'EPSG:3857' };
              if (attempt.dataProjection) {
                options.dataProjection = attempt.dataProjection;
              }
              
              features = geoJsonFormat.readFeatures(data, options);
              
              if (features.length > 0) {
                // 验证坐标是否合理
                const firstFeature = features[0];
                const geometry = firstFeature.getGeometry();
                const extent = geometry.getExtent();
                
                // 检查坐标范围是否合理（在地球范围内）
                const isValidRange = 
                  !isNaN(extent[0]) && 
                  !isNaN(extent[1]) && 
                  !isNaN(extent[2]) && 
                  !isNaN(extent[3]) &&
                  extent[0] !== Infinity && 
                  extent[1] !== Infinity && 
                  extent[2] !== -Infinity && 
                  extent[3] !== -Infinity &&
                  Math.abs(extent[0]) < 100000000 && // 合理的坐标范围限制
                  Math.abs(extent[2]) < 100000000;
                
                if (isValidRange) {
                  successfulProjection = attempt.name;
                  break; // 找到有效的投影，退出循环
                } else {
                }
              }
            } catch (e) {
              console.warn(`投影${attempt.name}解析失败: ${e.message}`);
            }
          }
          
          // 如果所有投影尝试都失败，尝试手动处理坐标
          if (!successfulProjection && data.features && data.features.length > 0) {
            console.warn('所有投影尝试都失败，尝试手动处理坐标');
            
            // 手动创建特征，不进行自动投影
            features = [];
            data.features.forEach(featureData => {
              try {
                // 直接读取几何对象，不进行投影转换
                const geometry = new ol.geom.Polygon(featureData.geometry.coordinates);
                const feature = new ol.Feature(geometry);
                
                // 复制属性
                if (featureData.properties) {
                  for (const key in featureData.properties) {
                    feature.set(key, featureData.properties[key]);
                  }
                }
                
                features.push(feature);
              } catch (e) {
                console.error('创建单个特征失败:', e.message);
              }
            });
            
            console.log(`手动创建特征数量: ${features.length}`);
            
            // 终极备用方案：如果手动创建仍然失败或没有有效特征，创建测试多边形
            if (features.length === 0 || features.every(f => f.getGeometry().getExtent()[0] === Infinity)) {
              console.error('手动创建也失败，使用备用测试多边形');
              
              // 创建一个简单的测试多边形（青藏高原区域）
              const testPolygon = new ol.geom.Polygon([[
                [85, 35],  // 左上
                [95, 35],  // 右上
                [95, 30],  // 右下
                [85, 30],  // 左下
                [85, 35]   // 闭合
              ]]);
              
              const testFeature = new ol.Feature({
                geometry: testPolygon,
                gridcode: 2, // 永久冻土
                Id: 9999,
                name: '测试冻土区域'
              });
              
              features = [testFeature];
            }
          }
          
          // 修复异常坐标范围的特殊处理
          if (features.length > 0) {
            const firstFeature = features[0];
            const geometry = firstFeature.getGeometry();
            const extent = geometry.getExtent();
            
            if (extent[0] === Infinity || extent[1] === Infinity || 
                extent[2] === -Infinity || extent[3] === -Infinity) {
              console.error('坐标范围无效，将使用默认范围');
              // 使用中国区域的默认范围（Web墨卡托坐标）
              firstFeature.getGeometry().setExtent([73.5, 18, 135, 53]);
            }
          }
          
          // 创建矢量源
          const vectorSource = new ol.source.Vector({
            features: features
          });
          
          // 创建图层，确保正确配置
          permafrostLayer = new ol.layer.Vector({
            source: vectorSource,
            style: styleFunction, // 使用基于gridcode的样式函数
            visible: true, // 默认可见，加载完成后按面板勾选状态同步
            type: 'permafrost-layer',
            zIndex: 5 // 确保冻土图层在底图之上，线图层之下
          });

          // 添加图层到地图
          map.addLayer(permafrostLayer);

          // 按面板勾选状态同步可见性（面板勾选状态为唯一事实来源）
          const permafrostCheckbox = document.getElementById('layer-cryo-permafrost');
          permafrostLayer.setVisible(!!(permafrostCheckbox && permafrostCheckbox.checked));

          // 再次确认zIndex设置
          permafrostLayer.setZIndex(5);
          // 添加冻土数据加载完成提示
            console.log('冻土数据加载完成！');
            showLoading(false);
          
          // 强制刷新地图
          map.render();
          pageLoadState.complete('permafrost');

          
        } catch (parseError) {
          console.error('GeoJSON解析或图层创建错误:', parseError);
          showAlert(`冻土图层创建失败: ${parseError.message}`, 'error');
          pageLoadState.complete('permafrost');
        }
      })
      .catch(error => {
        console.error('冻土图层加载失败:', error);
        showAlert(`冻土图层加载失败: ${error.message}`, 'warning');
        showLoading(false);
        
        // 尝试使用备用数据格式测试
        console.log('尝试使用简单测试数据...');
        try {
          // 创建一个简单的测试多边形
          const testFeature = new ol.Feature({
            geometry: new ol.geom.Polygon([[
              [0, 0], [1000000, 0], [1000000, 1000000], [0, 1000000], [0, 0]
            ]])
          });
          
          const testSource = new ol.source.Vector({
            features: [testFeature]
          });
          
          permafrostLayer = new ol.layer.Vector({
            source: testSource,
            style: new ol.style.Style({
              fill: new ol.style.Fill({ color: 'rgba(0, 255, 0, 0.5)' }),
              stroke: new ol.style.Stroke({ color: 'red', width: 2 })
            }),
            visible: false,
            zIndex: 5 // 确保测试用的冻土图层也在底图之上，线图层之下
          });
          
          map.addLayer(permafrostLayer);
          console.log('已添加测试图层');
          
        } catch (testError) {
          console.error('测试图层创建失败:', testError);
        }
        pageLoadState.complete('permafrost');
      });
  }

  // 加载冰川图层
  function loadGlacierLayer() {
    // 幂等守卫：已加载过则不再重复请求（防止双重触发产生两个同名图层）
    if (glacierLayer) return;
    pageLoadState.register('glacier');
    
    // 尝试从API加载冰川数据
    fetch('/api/basin/glaciers')
      .then(response => {
        if (!response.ok) throw new Error('接口冰川数据加载失败');
        return response.json();
      })
      .then(data => {
        console.log('API冰川数据加载成功');
        createGlacierLayer(data);
      })
      .catch(error => {
        console.error('接口冰川数据加载失败:', error);
        
        // API失败时尝试加载本地数据
        console.log('尝试加载本地冰川数据...');
        
        // 创建备用冰川数据（青藏高原区域）
        const backupGlacierData = {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: { name: '青藏高原冰川区域' },
              geometry: {
                type: 'Polygon',
                coordinates: [[
                  [85, 35], [95, 35], [95, 30], [85, 30], [85, 35]
                ]]
              }
            }
          ]
        };
        
        createGlacierLayer(backupGlacierData);
        console.log('本地冰川数据加载完成！');
      });
      
    function createGlacierLayer(data) {
      glacierLayer = new ol.layer.Vector({
        source: new ol.source.Vector({
          features: new ol.format.GeoJSON().readFeatures(data, {
            dataProjection: 'EPSG:4326',
            featureProjection: 'EPSG:3857'
          })
        }),
        style: new ol.style.Style({
          fill: new ol.style.Fill({ color: 'rgba(21, 87, 230, 0.7)' }), // 冰川-淡蓝色半透明
          stroke: new ol.style.Stroke({
            color: 'rgba(0, 68, 255, 1)',
            width: 1
          })
        }),
        visible: true, // 默认可见，与其他图层一致
        type: 'glacier-layer',
        zIndex: 5
      });
      map.addLayer(glacierLayer);
      showLoading(false);
      pageLoadState.complete('glacier');

      // 按面板勾选状态同步可见性（面板勾选状态为唯一事实来源，勾选与否都要显式设置）
      const glacierCheckbox = document.getElementById('layer-cryo-glacier');
      glacierLayer.setVisible(!!(glacierCheckbox && glacierCheckbox.checked));
      console.log(`冰川图层 ${glacierLayer.getVisible() ? '已显示' : '已隐藏'}`);
    }
  }

// 地图标记图层
const searchMarkerLayer = new ol.layer.Vector({
  source: new ol.source.Vector(),
  style: new ol.style.Style({
    image: new ol.style.Circle({
      radius: 10,
      fill: new ol.style.Fill({color: '#ff9800'}),
      stroke: new ol.style.Stroke({color: '#fff', width: 3})
    })
  }),
  type: 'search-marker-layer',
  zIndex: 80 // 确保标记显示在最顶层
});
map.addLayer(searchMarkerLayer);

// 提示框功能（使用 UI 组件库 Toast 实现）
function showAlert(message, type = 'error') {
  // 优先使用 UI 组件库（Toast 通知），保证组件库加载失败时仍可降级为旧实现
  if (window.UI && UI.showAlert) {
    UI.showAlert(message, type);
    return;
  }
  const alertDiv = document.createElement('div');
  alertDiv.style.position = 'fixed';
  alertDiv.style.top = '70px';
  alertDiv.style.right = '20px';
  alertDiv.style.padding = '10px 20px';
  alertDiv.style.borderRadius = '4px';
  alertDiv.style.color = 'white';
  alertDiv.style.zIndex = '1000';
  alertDiv.style.boxShadow = '0 2px 10px rgba(0,0,0,0.2)';
  alertDiv.style.transition = 'opacity 0.3s'; // 平滑消失动画
  if (type === 'error') alertDiv.style.backgroundColor = '#f44336';
  else if (type === 'success') alertDiv.style.backgroundColor = '#4caf50';
  else alertDiv.style.backgroundColor = '#ff9800';
  alertDiv.textContent = message;
  document.body.appendChild(alertDiv);
  setTimeout(() => {
    alertDiv.style.opacity = '0';
    setTimeout(() => document.body.removeChild(alertDiv), 300);
  }, 3000);
}

// 加载遮罩层控制
function showLoading(show, text = '') {
  // 系统加载动效期间（init=true 且尚未完成）：保持固定文案"系统正在加载"，
  // 忽略单个要素的加载提示（如"正在加载X数据"）和提前隐藏；
  // 仅由加载跟踪器 pageLoadState.finish 在全部要素加载完成后移除遮罩
  if (pageLoadState.init && !pageLoadState.finished) {
    return;
  }
  const overlay = document.getElementById('loading-overlay');
  const loadingText = document.getElementById('loading-text');
  
  if (overlay) { // 防御性判断：避免元素不存在时报错
    if (show) {
      overlay.classList.add('active');
      // 更新加载文字
      if (loadingText) {
        loadingText.textContent = text || '系统正在加载中，请稍候...';
      }
    } else {
      overlay.classList.remove('active');
    }
  }
}

// 地理编码获取城市编码
async function geocodePlace(place) {
  try {
    showLoading(true);
    const url = `/modules/geocode?address=${encodeURIComponent(place)}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`地理编码失败: ${resp.status} ${resp.statusText}`);
    const data = await resp.json();
    if (!data.success) throw new Error(data.message || "未找到该地点");
    return data.result;
  } catch (error) {
    console.error('地理编码错误:', error);
    showAlert(error.message, 'error');
    throw error;
  } finally {
    showLoading(false);
  }
}

// 保存当前搜索到的流域图层，方便清除
let currentBasinLayer = null;

// 搜索地点并更新地图标记
async function handleSearch(place) {
  if (!place) {
    console.log('请输入搜索内容');
    return;
  }

  try {
    // 在每次搜索前恢复显示所有河网和水文站数据
    restoreOriginalLayers();
    // 先尝试搜索流域
    const basinResult = await searchBasin(place);
    // 如果搜索到流域，显示流域边界
    showBasinBoundary(basinResult);
    console.log(`已定位到 ${place} 流域`);
  } catch (basinError) {
    // 流域搜索失败，尝试搜索城市
    try {
      const { lng, lat, citycode } = await geocodePlace(place);
      // 更新地图标记
      searchMarkerLayer.getSource().clear();
      const feature = new ol.Feature({
        geometry: new ol.geom.Point(ol.proj.fromLonLat([lng, lat])),
        name: place
      });
      searchMarkerLayer.getSource().addFeature(feature);

      // 尝试检查该地点是否在某个流域内
      const basinContainingPoint = await checkPointInBasin(lng, lat);
      if (basinContainingPoint) {
        // 如果点在流域内，显示该流域边界
        showBasinBoundary({
          type: 'FeatureCollection',
          features: [basinContainingPoint]
        });
        const basinName = basinContainingPoint.properties?.BasinName || '该流域';
        showAlert(`已定位到 ${place}，位于${basinName}内`, 'success');
      } else {
        // 点不在任何流域内，只显示地点标记
        showAlert(`已定位到 ${place}，不在任何已知流域内`, 'info');
      }

      // 地图定位动画
      map.getView().animate({
        center: ol.proj.fromLonLat([lng, lat]),
        zoom: 11,
        duration: 900
      });
    } catch (cityError) {
      // 两个搜索都失败，显示错误信息
      console.error('搜索错误:', cityError);
      showAlert(`搜索失败: 未找到该地点或流域`, 'error');
    }
  }
}

// 检查点是否在某个流域内
async function checkPointInBasin(lng, lat) {
  try {
    console.log(`检查点 [${lng}, ${lat}] 是否在流域内`);
    
    // 获取所有流域数据
    const response = await fetch(`/api/basin/data`);
    if (!response.ok) {
      console.error('获取流域数据失败');
      return null;
    }
    
    const basinData = await response.json();
    if (!basinData.features || basinData.features.length === 0) {
      console.log('没有流域数据可供检查');
      return null;
    }
    
    // 检查点是否在某个流域多边形内
    for (const feature of basinData.features) {
      if (feature.geometry && feature.geometry.type && feature.geometry.coordinates) {
        if (pointInPolygon([lng, lat], feature.geometry)) {
          console.log(`点位于流域内: ${feature.properties?.BasinName}`);
          return feature;
        }
      }
    }
    
    console.log('点不在任何流域内');
    return null;
  } catch (error) {
    console.error('检查点在流域内出错:', error);
    return null;
  }
}

// 点在多边形内检测算法
function pointInPolygon(point, geometry) {
  try {
    // 转换为OpenLayers坐标
    const olPoint = ol.proj.fromLonLat(point);
    
    // 创建OpenLayers点几何对象
    const olGeometryPoint = new ol.geom.Point(olPoint);
    
    // 解析几何数据创建OpenLayers几何对象
    let olGeometry;
    
    // 根据几何类型创建对应的OpenLayers几何对象
    switch (geometry.type) {
      case 'Polygon':
        // 处理单个多边形
        const polygonCoords = geometry.coordinates[0].map(coord => ol.proj.fromLonLat(coord));
        olGeometry = new ol.geom.Polygon([polygonCoords]);
        break;
        
      case 'MultiPolygon':
        // 处理多个多边形
        const multiPolygonCoords = geometry.coordinates.map(polyCoords => 
          polyCoords[0].map(coord => ol.proj.fromLonLat(coord))
        );
        olGeometry = new ol.geom.MultiPolygon(multiPolygonCoords);
        break;
        
      default:
        console.warn(`不支持的几何类型: ${geometry.type}`);
        return false;
    }
    
    // 使用OpenLayers的intersectsCoordinate方法检测点是否在多边形内
    return olGeometry.intersectsCoordinate(olPoint);
  } catch (error) {
    console.error('点在多边形内检测出错:', error);
    return false;
  }
}

// 搜索流域
async function searchBasin(basinName) {
  try {
    showLoading(true);
    console.log(`正在搜索流域: ${basinName}`);

    const response = await fetch(`/api/basin/search?name=${encodeURIComponent(basinName)}`);
    console.log(`搜索API响应状态: ${response.status}`);
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorMessage = errorData.error || '未找到该流域';
      console.error(`搜索失败，状态码: ${response.status}，错误信息: ${errorMessage}`);
      throw new Error(errorMessage);
    }

    const data = await response.json();
    console.log('搜索结果数据:', data);
    console.log('调试信息:', data.debug_info);
    
    // 检查是否有错误信息
    if (data.error) {
      console.error('搜索结果包含错误:', data.error);
      throw new Error(data.error);
    }
    
    // 检查是否有匹配的流域特征
    if (!data.features || data.features.length === 0) {
      console.log(`未找到匹配'${basinName}'的流域，将尝试搜索地点`);
      // 直接抛出错误以触发地点搜索
      throw new Error(`未找到匹配流域，将搜索地点: ${basinName}`);
    }

    console.log(`成功找到 ${data.features.length} 个匹配的流域`);
    return data;
  } catch (error) {
    console.error("搜索流域出错:", error);
    throw error;
  } finally {
    showLoading(false);
  }
}

// 检查几何要素是否在流域内
function isFeatureInBasin(feature, basinPolygon) {
  const geometry = feature.getGeometry();
  
  if (geometry instanceof ol.geom.Point) {
    // 对于点要素（水文站），直接检查点是否在多边形内
    return basinPolygon.intersectsCoordinate(geometry.getCoordinates());
  } else if (geometry instanceof ol.geom.LineString || geometry instanceof ol.geom.MultiLineString) {
    // 对于线要素（河网），使用精确的几何相交检测
    const lineExtent = geometry.getExtent();
    const polygonExtent = basinPolygon.getExtent();
    
    // 首先进行范围检查作为快速筛选
    if (ol.extent.intersects(lineExtent, polygonExtent)) {
      // 方法1: 尝试使用OpenLayers的intersects方法进行精确几何相交检测
      try {
        if (geometry.intersects(basinPolygon)) {
          return true;
        }
      } catch (e) {
        // 如果intersects方法出错，使用备选方案
        console.log('Intersects method error, using alternative approach:', e);
      }
      
      // 方法2: 检查线上的点是否在多边形内
      let coordinates = [];
      if (geometry instanceof ol.geom.LineString) {
        coordinates = geometry.getCoordinates();
      } else if (geometry instanceof ol.geom.MultiLineString) {
        // 对于MultiLineString，获取所有LineString
        const lineStrings = geometry.getLineStrings();
        for (let i = 0; i < lineStrings.length; i++) {
          // 检查每个LineString是否与多边形范围相交
          if (ol.extent.intersects(lineStrings[i].getExtent(), polygonExtent)) {
            // 如果范围相交，检查LineString的坐标点
            const lineCoords = lineStrings[i].getCoordinates();
            for (let j = 0; j < lineCoords.length; j++) {
              if (basinPolygon.intersectsCoordinate(lineCoords[j])) {
                return true;
              }
            }
          }
        }
        return false;
      }
      
      // 对于LineString，检查关键点是否在多边形内
      // 检查起点
      if (basinPolygon.intersectsCoordinate(coordinates[0])) {
        return true;
      }
      // 检查终点
      if (basinPolygon.intersectsCoordinate(coordinates[coordinates.length - 1])) {
        return true;
      }
      // 检查中点
      const midIndex = Math.floor(coordinates.length / 2);
      if (basinPolygon.intersectsCoordinate(coordinates[midIndex])) {
        return true;
      }
      
      // 采样检查线上的点
      const sampleRate = Math.max(1, Math.floor(coordinates.length / 5)); // 采样更多点以确保准确性
      for (let i = 0; i < coordinates.length; i += sampleRate) {
        if (basinPolygon.intersectsCoordinate(coordinates[i])) {
          return true;
        }
      }
    }
    return false;
  }
  
  return false;
}

// 过滤图层，只显示流域内的要素
function filterLayerByBasin(layer, basinPolygon, originalSource) {
  if (!layer || !basinPolygon || !originalSource) {
    return;
  }
  
  const newSource = new ol.source.Vector();
  
  // 遍历原始数据源中的所有要素
  originalSource.getFeatures().forEach(feature => {
    if (isFeatureInBasin(feature, basinPolygon)) {
      newSource.addFeature(feature.clone());
    }
  });
  
  // 更新图层的数据源
  layer.setSource(newSource);
}

// 恢复图层显示所有要素
function restoreOriginalLayers() {
  // 恢复河网图层
  if (riverLayer && originalRiverSource) {
    riverLayer.setSource(originalRiverSource);
  }
  // 恢复水文站图层
  if (cmaLayer && originalCmaSource) {
    cmaLayer.setSource(originalCmaSource);
  }
  // 恢复原始流域边界图层显示
  if (basinLayer) {
    basinLayer.setVisible(true);
    // 同时更新按钮状态
    const btnBasin = document.getElementById('btn-basin');
    if (btnBasin) {
      btnBasin.classList.add('active');
    }
  }
  // 移除搜索到的特定流域边界
  if (currentBasinLayer) {
    map.removeLayer(currentBasinLayer);
    currentBasinLayer = null;
  }
}

// 显示搜索到的流域边界
function showBasinBoundary(basinData) {
  // 清除之前的流域图层
  if (currentBasinLayer) {
    map.removeLayer(currentBasinLayer);
  }

  // 创建新的流域图层
  const vectorSource = new ol.source.Vector({
    features: new ol.format.GeoJSON().readFeatures(basinData, {
      featureProjection: 'EPSG:3857'
    })
  });

  currentBasinLayer = new ol.layer.Vector({
    source: vectorSource,
    style: function(feature) {
      const name = feature.get('BasinName') || '';
      return [
        new ol.style.Style({
          stroke: new ol.style.Stroke({ color: '#5D4037', width: 3 }),
          fill: null // 移除填充色，只显示边界线
        }),
        new ol.style.Style({
          text: new ol.style.Text({
            text: name,
            font: 'bold 20px Microsoft YaHei, Arial, sans-serif',
            fill: new ol.style.Fill({ color: '#000000' }),
            stroke: new ol.style.Stroke({ color: '#ffffff', width: 4 }),
            textAlign: 'center',
            textBaseline: 'middle',
            placement: 'point',
            offsetY: -15,
            scale: 1.3
          })
        })
      ];
    },
    type: 'current-basin-layer',
    zIndex: 60 // 确保流域边界显示在线要素层
  });

  map.addLayer(currentBasinLayer);
  
  // 隐藏原始的整个流域边界图层
  if (basinLayer) {
    basinLayer.setVisible(false);
    // 同时更新按钮状态
    const btnBasin = document.getElementById('btn-basin');
    if (btnBasin) {
      btnBasin.classList.remove('active');
    }
  }
  
  // 获取流域多边形
  const basinFeature = vectorSource.getFeatures()[0];
  if (basinFeature) {
    const basinPolygon = basinFeature.getGeometry();
    
    // 过滤河网和水文站图层，只显示流域内的要素
    filterLayerByBasin(riverLayer, basinPolygon, originalRiverSource);
    filterLayerByBasin(cmaLayer, basinPolygon, originalCmaSource);
  }
  
  // 缩放到流域范围
  const extent = vectorSource.getExtent();
  if (ol.extent.getWidth(extent) > 0 && ol.extent.getHeight(extent) > 0) {
    map.getView().fit(extent, { padding: [50, 50, 50, 50], duration: 900 });
  }
}

// 存储高程图例控制
let elevationLegendControl = null;

// 创建随缩放变化的高程图例
function createElevationLegend() {
  // 根据当前缩放级别确定高程范围和颜色映射
  const zoom = map.getView().getZoom();
  const elevationConfig = getElevationConfigForZoom(zoom);
  
  // 获取基础图例
  const basicLegend = document.getElementById('basic-legend');
  
  // 创建或获取图例flex容器
  let legendsContainer = document.getElementById('legends-container');
  
  if (!legendsContainer && basicLegend && basicLegend.parentNode) {
    // 创建一个容器来容纳两个图例
    legendsContainer = document.createElement('div');
    legendsContainer.id = 'legends-container';
    legendsContainer.style.display = 'flex';
    legendsContainer.style.gap = '10px';
    legendsContainer.style.alignItems = 'flex-start';
    
    // 获取基础图例的父元素
    const parent = basicLegend.parentNode;
    
    // 保存基础图例的下一个兄弟元素
    const nextSibling = basicLegend.nextSibling;
    
    // 将基础图例从父元素中移除
    parent.removeChild(basicLegend);
    
    // 将基础图例添加到容器中
    legendsContainer.appendChild(basicLegend);
    
    // 将容器插入到原来基础图例的位置
    if (nextSibling) {
      parent.insertBefore(legendsContainer, nextSibling);
    } else {
      parent.appendChild(legendsContainer);
    }
  }
  
  // 获取或创建高程图例容器
  let elevationLegendDiv = document.getElementById('elevation-legend');
  
  if (!elevationLegendDiv) {
    // 如果不存在，创建新的图例容器
    elevationLegendDiv = document.createElement('div');
    elevationLegendDiv.id = 'elevation-legend';
    elevationLegendDiv.className = 'legend-container';
    
    // 将图例添加到基础图例旁边
    if (legendsContainer) {
      legendsContainer.appendChild(elevationLegendDiv);
    }
  } else {
    // 如果存在，清空内容
    elevationLegendDiv.innerHTML = '';
  }
  
  // 图例标题
  const title = document.createElement('h3');
  title.textContent = '高程 (m)';
  elevationLegendDiv.appendChild(title);
  
  // 图例内容容器
  const contentDiv = document.createElement('div');
  contentDiv.className = 'legend-content';
  elevationLegendDiv.appendChild(contentDiv);
  
  // 创建高程色带容器
  const colorBarContainer = document.createElement('div');
  colorBarContainer.className = 'elevation-colorbar-container';
  colorBarContainer.style.display = 'flex';
  colorBarContainer.style.alignItems = 'center';
  colorBarContainer.style.gap = '5px';
  contentDiv.appendChild(colorBarContainer);
  
  // 数值标签容器
  const valuesContainer = document.createElement('div');
  valuesContainer.className = 'elevation-values';
  valuesContainer.style.display = 'flex';
  valuesContainer.style.flexDirection = 'column';
  valuesContainer.style.justifyContent = 'space-between';
  valuesContainer.style.height = '200px'; // 与色带高度匹配
  colorBarContainer.appendChild(valuesContainer);
  
  // 最大高程标签（上方）
  const maxLabel = document.createElement('div');
  maxLabel.textContent = elevationConfig.max.toString();
  maxLabel.style.textAlign = 'right';
  valuesContainer.appendChild(maxLabel);
  
  // 最小高程标签（下方）
  const minLabel = document.createElement('div');
  minLabel.textContent = elevationConfig.min.toString();
  minLabel.style.textAlign = 'right';
  valuesContainer.appendChild(minLabel);
  
  // 色带
  const colorBar = document.createElement('div');
  colorBar.className = 'elevation-colorbar';
  colorBar.style.background = `linear-gradient(to bottom, ${elevationConfig.gradient})`;
  colorBar.style.height = '200px'; // 增加高度使其在垂直方向拉长
  colorBarContainer.appendChild(colorBar);
  
  // 添加缩放级别提示
  const zoomHint = document.createElement('div');
  zoomHint.className = 'zoom-level-hint';
  zoomHint.textContent = `缩放级别: ${Math.round(zoom)}`;
  contentDiv.appendChild(zoomHint);
  
  // 根据当前底图类型控制图例显示
  updateElevationLegendVisibility();
}

// 根据缩放级别获取高程配置
function getElevationConfigForZoom(zoom) {
  // 定义不同缩放级别的高程范围和颜色映射
  // 缩放级别越高，显示的高程范围越精细
  if (zoom >= 10) {
    // 城市级别 - 小范围高程变化
    return {
      min: -100, max: 5000,
      gradient: '#0000FF, #008000, #FFFF00, #FFA500, #FF0000'
    };
  } else if (zoom >= 7) {
    // 区域级别 - 中等范围高程变化
    return {
      min: -500, max: 8000,
      gradient: '#0000AA, #008000, #FFFF00, #FFA500, #BB0000'
    };
  } else if (zoom >= 4) {
    // 国家级别 - 大范围高程变化
    return {
      min: -1000, max: 10000,
      gradient: '#000088, #006600, #DDDD00, #CC8800, #880000'
    };
  } else {
    // 全球级别 - 全球高程范围
    return {
      min: -5000, max: 15000,
      gradient: '#000066, #004400, #BBBB00, #AA6600, #660000'
    };
  }
}

// 更新高程图例可见性
function updateElevationLegendVisibility() {
  // 检查当前是否为卫星混合地图模式
  const isHybridVisible = baseLayers['hybrid'] && 
                         Array.isArray(baseLayers['hybrid']) && 
                         baseLayers['hybrid'][0] && 
                         baseLayers['hybrid'][0].getVisible();
                          
  // 控制基础图例显示 - 始终保持可见
  const basicLegend = document.getElementById('basic-legend');
  if (basicLegend) {
    basicLegend.style.display = 'block';
  }
  
  // 控制高程图例显示
  const elevationLegend = document.getElementById('elevation-legend');
  if (elevationLegend) {
    elevationLegend.style.display = isHybridVisible ? 'block' : 'none';
  }
}

// 地图交互事件
map.on('click', function(evt) {
  const feature = map.forEachFeatureAtPixel(evt.pixel, (f) => f);
  if (feature) {
    const coordinates = feature.getGeometry().getCoordinates();
    const [lng, lat] = ol.proj.toLonLat(coordinates);
    console.log('点击位置:', { lng, lat });
  }
});

map.on('pointermove', function(evt) {
  const hit = map.hasFeatureAtPixel(evt.pixel);
  map.getTargetElement().style.cursor = hit ? 'pointer' : '';
});

// 在地图初始化后立即创建高程图例
map.on('load', function() {
  createElevationLegend();
});

// 地图缩放事件更新高程图例
map.getView().on('change:resolution', function() {
  if (elevationLegendControl && elevationLegendControl.element && 
      elevationLegendControl.element.style.display !== 'none') {
    createElevationLegend(); // 重新创建图例
  }
});

// 搜索框事件
document.getElementById('search-btn').addEventListener('click', () => {
  const searchInput = document.getElementById('place-search');
  const place = searchInput.value.trim();
  if (place === '') {
    // 如果搜索框为空，让搜索框获得焦点
    searchInput.focus();
  } else {
    // 否则执行搜索
    handleSearch(place);
  }
});

document.getElementById('place-search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const place = e.target.value.trim();
    handleSearch(place);
  }
});

// 页面初始化
document.addEventListener('DOMContentLoaded', function() {
  switchBasemap("normal"); // 初始化底图
  // 分类折叠展开功能（所有页面通用，仅 UI 交互）
  initCategoryFold();
  // 左侧图层面板：悬浮岛式（标题栏 + 收起/展开按钮）
  initSidepanelFloat();
  
  if (isHomePage) {
    // 默认勾选图层（河网/湖泊/冻土/冰川等）统一由 initDefaultLayerStates()
    // 按面板勾选状态触发加载，此处不再单独调用各 load 函数（避免双重触发重复加载）
    // 初始化默认勾选的图层状态
    initDefaultLayerStates();
  }
  
  // 为了防止与其他图例冲突，我们可以在CSS中设置图例的堆叠顺序
  const style = document.createElement('style');
  style.textContent = `
    .elevation-legend {
      z-index: 999 !important;
    }
  `;
  document.head.appendChild(style);

  // 当前页面所有要素加载函数都已被触发，开始跟踪加载进度（全部完成才移除系统加载动效）
  pageLoadState.start();
});

// 分类折叠展开功能初始化
function initCategoryFold() {
  const categoryHeaders = document.querySelectorAll('.category-header');
  
  // 防止重复初始化
  if (window.categoryFoldInitialized) {
    return;
  }
  window.categoryFoldInitialized = true;
  
  categoryHeaders.forEach(header => {
    const categoryItem = header.parentElement;
    const content = categoryItem.querySelector('.category-content');
    const toggleIcon = header.querySelector('.toggle-icon');
    const categoryIcon = header.querySelector('span i');
    
    // 初始状态：所有分类默认折叠
    content.classList.remove('expanded');
    header.classList.remove('active');
    if (toggleIcon) toggleIcon.style.transform = 'rotate(0deg)';
    
    header.addEventListener('click', function(e) {
      // 防止点击checkbox时触发折叠
      if (e.target.type === 'checkbox') return;
      
      const categoryItem = this.parentElement;
      const content = categoryItem.querySelector('.category-content');
      const toggleIcon = this.querySelector('.toggle-icon');
      
      // 切换展开状态
      const isExpanded = content.classList.contains('expanded');
      
      if (isExpanded) {
        // 折叠
        content.classList.remove('expanded');
        this.classList.remove('active');
        if (toggleIcon) toggleIcon.style.transform = 'rotate(0deg)';
        
        // 添加折叠动画
        content.style.transition = 'max-height 0.3s ease';
        content.style.maxHeight = '0';
      } else {
        // 展开：手风琴模式——先收起其他已展开的分类
        document.querySelectorAll('.category-content.expanded').forEach(other => {
          if (other !== content) {
            other.classList.remove('expanded');
            const otherHeader = other.parentElement.querySelector('.category-header');
            if (otherHeader) otherHeader.classList.remove('active');
            const otherIcon = other.parentElement.querySelector('.toggle-icon');
            if (otherIcon) otherIcon.style.transform = 'rotate(0deg)';
            other.style.maxHeight = '0';
          }
        });
        // 再展开当前分类
        content.classList.add('expanded');
        this.classList.add('active');
        if (toggleIcon) toggleIcon.style.transform = 'rotate(180deg)';
        
        // 设置最大高度以适应内容
        const contentHeight = content.scrollHeight;
        content.style.maxHeight = contentHeight + 'px';
      }
    });
    
    // 添加图层控制功能
    const checkboxes = content.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(checkbox => {
      checkbox.addEventListener('change', function() {
        const layerId = this.id;
        const isChecked = this.checked;
        
        // 这里可以添加图层显示/隐藏的逻辑
        console.log(`图层 ${layerId} ${isChecked ? '已显示' : '已隐藏'}`);
        
        // 根据图层ID执行相应的图层控制
        handleLayerToggle(layerId, isChecked);
      });
    });
    
    // 添加键盘支持
    header.setAttribute('tabindex', '0');
    header.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.click();
      }
    });
  });
  
  // 所有分类默认折叠，不展开任何分类
}

// 左侧图层面板：悬浮岛式交互（所有页面共用）
// - 面板默认悬浮展开；头部提供收起按钮
// - 收起后显示左侧边缘的小圆钮，点击重新展开
function initSidepanelFloat() {
  const panels = document.querySelectorAll('.sidepanel');
  if (!panels.length) return;
  if (window.sidepanelFloatInitialized) return;
  window.sidepanelFloatInitialized = true;

  // 为每个面板注入头部（标题「图层管理」+ 收起按钮），并移除原有的"查看选项"字样
  panels.forEach(panel => {
    if (panel.querySelector('.sidepanel-head')) return;
    // 删除旧的 <h3>查看选项</h3>
    const oldTitle = panel.querySelector('h3');
    if (oldTitle) oldTitle.remove();
    const head = document.createElement('div');
    head.className = 'sidepanel-head';
    head.innerHTML =
      '<span class="sidepanel-head-title"><i class="fa fa-th-large"></i>图层管理</span>' +
      '<button type="button" class="sidepanel-collapse-btn" title="收起面板">&times;</button>';
    panel.prepend(head);
    head.querySelector('.sidepanel-collapse-btn').addEventListener('click', function (e) {
      e.stopPropagation();
      panel.classList.add('collapsed');
      document.body.classList.add('sidepanel-collapsed');
    });
    // 非首页：左侧图层面板默认折叠（仅显示展开圆钮），首页默认展开
    if (!isHomePage) {
      panel.classList.add('collapsed');
      document.body.classList.add('sidepanel-collapsed');
    }
  });

  // 展开按钮（页面级，只创建一次）
  if (!document.querySelector('.sidepanel-toggle')) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'sidepanel-toggle';
    toggle.title = '展开图层面板';
    toggle.innerHTML = '<i class="fa fa-th-large"></i>';
    toggle.addEventListener('click', function () {
      panels.forEach(panel => {
        panel.classList.remove('collapsed');
        document.body.classList.remove('sidepanel-collapsed');
      });
    });
    document.body.appendChild(toggle);
  }
}

// 初始化默认图层状态
// 面板勾选状态是唯一事实来源：遍历所有 .layer-checkbox（按运行时 .checked 判断，
// 而非仅 HTML 里的 [checked] 属性），勾选 → 显示/按需加载；未勾选 → 显式隐藏
function initDefaultLayerStates() {
  const layerCheckboxes = document.querySelectorAll('.layer-checkbox');

  layerCheckboxes.forEach(checkbox => {
    const layerId = checkbox.id;
    const isChecked = checkbox.checked;

    // 触发图层显示/隐藏（未加载且勾选时由 handleLayerToggle 按需加载）
    handleLayerToggle(layerId, isChecked);

    console.log(`初始化图层 ${layerId} ${isChecked ? '已显示' : '已隐藏'}`);
  });
}

// ---------- 湖泊数据加载函数 ----------
function loadLakeData() {
  // 幂等守卫：已加载过则不再重复请求（防止双重触发产生两个同名图层）
  if (lakeLayer) return;
  pageLoadState.register('lake');
  showLoading(true, '正在加载湖泊分布数据...');
  
  // 尝试从后端API加载湖泊数据
  fetch('/api/basin/lake')
    .then(res => {
      if (!res.ok) throw new Error('接口湖泊数据加载失败');
      return res.json();
    })
    .then(data => {
      const lakeSource = new ol.source.Vector({
        features: new ol.format.GeoJSON().readFeatures(data, {
          featureProjection: 'EPSG:3857'
        })
      });
      
      lakeLayer = new ol.layer.Vector({
        source: lakeSource,
        style: new ol.style.Style({
          fill: new ol.style.Fill({
            color: 'rgba(135, 206, 235, 0.7)' // 浅天蓝色填充表示湖泊，与冰川区分
          }),
          stroke: new ol.style.Stroke({
            color: 'rgba(70, 130, 180, 0.9)',
            width: 1
          })
        }),
        type: 'lake-layer',
        zIndex: 55
      });
      
      map.addLayer(lakeLayer);
      // 按面板勾选状态同步可见性（面板勾选状态为唯一事实来源）
      const lakeCheckbox = document.getElementById('layer-lake');
      lakeLayer.setVisible(!!(lakeCheckbox && lakeCheckbox.checked));
      console.log('湖泊分布数据加载完成！');
      pageLoadState.complete('lake');
      showLoading(false);
    })
    .catch(error => {
      console.error('接口加载失败，尝试加载本地数据:', error);
      // 如果后端API失败，尝试从本地文件加载
      fetch('/data/raw/geo/hydrology/TP_China_Lake.geojson')
        .then(res => {
          if (!res.ok) throw new Error('本地湖泊数据加载失败');
          return res.json();
        })
        .then(data => {
          const lakeSource = new ol.source.Vector({
            features: new ol.format.GeoJSON().readFeatures(data, {
              featureProjection: 'EPSG:3857'
            })
          });
          
          lakeLayer = new ol.layer.Vector({
            source: lakeSource,
            style: new ol.style.Style({
              fill: new ol.style.Fill({
                color: 'rgba(135, 206, 235, 0.7)' // 浅天蓝色填充表示湖泊，与冰川区分
              }),
              stroke: new ol.style.Stroke({
                color: 'rgba(70, 130, 180, 0.9)',
                width: 1
              })
            })
          });
          
          map.addLayer(lakeLayer);
          // 按面板勾选状态同步可见性（面板勾选状态为唯一事实来源）
          const lakeCheckbox2 = document.getElementById('layer-lake');
          lakeLayer.setVisible(!!(lakeCheckbox2 && lakeCheckbox2.checked));
          console.log('湖泊分布数据加载完成！');
          pageLoadState.complete('lake');
          showLoading(false);
        })
        .catch(e2 => {
          console.error('加载湖泊数据错误:', error, e2);
          console.log('湖泊数据加载失败，部分功能可能受限');
          pageLoadState.complete('lake');
          showLoading(false);
        });
    });
}

// 图层控制处理函数
function handleLayerToggle(layerId, isVisible) {
  // 根据图层ID控制相应的地图图层
  switch (layerId) {
    // 基础地理图层
    case 'layer-basin':
      if (basinLayer) {
        basinLayer.setVisible(isVisible);
      } else if (isVisible) {
        // 尚未加载且需要显示时，按需加载流域边界
        loadBasinData();
      }
      console.log(`流域边界图层 ${isVisible ? '已显示' : '已隐藏'}`);
      break;
    case 'layer-basin-5':
      if (basin5Layer) {
        basin5Layer.setVisible(isVisible);
      } else if (isVisible) {
        // 尚未加载且需要显示时，按需加载五级流域边界
        loadBasin5Data();
      }
      console.log(`五级流域边界图层 ${isVisible ? '已显示' : '已隐藏'}`);
      break;
    case 'layer-river':
      if (riverLayer) {
        riverLayer.setVisible(isVisible);
      } else if (isVisible) {
        // 尚未加载且需要显示时，按需加载河网
        loadRiverData();
      }
      console.log(`河网水系图层 ${isVisible ? '已显示' : '已隐藏'}`);
      break;
    case 'layer-lake':
      // 控制湖泊图层
      if (lakeLayer) {
        lakeLayer.setVisible(isVisible);
      } else if (isVisible) {
        // 如果湖泊图层尚未加载且需要显示，则加载它
        loadLakeData();
      }
      
      console.log(`湖泊分布图层 ${isVisible ? '已显示' : '已隐藏'}`);
      break;
    case 'layer-cryo-glacier':
    case 'layer-glacier':
      if (glacierLayer) {
        glacierLayer.setVisible(isVisible);
      } else if (isVisible) {
        // 尚未加载且需要显示时，按需加载冰川分布图层
        loadGlacierLayer();
      }
      console.log(`冰川分布图层 ${isVisible ? '已显示' : '已隐藏'}`);
      break;
    case 'layer-cryo-permafrost':
    case 'layer-permafrost':
      if (permafrostLayer) {
        permafrostLayer.setVisible(isVisible);
      } else if (isVisible) {
        // 尚未加载且需要显示时，按需加载冻土分布图层
        loadPermafrostLayer();
      }
      console.log(`冻土分布图层 ${isVisible ? '已显示' : '已隐藏'}`);
      break;
    
    // 社会经济图层
    case 'layer-economy':
      // 控制经济数据图层
      if (economyLayer) {
        economyLayer.setVisible(isVisible);
      } else if (isVisible) {
        // 如果经济数据图层尚未加载且需要显示，则加载它
        loadEconomyData();
      }
      
      console.log(`经济数据图层 ${isVisible ? '已显示' : '已隐藏'}`);
      break;
    case 'layer-railway':
      // 控制铁路图层
      if (railwayLayer) {
        railwayLayer.setVisible(isVisible);
      } else if (isVisible) {
        // 如果铁路图层尚未加载且需要显示，则加载它
        loadRailwayData();
      }
      
      console.log(`铁路网络图层 ${isVisible ? '已显示' : '已隐藏'}`);
      break;
    
    case 'layer-road':
      // 控制公路图层
      if (roadLayer) {
        roadLayer.setVisible(isVisible);
      } else if (isVisible) {
        // 如果公路图层尚未加载且需要显示，则加载它
        loadRoadData();
      }
      
      console.log(`公路网络图层 ${isVisible ? '已显示' : '已隐藏'}`);
      break;
    case 'layer-powerplant':
      // 控制能源站点图层
      if (powerplantLayer) {
        powerplantLayer.setVisible(isVisible);
      } else if (isVisible) {
        // 如果能源站点图层尚未加载且需要显示，则加载它
        loadPowerplantData();
      }
      
      console.log(`能源站点图层 ${isVisible ? '已显示' : '已隐藏'}`);
      break;
    case 'layer-dam':
      // 控制水坝图层
      if (damLayer) {
        damLayer.setVisible(isVisible);
      } else if (isVisible) {
        // 如果水坝图层尚未加载且需要显示，则加载它
        loadDamData();
      }
      
      console.log(`水坝图层 ${isVisible ? '已显示' : '已隐藏'}`);
      break;
    case 'layer-reservoir':
      // 控制水库图层
      if (reservoirLayer) {
        reservoirLayer.setVisible(isVisible);
      } else if (isVisible) {
        // 如果水库图层尚未加载且需要显示，则加载它
        loadReservoirData();
      }
      
      console.log(`水库图层 ${isVisible ? '已显示' : '已隐藏'}`);
      break;
    
    // 行政区划图层
    case 'layer-admin':
      console.log(`行政区划图层 ${isVisible ? '已显示' : '已隐藏'}`);
      break;
    
    // 县级居民地图层
    case 'layer-settlement':
      // 控制居民地图层
      if (settlementLayer) {
        settlementLayer.setVisible(isVisible);
      } else if (isVisible) {
        // 如果居民地图层尚未加载且需要显示，则加载它
        loadSettlementData();
      }
      
      console.log(`县级居民地图层 ${isVisible ? '已显示' : '已隐藏'}`);
      break;

    // 地市级居民地图层
    case 'layer-city-settlement':
      // 控制地市级居民地图层
      if (citySettlementLayer) {
        citySettlementLayer.setVisible(isVisible);
      } else if (isVisible) {
        // 如果地市级居民地图层尚未加载且需要显示，则加载它
        loadCitySettlementData();
      }
      
      console.log(`地市级居民地图层 ${isVisible ? '已显示' : '已隐藏'}`);
      break;

    // 首都和省级行政中心图层
    case 'layer-capital-settlement':
      // 控制首都和省级行政中心图层
      if (capitalSettlementLayer) {
        capitalSettlementLayer.setVisible(isVisible);
      } else if (isVisible) {
        // 如果首都和省级行政中心图层尚未加载且需要显示，则加载它
        loadCapitalSettlementData();
      }
      
      console.log(`首都和省级行政中心图层 ${isVisible ? '已显示' : '已隐藏'}`);
      break;

    // 行政边界图层
    case 'layer-boundary-country':
      // 控制国界图层
      if (boundaryCountryLayer) {
        boundaryCountryLayer.setVisible(isVisible);
      } else if (isVisible) {
        // 如果国界图层尚未加载且需要显示，则加载它
        loadBoundaryCountryData();
      }
      
      console.log(`国界图层 ${isVisible ? '已显示' : '已隐藏'}`);
      break;

    case 'layer-boundary-province':
      // 控制国界与省界图层
      if (boundaryProvinceLayer) {
        boundaryProvinceLayer.setVisible(isVisible);
      } else if (isVisible) {
        // 如果国界与省界图层尚未加载且需要显示，则加载它
        loadBoundaryProvinceData();
      }
      
      console.log(`国界与省界图层 ${isVisible ? '已显示' : '已隐藏'}`);
      break;

    case 'layer-boundary-city':
      // 控制地级行政界线图层
      if (boundaryCityLayer) {
        boundaryCityLayer.setVisible(isVisible);
      } else if (isVisible) {
        // 如果地级行政界线图层尚未加载且需要显示，则加载它
        loadBoundaryCityData();
      }
      
      console.log(`地级行政界线图层 ${isVisible ? '已显示' : '已隐藏'}`);
      break;

    case 'layer-boundary-county':
      // 控制县级行政界线图层
      if (boundaryCountyLayer) {
        boundaryCountyLayer.setVisible(isVisible);
      } else if (isVisible) {
        // 如果县级行政界线图层尚未加载且需要显示，则加载它
        loadBoundaryCountyData();
      }
      
      console.log(`县级行政界线图层 ${isVisible ? '已显示' : '已隐藏'}`);
      break;
    
    // 气象水文图层
    case 'layer-temperature':
      console.log(`温度数据图层 ${isVisible ? '已显示' : '已隐藏'}`);
      break;
    case 'layer-precipitation':
      console.log(`降水数据图层 ${isVisible ? '已显示' : '已隐藏'}`);
      break;
    case 'layer-hydrology':
      if (cmaLayer) {
        cmaLayer.setVisible(isVisible);
        console.log(`水文站点图层 ${isVisible ? '已显示' : '已隐藏'}`);
      } else if (isVisible) {
        // 如果水文站图层尚未加载且需要显示，则加载它
        loadCmaData();
      }
      break;
    case 'layer-weather-station':
      if (weatherStationLayer) {
        weatherStationLayer.setVisible(isVisible);
        console.log(`气象站点图层 ${isVisible ? '已显示' : '已隐藏'}`);
      } else if (isVisible) {
        // 如果气象站图层尚未加载且需要显示，则加载它
        loadWeatherStationData();
      }
      break;
    
    // 冰冻圈图层
    
    // 洪灾事件图层
    case 'layer-glacial-lake-floods':
    case 'layer-landslide-dam-floods':
    case 'layer-snowmelt-floods':
    case 'layer-rainfall-floods':
      const disasterType = layerId.replace('layer-', '').replace(/-/g, '_');
      if (window.disasterLayers && window.disasterLayers[disasterType]) {
        window.disasterLayers[disasterType].setVisible(isVisible);
        console.log(`洪灾事件图层 ${disasterType} ${isVisible ? '已显示' : '已隐藏'}`);
      }
      break;
    
    default:
      console.log(`图层 ${layerId} 控制功能待实现`);
  }
}


// 冰冻圈分类交互功能
function initCryosphereInteractions() {
  
  // 冻土和冰川数据点击事件
  const permafrostItem = document.querySelector('#cryosphere-category .category-item[data-type="permafrost"]');
  const glacierItem = document.querySelector('#cryosphere-category .category-item[data-type="glacier"]');
  
  if (permafrostItem) {
    permafrostItem.addEventListener('click', function() {
      const checkbox = this.querySelector('input[type="checkbox"]');
      if (checkbox) {
        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event('change'));
        updateNavigationHighlight('permafrost');
      }
    });
  }
  
  if (glacierItem) {
    glacierItem.addEventListener('click', function() {
      const checkbox = this.querySelector('input[type="checkbox"]');
      if (checkbox) {
        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event('change'));
        updateNavigationHighlight('glacier');
      }
    });
  }
}

// 根据当前页面 URL 设置主导航高亮（保证在哪个 HTML 页面，对应导航按钮就常亮）
function initNavHighlightByPage() {
  const pageMap = {
    'index.html': 'a[href="index.html"]',
    'query.html': '.dropdown-toggle[data-page="query"]',
    'simulate.html': '.dropdown-toggle[data-page="simulate"]',
    'alert.html': '.dropdown-toggle[data-page="alert"]',
    'decision.html': '.dropdown-toggle[data-page="decision"]',
    'admin.html': '.dropdown-toggle[data-page="admin"]',
    // 三维示范区是决策支持下拉里的一个普通入口（独立页面），
    // 停留时把「决策支持」这个导航项点亮
    'terrain3d.html': '.dropdown-toggle[data-page="decision"]'
  };
  const pageName = (window.location.pathname.split('/').pop() || 'index.html');
  const selector = pageMap[pageName];
  if (!selector) return;
  const target = document.querySelector(selector);
  if (target && !target.classList.contains('active')) {
    target.classList.add('active');
  }
}

// ============ 统一导航栏下拉交互（所有页面共用） ============
// 每个下拉 toggle 点击：展开对应菜单并关闭其他菜单
function initUnifiedDropdowns() {
  // 1. toggle 点击展开/收起
  document.querySelectorAll('.dropdown-toggle').forEach(toggle => {
    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const menu = toggle.nextElementSibling;
      // 关闭其他已展开的菜单
      document.querySelectorAll('.dropdown-menu.active').forEach(m => {
        if (m !== menu) m.classList.remove('active');
      });
      if (menu) menu.classList.toggle('active');
    });
  });

  // 2. 点击页面其他区域关闭所有下拉菜单
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.dropdown-container')) {
      document.querySelectorAll('.dropdown-menu.active').forEach(m => m.classList.remove('active'));
    }
  });

  // 3. 下拉项点击：同页切换分类（不刷新），跨页正常跳转
  document.querySelectorAll('.dropdown-item').forEach(item => {
    item.addEventListener('click', (e) => {
      const href = item.getAttribute('href') || '';
      const current = window.location.pathname.split('/').pop();
      const target = href.split('?')[0];
      const qs = new URLSearchParams(href.split('?')[1] || '');
      const cat = qs.get('cat');
      if (target === current && cat) {
        // 当前页面内的二级菜单：阻止刷新，直接切换分类并收起下拉
        e.preventDefault();
        document.querySelectorAll('.dropdown-menu.active').forEach(m => m.classList.remove('active'));
        if (window.applyNavCategory) window.applyNavCategory(cat);
      }
    });
  });

  // 4. 页面加载时读取 URL 参数 cat，自动打开对应二级界面
  const cat = new URLSearchParams(window.location.search).get('cat');
  if (cat) {
    // 等待各页面专属 JS 初始化完成后应用
    setTimeout(() => {
      if (window.applyNavCategory) window.applyNavCategory(cat);
    }, 400);
  }
}

// 更新导航栏高亮（仅作用于冰冻圈分类链接，不影响主导航常亮）
function updateNavigationHighlight(dataType) {
  // 仅移除冰冻圈分类链接的高亮
  document.querySelectorAll('.nav-links a[href="#permafrost"], .nav-links a[href="#glacier"]').forEach(link => {
    link.classList.remove('active');
  });
  
  // 根据数据类型添加对应的导航高亮
  let targetNav = null;
  switch(dataType) {
    case 'permafrost':
      targetNav = document.querySelector('.nav-links a[href="#permafrost"]');
      break;
    case 'glacier':
      targetNav = document.querySelector('.nav-links a[href="#glacier"]');
      break;
  }
  
  if (targetNav) {
    targetNav.classList.add('active');
  }
  // 主导航按钮始终按当前页面保持常亮
  initNavHighlightByPage();
}

// 页面加载完成后初始化冰冻圈交互 + 主导航高亮 + 统一下拉交互
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function() {
    initCryosphereInteractions();
    initNavHighlightByPage();
    initUnifiedDropdowns();
  });
} else {
  initCryosphereInteractions();
  initNavHighlightByPage();
  initUnifiedDropdowns();
}