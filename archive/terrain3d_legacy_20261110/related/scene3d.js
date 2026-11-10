/**
 * 三维示范区（决策支持 → 三维示范区页签）
 *
 * 架构：
 *  - Cesium 引擎懒加载：仅在首次激活本页签时动态注入 /cesium/Cesium.js
 *    （先设 window.CESIUM_BASE_URL='/cesium/'，否则 Worker/Assets 404）。
 *  - 场景挂载：Cesium 容器作为 #map 内的绝对定位覆盖层（z-index 继承 #map，
 *    天然位于左侧图层面板与右侧决策侧栏之下），切换页签时仅显隐，不销毁，
 *    避免重复创建 Viewer 的耗时；隐藏时停掉渲染循环省 GPU。
 *  - 数据：地形/矢量全部来自后端 /api/3d 与 /tiles3d（manifest 驱动）；
 *    影像为高德在线卫星瓦片（标准 XYZ/Web Mercator，需联网）。
 *
 * 对外接口（由 decision.html 内联脚本的 toggleCategory 调用）：
 *  window.Scene3D.activate()   切入本页签
 *  window.Scene3D.deactivate() 切出本页签
 */
(function () {
  'use strict';

  // 构建标记：改动本文件时递增，并在 decision.html 的 <script src> 同步改 ?v=
  // 便于确认浏览器加载的到底是哪一版（避免"改了没生效"其实是缓存）
  var BUILD = 'v2026-10-28e';

  var state = {
    active: false,
    cesiumReady: false,
    cesiumLoading: null,
    viewer: null,
    imageryLayer: null,
    dataSources: {},        // layerName -> GeoJsonDataSource
    layerDefs: [],          // manifest 中的图层定义
    regions: [],
    region: null,
    container: null,
    building: false,
    maskVisible: true,
    maskEntity: null,
  };

  // ---------------------------------------------------------- 工具
  function $(id) { return document.getElementById(id); }

  function setStatus(msg, isError) {
    var el = $('scene3d-status');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('error', !!isError);
  }

  function toast(msg, type) {
    if (window.UI && window.UI.toast) {
      window.UI.toast(msg, type || 'info');
    } else {
      console.log('[scene3d]', msg);
    }
  }

  function hasWebGL() {
    try {
      var c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch (e) {
      return false;
    }
  }

  // ---------------------------------------------------------- Cesium 懒加载
  function loadCesium() {
    if (state.cesiumReady) return Promise.resolve();
    if (state.cesiumLoading) return state.cesiumLoading;
    state.cesiumLoading = new Promise(function (resolve, reject) {
      if (window.Cesium) { state.cesiumReady = true; return resolve(); }
      window.CESIUM_BASE_URL = '/cesium/';
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = '/cesium/Widgets/widgets.css';
      document.head.appendChild(link);
      var s = document.createElement('script');
      s.src = '/cesium/Cesium.js';
      s.onload = function () {
        if (window.Cesium) { state.cesiumReady = true; resolve(); }
        else { reject(new Error('Cesium.js 加载后未定义全局对象')); }
      };
      s.onerror = function () {
        reject(new Error('无法加载 /cesium/Cesium.js（请确认 webgis_frontend/cesium/ 已就位）'));
      };
      document.head.appendChild(s);
    });
    return state.cesiumLoading;
  }

  // 地图区域中央的状态覆盖层：初始化中/失败必须显眼。
  // 否则一旦 Cesium 没起来，用户看到的是底下那张二维地图，只会觉得"这根本不是三维"。
  function showOverlay(msg, isError) {
    var c = ensureContainer();
    c.style.display = 'block';
    var el = c.querySelector('.scene3d-overlay');
    if (!el) {
      el = document.createElement('div');
      el.className = 'scene3d-overlay';
      c.appendChild(el);
    }
    el.className = 'scene3d-overlay' + (isError ? ' error' : '');
    el.innerHTML = msg;
    el.style.display = 'flex';
  }

  function hideOverlay() {
    if (!state.container) return;
    var el = state.container.querySelector('.scene3d-overlay');
    if (el) el.style.display = 'none';
  }

  // ---------------------------------------------------------- 场景构建
  function ensureContainer() {
    if (state.container) return state.container;
    var mapEl = $('map');
    var div = document.createElement('div');
    div.id = 'cesiumContainer';
    div.className = 'cesium-container';
    mapEl.appendChild(div);
    state.container = div;
    return div;
  }

  function buildScene(region) {
    if (state.building) return;
    state.building = true;
    state.region = region;
    setStatus('正在初始化三维场景（首次约需几秒）… ' + BUILD);
    var container = ensureContainer();
    container.innerHTML = '';          // 先清空，再放覆盖层（顺序不能反）
    showOverlay('正在加载三维引擎与地形瓦片…<br><span class="sub">' + BUILD + ' · ' +
      (region.name || region.id) + '</span>');

    loadCesium()
      .then(function () {
        return Cesium.CesiumTerrainProvider.fromUrl(region.terrain.url, {
          requestVertexNormals: true,
        });
      })
      .then(function (terrainProvider) {
        var viewer = new Cesium.Viewer(container, {
          terrainProvider: terrainProvider,
          baseLayer: false,            // 不使用 ion 默认底图
          baseLayerPicker: false,
          geocoder: false,
          homeButton: false,
          sceneModePicker: false,
          navigationHelpButton: false,
          animation: false,
          timeline: false,
          fullscreenButton: false,
          vrButton: false,
          infoBox: true,               // 点击灾害点查看属性
          selectionIndicator: true,
          // 按需渲染：只有相机/数据变化时才重绘。默认是 60fps 连续渲染，
          // 在集显笔记本上会一直"卡卡的"并持续耗电。
          requestRenderMode: true,
          maximumRenderTimeChange: Infinity,
        });
        state.viewer = viewer;
        viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#0f172a');

        // 地形瓦片错误默认只进 console，用户看不到；这里直接报到状态栏
        if (terrainProvider.errorEvent) {
          terrainProvider.errorEvent.addEventListener(function (err) {
            console.warn('[scene3d] terrain tile error', err);
            if (!state.terrainErrorShown) {
              state.terrainErrorShown = true;
              setStatus('地形瓦片请求失败 ' + BUILD + '：' +
                (err && err.message ? err.message : err), true);
            }
          });
        }

        // 隐藏 Cesium 自带署名条（含 ionData attribution 等云服务默认署名）：
        // 本项目完全自托管、未使用 Cesium ion 任何数据，故不显示其默认署名；
        // 引擎与数据来源改由自绘署名条声明（见下方 .scene3d-credit）。
        try { viewer.cesiumWidget.creditContainer.style.display = 'none'; } catch (e) { /* ignore */ }
        addCreditLine(container);
        // 限制缩放到高原尺度，避免一路飞到大西洋上空
        try {
          viewer.scene.screenSpaceCameraController.maximumZoomDistance = 4000000;
        } catch (e) { /* ignore */ }

        // 影像底图：本地晕渲瓦片（不联网）或高德在线卫星
        var im = region.imagery || {};
        if (im.type === 'local-hillshade') {
          state.imageryLayer = viewer.imageryLayers.addImageryProvider(
            new Cesium.UrlTemplateImageryProvider({
              url: im.url,
              maximumLevel: im.maxZoom || 11,
              credit: '地形晕渲（由项目 DEM 生成）',
            }));
        } else if (im.type === 'amap-satellite-online') {
          state.imageryLayer = viewer.imageryLayers.addImageryProvider(
            new Cesium.UrlTemplateImageryProvider({
              url: im.url,
              subdomains: im.subdomains || ['1', '2', '3', '4'],
              maximumLevel: im.maxZoom || 16,
              credit: '高德卫星影像（在线）',
            }));
        }

        // “看得出是三维”的两个关键开关：
        // 1) 固定白天时间 + 日照——Cesium 默认用本机当前时间，青藏高原夜间会一片黑；
        //    开光照后山体起伏才有明暗对比。
        viewer.clock.currentTime = Cesium.JulianDate.fromIso8601('2026-07-01T03:00:00Z');
        viewer.clock.shouldAnimate = false;
        viewer.scene.globe.enableLighting = true;
        viewer.scene.globe.showGroundAtmosphere = true;

        // 2) 垂直夸张（滑杆默认 1.5×，可调回 1.0× 还原真实比例）
        var exEl = $('scene3d-exaggeration');
        applyExaggeration(viewer, exEl ? parseFloat(exEl.value) : 1.5);

        return loadVectorLayers(viewer, region)
          .then(function () {
            // 只在"全域"型区域加遮罩；子区域（如喜马拉雅）数据本身就是裁好的
            return region.mask === false ? null : addRegionMask(viewer, region);
          })
          .then(function () { return checkTerrain(viewer); });
      })
      .then(function () {
        flyToRegion(state.viewer, state.region);
        hideOverlay();
        state.building = false;
      })
      .catch(function (err) {
        state.building = false;
        console.error('[scene3d] build failed', err);
        var msg = (err && err.message ? err.message : String(err));
        setStatus('三维场景初始化失败 ' + BUILD + '：' + msg +
          '。若尚未生成三维数据，请先运行 scripts/build_3d_tiles.py。', true);
        showOverlay('<strong>三维场景初始化失败</strong><br><span class="sub">' +
          BUILD + ' · ' + msg + '</span><br>' +
          '<span class="sub">检查 /cesium/Cesium.js 与 /tiles3d/tp_full/terrain/layer.json 是否可访问</span>',
          true);
        toast('三维场景初始化失败', 'error');
      });
  }

  function loadVectorLayers(viewer, region) {
    var defs = (region.layers || []).filter(function (l) { return l.defaultOn; });
    var chain = Promise.resolve();
    defs.forEach(function (def) {
      chain = chain.then(function () {
        var color = Cesium.Color.fromCssColorString(def.color || '#8fd3ff');
        var opts = {
          clampToGround: true,   // 面/线贴地形
          stroke: color.withAlpha(0.9),
          strokeWidth: def.kind === 'line' ? 1.6 : 1.0,
          fill: color.withAlpha(0.32),
          markerColor: color,    // Point 要素默认渲染为地图钉（billboard）
          markerSize: 22,
        };
        return Cesium.GeoJsonDataSource.load(def.url, opts)
          .then(function (ds) {
            styleDataSource(ds, def, color);
            return viewer.dataSources.add(ds).then(function () {
              state.dataSources[def.name] = ds;
            });
          })
          .catch(function (err) {
            console.warn('[scene3d] layer load failed', def.name, err);
          });
      });
    });
    return chain;
  }

  function styleDataSource(ds, def, color) {
    var entities = ds.entities.values;
    for (var i = 0; i < entities.length; i++) {
      var e = entities[i];
      if (e.polygon) {
        e.polygon.classificationType =
          Cesium.ClassificationType.TERRAIN;   // 贴地形分类，随地形起伏
      } else if (e.polyline) {
        e.polyline.clampToGround = true;
      } else if (e.billboard) {
        // 点要素：贴地表（否则无高程的点会沉到地形下面看不见），钉底贴地
        e.billboard.heightReference = Cesium.HeightReference.CLAMP_TO_GROUND;
        e.billboard.verticalOrigin = Cesium.VerticalOrigin.BOTTOM;
        e.billboard.disableDepthTestAgainstTerrain = true;
      } else if (e.point) {
        e.point.heightReference = Cesium.HeightReference.CLAMP_TO_GROUND;
      }
    }
  }

  // ---------------------------------------------------------- 相机预设
  // 关键：目标必须用 Cartesian3 + orientation。若传 Rectangle，Cesium 会强制
  // 正下方俯视（pitch -90 且忽略 orientation），看起来就是一张平面图。
  var CAMERA_PRESETS = {
    himalaya: { lon: 86.9, lat: 28.05, height: 320000, pitch: -45, heading: 20 },
  };

  function flyToRegion(viewer, region) {
    if (!viewer || !region) return;
    var b = region.bbox || [-180, -90, 180, 90];
    var c = region.center || [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
    var cam = region.camera || {};
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(c[0], c[1],
        cam.height || 1200000),
      orientation: {
        heading: Cesium.Math.toRadians(cam.heading || 0),
        pitch: Cesium.Math.toRadians(cam.pitch === undefined ? -40 : cam.pitch),
        roll: 0,
      },
      duration: 2.2,
    });
  }

  function flyToPreset(viewer, preset) {
    if (!viewer || !preset) return;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        preset.lon, preset.lat, preset.height),
      orientation: {
        heading: Cesium.Math.toRadians(preset.heading || 0),
        pitch: Cesium.Math.toRadians(preset.pitch),
        roll: 0,
      },
      duration: 2.5,
    });
  }

  function applyExaggeration(viewer, v) {
    if (!viewer || !v) return;
    try {
      if (viewer.scene.verticalExaggeration !== undefined) {
        viewer.scene.verticalExaggeration = v;
      } else if (viewer.scene.globe.terrainExaggeration !== undefined) {
        viewer.scene.globe.terrainExaggeration = v;   // 旧版本兜底
      }
    } catch (e) {
      console.warn('[scene3d] 地形夸张设置失败', e);
    }
  }

  // 自绘署名条：替代 Cesium 默认 creditContainer（那条 "Cesium ionData attribution"
  // 是引擎内置的云服务默认署名，本项目全自托管、未用 ion 任何数据，故隐藏；
  // 引擎与数据来源在此如实声明）。
  function addCreditLine(container) {
    if (container.querySelector('.scene3d-credit')) return;
    var el = document.createElement('div');
    el.className = 'scene3d-credit';
    el.textContent = '引擎 Cesium 1.146 · 影像 高德卫星（在线） · 地形 项目 DEM（约90m, SRT 源）';
    container.appendChild(el);
  }

  // 只显示研究区（青藏高原）：用"带孔的大平面"遮住区域外的影像，孔 = 研究区边界。
  // 用 classificationType=TERRAIN 贴到球面/地形上（不要用平面多边形：大范围平面
  // 多边形在球面上会被平面投影拉变形、切进球体）。
  function addRegionMask(viewer, region) {
    if (!viewer || !region) return Promise.resolve();
    var url = '/tiles3d/' + region.id + '/vectors/boundary.geojson';
    return fetch(url)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (gj) {
        if (!gj || !gj.features || !gj.features.length) return null;
        var g = gj.features[0].geometry || {};
        var ring = null;
        if (g.type === 'Polygon') {
          ring = g.coordinates[0];
        } else if (g.type === 'MultiPolygon') {
          ring = g.coordinates[0][0];
        }
        if (!ring || ring.length < 3) return null;

        var b = region.bbox;
        var padLon = (b[2] - b[0]) * 0.45;
        var padLat = (b[3] - b[1]) * 0.45;
        var outer = Cesium.Cartesian3.fromDegreesArray([
          b[0] - padLon, b[1] - padLat,
          b[2] + padLon, b[1] - padLat,
          b[2] + padLon, b[3] + padLat,
          b[0] - padLon, b[3] + padLat,
        ]);
        var holePts = [];
        for (var i = 0; i < ring.length; i++) {
          holePts.push(ring[i][0], ring[i][1]);
        }
        var hole = Cesium.Cartesian3.fromDegreesArray(holePts);
        var entity = viewer.entities.add({
          name: 'region-mask',
          show: state.maskVisible !== false,
          polygon: {
            hierarchy: new Cesium.PolygonHierarchy(outer,
              [new Cesium.PolygonHierarchy(hole)]),
            material: Cesium.Color.fromCssColorString('#0a111f').withAlpha(0.97),
            classificationType: Cesium.ClassificationType.TERRAIN,
          },
        });
        state.maskEntity = entity;
        return null;
      })
      .catch(function (e) {
        console.warn('[scene3d] 研究区遮罩创建失败', e);
        return null;
      });
  }

  function removeRegionMask(viewer) {
    if (!viewer) return;
    var list = viewer.entities.values.slice();
    for (var i = 0; i < list.length; i++) {
      if (list[i].name === 'region-mask') viewer.entities.remove(list[i]);
    }
  }

  // 地形自检：直接向 terrainProvider 采样几个已知高程点，把结果打到状态栏。
  // 目的：把"看着像不像三维"变成可读的数字——若采样高度都在 0m 附近，
  // 说明地形瓦片根本没加载（问题在服务/瓦片），而不是相机或渲染效果问题。
  var CHECK_POINTS = [
    { name: '高原中心', lon: 89.0, lat: 32.8, expect: '约4500m' },
    { name: '珠峰附近', lon: 86.9, lat: 28.0, expect: '4000-8000m' },
    { name: '柴达木低地', lon: 94.9, lat: 36.4, expect: '约2800m' },
  ];

  function checkTerrain(viewer) {
    if (!viewer || !viewer.terrainProvider) return Promise.resolve();
    var cartos = CHECK_POINTS.map(function (p) {
      return Cesium.Cartographic.fromDegrees(p.lon, p.lat);
    });
    return Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, cartos)
      .then(function (res) {
        var parts = [];
        var okCount = 0;
        for (var i = 0; i < CHECK_POINTS.length; i++) {
          var c = res && res[i];
          var h = (c && isFinite(c.height)) ? Math.round(c.height) : null;
          if (h !== null && h > 200) okCount++;
          parts.push(CHECK_POINTS[i].name + ' ' + (h === null ? '无' : h + 'm'));
        }
        var msg = '地形自检 ' + BUILD + '：' + parts.join(' · ');
        if (okCount === 0) {
          setStatus(msg + ' —— 地形瓦片未加载（全部≈0m）。' +
            '请确认 /tiles3d/tp_full/terrain/layer.json 能访问、瓦片目录已生成。', true);
        } else {
          setStatus(msg + ' —— 地形已生效（采样到真实高程）。' +
            '若画面仍无起伏，请把这句话原样发我。', false);
        }
        return okCount;
      })
      .catch(function (e) {
        setStatus('地形自检失败 ' + BUILD + '：' +
          (e && e.message ? e.message : e), true);
        return 0;
      });
  }

  // ---------------------------------------------------------- 控件
  function initControls() {
    // 区域下拉（manifest 就绪后填充）
    fetch('/api/3d/regions')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        state.regions = (data && data.regions) || [];
        var sel = $('scene3d-region-select');
        if (!sel) return;
        sel.disabled = state.regions.length === 0;
        sel.innerHTML = '';
        if (state.regions.length === 0) {
          sel.innerHTML = '<option>无可用区域</option>';
          $('scene3d-layer-list').textContent = '未找到三维区域（请先运行 scripts/build_3d_tiles.py）';
          return;
        }
        state.regions.forEach(function (r, i) {
          var opt = document.createElement('option');
          opt.value = r.id;
          opt.textContent = r.name + '（z' + r.minZoom + '–' + r.maxZoom + '）';
          sel.appendChild(opt);
        });
        sel.onchange = function () { switchRegion(sel.value); };
        // 图层开关列表
        renderLayerList(state.regions[0].layers || []);
      })
      .catch(function (err) {
        console.error('[scene3d] manifest fetch failed', err);
        var sel = $('scene3d-region-select');
        if (sel) sel.innerHTML = '<option>加载失败</option>';
      });

    // 影像底图开关
    var on = $('scene3d-imagery-on');
    var off = $('scene3d-imagery-off');
    if (on && off) {
      on.onclick = function () {
        on.classList.add('active'); off.classList.remove('active');
        if (state.imageryLayer) state.imageryLayer.show = true;
      };
      off.onclick = function () {
        off.classList.add('active'); on.classList.remove('active');
        if (state.imageryLayer) state.imageryLayer.show = false;
      };
    }

    // 显示范围开关（遮罩：仅研究区 / 周边也显示）
    var maskOn = $('scene3d-mask-on');
    var maskOff = $('scene3d-mask-off');
    function setMaskVisible(visible) {
      state.maskVisible = visible;
      if (state.viewer) {
        var arr = state.viewer.entities.values;
        for (var i = 0; i < arr.length; i++) {
          if (arr[i].name === 'region-mask') arr[i].show = visible;
        }
      }
      if (maskOn) maskOn.classList.toggle('active', visible);
      if (maskOff) maskOff.classList.toggle('active', !visible);
      if (state.viewer) state.viewer.scene.requestRender();
    }
    if (maskOn) maskOn.onclick = function () { setMaskVisible(true); };
    if (maskOff) maskOff.onclick = function () { setMaskVisible(false); };

    // 相机预设
    var ov = $('scene3d-cam-overview');
    if (ov) ov.onclick = function () { flyToRegion(state.viewer, state.region); };
    var hm = $('scene3d-cam-himalaya');
    if (hm) hm.onclick = function () { flyToPreset(state.viewer, CAMERA_PRESETS.himalaya); };
    var tp = $('scene3d-cam-top');
    if (tp) tp.onclick = function () {
      if (!state.viewer) return;
      var cam = state.viewer.camera;
      var carto = Cesium.Cartographic.fromCartesian(cam.position);
      state.viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(
          Cesium.Math.toDegrees(carto.longitude),
          Cesium.Math.toDegrees(carto.latitude),
          cam.positionCartographic.height),
        orientation: {
          heading: cam.heading,
          pitch: Cesium.Math.toRadians(-90),
          roll: 0,
        },
        duration: 1.5,
      });
    };

    // 地形夸张
    var ex = $('scene3d-exaggeration');
    var exVal = $('scene3d-exaggeration-val');
    if (ex) {
      ex.oninput = function () {
        var v = parseFloat(ex.value) || 1;
        if (exVal) exVal.textContent = v.toFixed(1) + '×';
        applyExaggeration(state.viewer, v);
      };
    }
  }

  function renderLayerList(layers) {
    var box = $('scene3d-layer-list');
    if (!box) return;
    state.layerDefs = layers;
    box.innerHTML = '';
    if (!layers.length) {
      box.textContent = '无叠加图层';
      return;
    }
    layers.forEach(function (l) {
      var row = document.createElement('label');
      row.className = 'scene3d-layer-item';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!l.defaultOn;
      cb.onchange = function () {
        var ds = state.dataSources[l.name];
        if (ds) ds.show = cb.checked;
      };
      var span = document.createElement('span');
      span.textContent = l.title;
      var dot = document.createElement('i');
      dot.className = 'scene3d-layer-dot';
      dot.style.background = l.color || '#8fd3ff';
      row.appendChild(cb);
      row.appendChild(dot);
      row.appendChild(span);
      box.appendChild(row);
    });
  }

  function switchRegion(regionId) {
    var region = null;
    for (var i = 0; i < state.regions.length; i++) {
      if (state.regions[i].id === regionId) region = state.regions[i];
    }
    if (!region || !state.viewer) return;
    setStatus('正在切换区域…');
    // 清空旧数据源
    Object.keys(state.dataSources).forEach(function (k) {
      state.viewer.dataSources.remove(state.dataSources[k], true);
      delete state.dataSources[k];
    });
    Cesium.CesiumTerrainProvider.fromUrl(region.terrain.url, {
      requestVertexNormals: true,
    }).then(function (tp) {
      state.viewer.terrainProvider = tp;
      state.region = region;
      removeRegionMask(state.viewer);
      renderLayerList(region.layers || []);
      return loadVectorLayers(state.viewer, region);
    }).then(function () {
      return addRegionMask(state.viewer, region);
    }).then(function () {
      flyToRegion(state.viewer, region);
      setStatus('已切换至：' + region.name);
    }).catch(function (err) {
      console.error('[scene3d] switch region failed', err);
      setStatus('区域切换失败：' + err.message, true);
    });
  }

  // ---------------------------------------------------------- 对外接口
  window.Scene3D = {
    activate: function () {
      state.active = true;
      // 左侧二维图层面板只控制 OpenLayers 图层，三维视图激活时收起避免困惑
      var panel = document.querySelector('.sidepanel');
      if (panel && !panel.classList.contains('collapsed')) {
        panel.classList.add('collapsed');
        panel.dataset.scene3dAutoCollapsed = '1';
      }
      if (!hasWebGL()) {
        setStatus('当前环境不支持 WebGL，无法渲染三维场景（请更换浏览器或开启硬件加速）。', true);
        return;
      }
      var container = ensureContainer();
      container.style.display = 'block';
      if (state.viewer) {
        state.viewer.useDefaultRenderLoop(true);
        // 按需渲染模式下，从隐藏恢复时要主动触发一次重绘
        try { state.viewer.resize(); state.viewer.scene.requestRender(); } catch (e) { /* ignore */ }
        setStatus('三维场景就绪（' + BUILD + '）。');
        return;
      }
      var region = state.region || (state.regions.length ? state.regions[0] : null);
      if (!region) {
        // manifest 可能尚未加载完成：等 initControls 的 fetch 回来再建
        setStatus('正在加载区域注册表…');
        var timer = setInterval(function () {
          if (state.regions.length) {
            clearInterval(timer);
            buildScene(state.regions[0]);
          }
        }, 300);
        setTimeout(function () { clearInterval(timer); }, 15000);
        return;
      }
      buildScene(region);
    },
    deactivate: function () {
      state.active = false;
      var panel = document.querySelector('.sidepanel');
      if (panel && panel.dataset.scene3dAutoCollapsed === '1') {
        panel.classList.remove('collapsed');
        delete panel.dataset.scene3dAutoCollapsed;
      }
      if (state.container) state.container.style.display = 'none';
      if (state.viewer) {
        try { state.viewer.useDefaultRenderLoop(false); } catch (e) { /* ignore */ }
      }
    },
  };

  // ---------------------------------------------------------- 初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initControls);
  } else {
    initControls();
  }
})();
