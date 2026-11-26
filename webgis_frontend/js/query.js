// 灾害图层管理器
class DisasterLayerManager {
    constructor() {
        this.layers = {};
        this.init();
    }

    init() {
        console.log('灾害图层管理器初始化');
        
        // 在query页面禁用经济数据弹窗功能
        if (window.location.pathname.endsWith('query.html')) {
            this.disableEconomyPopup();
        }
        
        this.setupEventListeners();
    }

    setupEventListeners() {
        // 监听图层复选框变化
        document.addEventListener('change', (e) => {
            if (e.target.classList.contains('layer-checkbox')) {
                this.handleLayerToggle(e.target);
            }
        });
    }

    handleLayerToggle(checkbox) {
        const layerId = checkbox.id.replace('layer-', '').replace(/-/g, '_');
        const isDisasterLayer = checkbox.closest('.category').querySelector('.category-header span i.fa-exclamation-triangle') !== null;
        
        if (!isDisasterLayer) return;

        if (checkbox.checked) {
            this.loadLayer(layerId);
        } else {
            this.removeLayer(layerId);
        }
    }

    async loadLayer(layerId) {
        console.log('加载灾害图层:', layerId);
        
        // 检查地图对象
        if (!window.map) {
            console.error('地图对象未初始化');
            return;
        }

        // 移除现有图层
        if (this.layers[layerId]) {
            window.map.removeLayer(this.layers[layerId]);
        }

        try {
            // 加载GeoJSON数据
            const response = await fetch(`/api/disaster/${layerId}`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            
            const geojsonData = await response.json();
            
            // 创建矢量图层
            const vectorSource = new ol.source.Vector({
                features: new ol.format.GeoJSON().readFeatures(geojsonData, {
                    featureProjection: 'EPSG:3857'
                })
            });

            // 为每个要素添加layerId属性
            vectorSource.getFeatures().forEach(feature => {
                feature.set('layerId', layerId);
            });

            console.log(`加载到 ${vectorSource.getFeatures().length} 个要素`);

            const vectorLayer = new ol.layer.Vector({
                source: vectorSource,
                style: this.getLayerStyle(layerId),
                title: `disaster-${layerId}`,
                zIndex: 100,
                visible: true
            });

            // 添加到地图
            window.map.addLayer(vectorLayer);
            this.layers[layerId] = vectorLayer;
            
            // 添加点击事件处理
            this.addClickInteraction(vectorLayer);
            
            console.log(`图层 ${layerId} 加载成功`);
            
        } catch (error) {
            console.error(`加载图层 ${layerId} 失败:`, error);
            alert(`加载 ${layerId} 图层失败`);
        }
    }

    removeLayer(layerId) {
        console.log('移除灾害图层:', layerId);
        
        if (this.layers[layerId]) {
            window.map.removeLayer(this.layers[layerId]);
            delete this.layers[layerId];
            console.log(`图层 ${layerId} 移除成功`);
        }
    }

    getLayerStyle(layerId) {
        const colors = {
            'snowmelt_floods': [255, 242, 0],     // 亮黄 - 可预测性较高
            'rainfall_floods': [255, 140, 0],     // 橙色 - 常见但危害大
            'glacial_lake_floods': [230, 0, 0],   // 亮红 - 突发性强
            'landslide_dam_floods': [128, 0, 0],   // 暗红 - 复合灾害，最难预测
            'glacier_surging': [0, 191, 255],     // 深海蓝 - 冰川跃动，科研配色
            'rts_qtp': [80, 40, 10],              // 深黑棕色 - 热融滑塌，灾害配色
            'avalanche_hazard': [65, 145, 207],   // 深蓝色 - 雪崩灾害（颜色更深）
            'blizzard_hazard': [120, 160, 190]     // 深蓝灰色 - 风吹雪灾害
        };

        const color = colors[layerId] || [128, 128, 128];
        
        // 创建填充样式
        let fillStyle;
        
        if (layerId === 'avalanche_hazard') {
            // 雪崩灾害 - 斜线填充
            fillStyle = this.createDiagonalLinePattern(color);
        } else if (layerId === 'blizzard_hazard') {
            // 风吹雪灾害 - 点填充
            fillStyle = this.createDotPattern(color);
        } else {
            // 其他灾害 - 普通填充
            fillStyle = new ol.style.Fill({
                color: `rgba(${color[0]}, ${color[1]}, ${color[2]}, 0.3)`
            });
        }
        
        return new ol.style.Style({
            image: new ol.style.Circle({
                radius: 6,
                fill: new ol.style.Fill({
                    color: `rgba(${color[0]}, ${color[1]}, ${color[2]}, 0.8)`
                }),
                stroke: new ol.style.Stroke({
                    color: 'rgb(255, 255, 255)', // 白色轮廓
                    width: 2
                }),
            }),
            stroke: new ol.style.Stroke({
                color: `rgb(${color[0]}, ${color[1]}, ${color[2]})`,
                width: 2
            }),
            fill: fillStyle
        });
    }

    createDiagonalLinePattern(color) {
        // 创建斜线图案
        const canvas = document.createElement('canvas');
        const size = 10;
        canvas.width = size;
        canvas.height = size;
        
        const ctx = canvas.getContext('2d');
        
        // 绘制斜线
        ctx.strokeStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, 0.6)`;
        ctx.lineWidth = 1;
        
        ctx.beginPath();
        ctx.moveTo(0, size);
        ctx.lineTo(size, 0);
        ctx.stroke();
        
        ctx.beginPath();
        ctx.moveTo(-size/2, size/2);
        ctx.lineTo(size/2, -size/2);
        ctx.stroke();
        
        return new ol.style.Fill({
            color: ctx.createPattern(canvas, 'repeat')
        });
    }

    createDotPattern(color) {
        // 创建点图案 - 更密集的点填充
        const canvas = document.createElement('canvas');
        const size = 6; // 减小图案尺寸以增加密度
        canvas.width = size;
        canvas.height = size;
        
        const ctx = canvas.getContext('2d');
        
        // 绘制多个点以增加密度
        ctx.fillStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, 0.6)`;
        
        // 中心点
        ctx.beginPath();
        ctx.arc(size/2, size/2, 1, 0, 2 * Math.PI);
        ctx.fill();
        
        // 四个角落的点
        ctx.beginPath();
        ctx.arc(1, 1, 0.8, 0, 2 * Math.PI);
        ctx.fill();
        
        ctx.beginPath();
        ctx.arc(size-1, 1, 0.8, 0, 2 * Math.PI);
        ctx.fill();
        
        ctx.beginPath();
        ctx.arc(1, size-1, 0.8, 0, 2 * Math.PI);
        ctx.fill();
        
        ctx.beginPath();
        ctx.arc(size-1, size-1, 0.8, 0, 2 * Math.PI);
        ctx.fill();
        
        return new ol.style.Fill({
            color: ctx.createPattern(canvas, 'repeat')
        });
    }

    addClickInteraction(layer) {
        // 创建点击交互
        const selectInteraction = new ol.interaction.Select({
            layers: [layer],
            condition: ol.events.condition.click
        });

        selectInteraction.on('select', (e) => {
            if (e.selected.length > 0) {
                const feature = e.selected[0];
                this.showDisasterPopup(feature);
            }
        });

        window.map.addInteraction(selectInteraction);
    }

    showDisasterPopup(feature) {
        // 获取灾害特征信息
        const properties = feature.getProperties();
        const geometry = feature.getGeometry();
        const coordinates = geometry.getCoordinates();
        const [lng, lat] = ol.proj.toLonLat(coordinates);

        // 构建弹窗内容
        let content = '<div class="disaster-popup">';
        content += '<div class="popup-header">';
        content += '<h3>灾害事件详情</h3>';
        content += '<button class="close-popup" title="关闭">&times;</button>';
        content += '</div>';
        
        // 显示灾害类型
        const layerId = feature.get('layerId') || '未知类型';
        const disasterNames = {
            'rainfall_floods': '降雨型洪水',
            'snowmelt_floods': '融雪型洪水', 
            'glacial_lake_floods': '冰湖溃决型洪水',
            'landslide_dam_floods': '滑坡堰塞湖溃决型洪水',
            'snow_avalanche': '雪崩灾害',
            'blizzard': '暴雪灾害',
            'avalanche_hazard': '雪崩灾害',
            'blizzard_hazard': '风吹雪灾害',
            'snow_cover': '积雪覆盖灾害',
            'glacier_collapse': '冰川崩塌',
            'ice_avalanche': '冰崩灾害',
            'glacier_failure': '冰川垮塌',
            'glacier_surging': '冰川跃动',
            'rts_qtp': '热融滑塌',
            'permafrost_melt': '冻土融化',
            'ground_subsidence': '地面沉降',
            'thermal_melting': '热融灾害',
            'frost_heave': '冻胀灾害'
        };
        
        content += `<p><strong>灾害类型:</strong> ${disasterNames[layerId] || layerId}</p>`;
        
        // 显示其他属性信息 - 中文标签（根据实际数据字段更新）
        const chineseLabels = {
            'FID_': '编号',
            'Country': '国家',
            'Longitude': '经度',
            'Latitude': '纬度',
            'long': '经度',
            'lat': '纬度',            
            'Began_time': '开始时间',
            'Began': '开始时间',
            'F5': '发生地区',
            'F11': '影响地区',
            'F17': '事件来源',            
            'Elevation': '海拔',
            'Time': '发生时间',
            'Ended': '结束时间',
            'Ended_time': '结束时间',
            'Maincause': '主要成因',
            'MainCause': '主要成因',
            'Blocking_days': '阻塞持续时间',
            'Blocking_d': '阻塞持续时间',           
            'Dealth': '死亡人数',
            'Losses': '造成损失',
            'Lake_type': '溃决冰湖类型',
            'Dam_volume': '大坝溃决流量',
            'Displaced': '受影响人数',
            'Lake_name': '溃决冰湖名称',
            'Blocked_river': '被阻塞水系',
            'Affected_a': '影响面积',
            'Crops affected (hm 2 )': '受影响农作物面积',
            'River_Basin': '所属流域',
            'Landslide': '滑坡名称',
            'Rainfall_m': '最大降水量（获取自ERA5-LAND）',
            'Damaged houses': '受影响房屋数量（间）',
            'Volume': '流量',
            'Reference': '事件来源',
            'Regions': '区域',
            'Damaged bridges': '受影响桥梁数量（座）',
            'Affected transport facilities(m)': '受影响交通里程（米）',
            'Injured': '受伤人数',
            'Economic losses (10,000)': '经济损失（万）',
            'Injured Livestock (head)': '受影响牲畜数量（头）',
            // 冰川跃动属性中文标签
            'glacier_surging': '灾害类型',
            'fid_1': '灾害事件编号',
            'Glac_ID': '冰川编号',
            'Area': '冰川面积',
            'Zmin': '冰川最低海拔',
            'Zmax': '冰川最高海拔',
            'Zmed': '冰川中位海拔',
            'Slope': '冰川平均表面坡度',
            'Aspect': '冰川平均坡向/朝向',
            'MaxL': '冰川主流线最大长度',
            'surge_20': '20世纪跃动特征分类',
            'surge_70s': '20世纪70年代跃动特征',
            'Delta_T': '冰川末端推进变化类型',
            'Medial_M': '中央碛形态变化类型',
            'Surge_clas': '跃动分类验证状态',
            'Himap_regi': '地理区域',
            'Shape_Leng': '冰川轮廓长度',
            'Shape_Area': '冰川轮廓面积',
            'HiMAP_region': '地理区域',
            'Surge_class': '跃动分类验证状态',
            // 热融滑塌属性
            'ID': '热融滑塌编号',
            'area': '面积',
            'perimeter': '周长',
            'Type': '类型'
        };
        
        for (const [key, value] of Object.entries(properties)) {
            if (key !== 'geometry' && key !== 'layerId' && key !== 'OBJECTID_1' && key !== 'OBJECTID' && key !== 'ID' && key !== 'F13' && value) {
                const label = chineseLabels[key] || key;
                content += `<p><strong>${label}:</strong> ${value}</p>`;
            }
        }
        
        // 只有在坐标有效的情况下才显示坐标信息
        if (!isNaN(lng) && !isNaN(lat) && isFinite(lng) && isFinite(lat)) {
            content += `<p><strong>坐标:</strong> ${lng.toFixed(4)}, ${lat.toFixed(4)}</p>`;
        }
        
        // 添加灾害影响区域控制
        content += '<div class="disaster-buffer-controls">';
        content += '<h4>灾害影响区域</h4>';
        content += '<div class="buffer-buttons">';
        content += '<button class="buffer-btn" data-radius="5">5公里</button>';
        content += '<button class="buffer-btn" data-radius="10">10公里</button>';
        content += '<button class="buffer-btn" data-radius="15">15公里</button>';
        content += '<button class="buffer-btn" data-radius="20">20公里</button>';
        content += '<button class="buffer-btn-clear">清除</button>';
        content += '</div>';
        content += '</div>';
        content += '</div>';

        // 显示弹窗
        this.showPopup(coordinates, content);
        
        // 存储当前要素以便在缓冲区操作中使用
        this.currentFeature = feature;
        
        // 添加影响区域按钮事件监听
        this.addBufferControlsEventListeners(feature, coordinates);
    }

    showPopup(coordinates, content) {
        // 移除现有弹窗
        if (this.popup) {
            window.map.removeOverlay(this.popup);
        }

        // 创建弹窗元素
        const popupElement = document.createElement('div');
        popupElement.className = 'disaster-popup-container';
        popupElement.innerHTML = content;

        // 创建弹窗覆盖层 - 位置设置为屏幕中央
        this.popup = new ol.Overlay({
            element: popupElement,
            positioning: 'center-center',  // 居中定位
            stopEvent: true,  // 阻止事件传播
            autoPan: true,
            autoPanAnimation: {
                duration: 250
            }
        });

        window.map.addOverlay(this.popup);
        
        // 设置弹窗位置为地图视图中心
        const viewCenter = window.map.getView().getCenter();
        this.popup.setPosition(viewCenter);

        // 添加关闭按钮事件
        const closeBtn = popupElement.querySelector('.close-popup');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                // 修改：只关闭弹窗，不清除缓冲区
                this.closePopupWithoutClearingBuffer();
            });
        }

        // 点击地图其他地方关闭弹窗
        window.map.once('click', () => {
            // 修改：只关闭弹窗，不清除缓冲区
            this.closePopupWithoutClearingBuffer();
        });
        
        // 在弹窗完全渲染后，立即添加事件监听器
        setTimeout(() => {
            this.bindBufferControlEvents(popupElement, coordinates);
        }, 50);
    }

    bindBufferControlEvents(popupElement, coordinates) {
        console.log('Setting up buffer control events');
        
        // 为弹窗元素添加事件监听器
        popupElement.addEventListener('click', (e) => {
            if (e.target.classList.contains('buffer-btn')) {
                console.log('Buffer button clicked:', e.target);
                const radius = parseInt(e.target.getAttribute('data-radius'));
                console.log('Radius to draw:', radius);
                
                // 获取当前要素的原始几何形状
                let originalGeometry;
                if (this.currentFeature) {
                    originalGeometry = this.currentFeature.getGeometry();
                }
                
                if (originalGeometry) {
                    // 使用原始几何形状进行缓冲区操作
                    const originalCoordinates = originalGeometry.getCoordinates();
                    console.log('Using original geometry for buffer:', originalCoordinates);
                    this.drawDisasterBuffer(originalCoordinates, radius);
                } else {
                    // 如果没有可用的几何形状，回退到中心点方法
                    let centerCoord;
                    
                    // 计算几何图形的中心点
                    function calculateCentroid(coords) {
                        if (!Array.isArray(coords)) {
                            return null;
                        }
                        
                        // 如果已经是 [x, y] 格式
                        if (coords.length === 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
                            return coords;
                        }
                        
                        // 递归查找所有坐标点
                        function findAllCoordinates(arr) {
                            const points = [];
                            
                            function traverse(current) {
                                if (!Array.isArray(current)) {
                                    return;
                                }
                                
                                if (current.length === 2 && typeof current[0] === 'number' && typeof current[1] === 'number') {
                                    points.push(current);
                                    return;
                                }
                                
                                for (const item of current) {
                                    if (Array.isArray(item)) {
                                        traverse(item);
                                    }
                                }
                            }
                            
                            traverse(arr);
                            return points;
                        }
                        
                        const allPoints = findAllCoordinates(coords);
                        
                        if (allPoints.length === 0) {
                            return null;
                        }
                        
                        // 计算所有点的平均值作为中心点
                        let sumX = 0;
                        let sumY = 0;
                        
                        for (const point of allPoints) {
                            sumX += point[0];
                            sumY += point[1];
                        }
                        
                        return [sumX / allPoints.length, sumY / allPoints.length];
                    }
                    
                    centerCoord = calculateCentroid(coordinates);
                    
                    if (centerCoord) {
                        console.log('Calculated centroid coordinates:', centerCoord);
                    } else {
                        console.error('Could not calculate centroid from coordinates:', coordinates);
                        return;
                    }
                    
                    console.log('Using center coordinates:', centerCoord);
                    this.drawDisasterBuffer(centerCoord, radius);
                }
            } else if (e.target.classList.contains('buffer-btn-clear')) {
                console.log('Clear button clicked');
                this.clearDisasterBuffers();
            }
        });
    }

    drawDisasterBuffer(originalCoords, radiusKm) {
        console.log('drawDisasterBuffer called with:', originalCoords, radiusKm);
        
        // 清除现有的缓冲区图层
        this.clearDisasterBuffers();
        
        // 创建缓冲区矢量源
        this.bufferSource = new ol.source.Vector();
        
        // 生成基于原始几何形状的缓冲区
        const bufferedGeometry = this.createBufferFromOriginalGeometry(originalCoords, radiusKm);
        console.log('Buffered geometry created:', bufferedGeometry);
        
        if (!bufferedGeometry) {
            console.error('Failed to create buffered geometry');
            return;
        }
        
        // 创建特征
        const bufferFeature = new ol.Feature({
            geometry: bufferedGeometry
        });
        
        // 设置样式
        const color = [128, 0, 0, 0.3]; // 红褐色，透明度0.3
        
        bufferFeature.setStyle(new ol.style.Style({
            fill: new ol.style.Fill({
                color: `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${color[3]})`
            }),
            stroke: new ol.style.Stroke({
                color: `rgba(${color[0]}, ${color[1]}, ${color[2]}, 1.0)`,
                width: 3  // 增加边框宽度使缓冲区更明显
            })
        }));
        
        // 添加到源
        this.bufferSource.addFeature(bufferFeature);
        console.log('Feature added to source');
        
        // 创建缓冲区图层
        this.bufferLayer = new ol.layer.Vector({
            source: this.bufferSource,
            zIndex: 200
        });
        console.log('Buffer layer created');
        
        window.map.addLayer(this.bufferLayer);
        console.log('Buffer layer added to map');
        
        // 确保地图视图更新
        window.map.render();
    }
    
    createBufferFromOriginalGeometry(originalCoords, radiusKm) {
        // 从原始坐标创建几何对象
        const originalGeometry = this.coordsToGeometry(originalCoords);
        if (!originalGeometry) {
            console.error('Could not convert coordinates to geometry');
            // 如果无法转换，回退到中心点方法
            return this.createCircularBufferFromCentroid(originalCoords, radiusKm);
        }
        
        // 将半径从公里转换为米
        const radiusMeters = radiusKm * 1000;
        
        // 使用Turf.js库来进行缓冲区操作（如果可用）
        if (typeof turf !== 'undefined') {
            try {
                // 将OpenLayers几何转换为GeoJSON
                const geoJsonFormat = new ol.format.GeoJSON();
                const feature = new ol.Feature({
                    geometry: originalGeometry
                });
                const geoJson = geoJsonFormat.writeFeatureObject(feature);
                
                // 使用Turf.js创建缓冲区
                const buffered = turf.buffer(geoJson, radiusMeters / 1000, { units: 'kilometers' });
                
                // 将结果转换回OpenLayers几何
                const bufferedFeature = geoJsonFormat.readFeature(buffered);
                return bufferedFeature.getGeometry();
            } catch (e) {
                console.warn('Turf.js buffering failed, falling back to manual method:', e);
            }
        }
        
        // 如果Turf.js不可用或失败，使用手动方法
        return this.createManualBuffer(originalGeometry, radiusMeters);
    }
    
    // 辅助函数：将坐标数组转换为几何对象
    coordsToGeometry(coords) {
        if (!Array.isArray(coords)) {
            return null;
        }
        
        // 如果是 [x, y] 格式的点
        if (coords.length === 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
            return new ol.geom.Point(coords);
        }
        
        // 递归查找坐标点并构建几何对象
        function findAndBuildGeometry(data) {
            if (!Array.isArray(data)) {
                return null;
            }
            
            // 查找所有坐标点
            function extractPoints(arr) {
                const points = [];
                
                function traverse(current) {
                    if (!Array.isArray(current)) {
                        return;
                    }
                    
                    if (current.length === 2 && typeof current[0] === 'number' && typeof current[1] === 'number') {
                        points.push(current);
                        return;
                    }
                    
                    for (const item of current) {
                        if (Array.isArray(item)) {
                            traverse(item);
                        }
                    }
                }
                
                traverse(arr);
                return points;
            }
            
            const allPoints = extractPoints(data);
            
            if (allPoints.length === 0) {
                return null;
            } else if (allPoints.length === 1) {
                // 单个点
                return new ol.geom.Point(allPoints[0]);
            } else if (allPoints.length === 2) {
                // 线段
                return new ol.geom.LineString(allPoints);
            } else if (allPoints.length >= 3) {
                // 多边形（假设最后一点连接到第一点）
                return new ol.geom.Polygon([allPoints.concat([allPoints[0]])]);
            }
            
            return null;
        }
        
        return findAndBuildGeometry(coords);
    }
    
    // 手动创建缓冲区的方法
    createManualBuffer(geometry, radiusMeters) {
        // 对于点几何，创建圆形缓冲区
        if (geometry instanceof ol.geom.Point) {
            const center = geometry.getCoordinates();
            return this.createCircularBuffer(center, radiusMeters / 1000);
        }
        
        // 对于其他几何类型，我们使用原始几何的边界来确定缓冲区大小
        // 获取原始几何的边界框
        const extent = geometry.getExtent();
        const centerX = ol.extent.getCenter(extent)[0];
        const centerY = ol.extent.getCenter(extent)[1];
        
        // 计算原始几何的对角线长度的一半（相当于原始区域的"半径"）
        const originalWidth = ol.extent.getWidth(extent) / 2;
        const originalHeight = ol.extent.getHeight(extent) / 2;
        // 使用较大的维度作为原始"半径"
        const originalRadius = Math.max(originalWidth, originalHeight);
        
        // 创建一个更大半径的圆形缓冲区，以包含原始几何并扩展指定距离
        const totalRadiusKm = (originalRadius + radiusMeters) / 1000;
        
        // 创建以几何中心为圆心的圆形缓冲区
        return this.createCircularBuffer([centerX, centerY], totalRadiusKm);
    }
    
    // 从质心创建圆形缓冲区的辅助方法
    createCircularBufferFromCentroid(coords, radiusKm) {
        // 计算几何中心
        const center = this.calculateCentroidForBuffer(coords);
        if (!center) {
            console.error('Could not calculate centroid for buffer');
            return null;
        }
        
        return this.createCircularBuffer(center, radiusKm);
    }
    
    // 用于缓冲区计算的质心算法
    calculateCentroidForBuffer(coords) {
        if (!Array.isArray(coords)) {
            return null;
        }
        
        if (coords.length === 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
            return coords;
        }
        
        // 递归查找所有坐标点
        function findAllCoordinates(arr) {
            const points = [];
            
            function traverse(current) {
                if (!Array.isArray(current)) {
                    return;
                }
                
                if (current.length === 2 && typeof current[0] === 'number' && typeof current[1] === 'number') {
                    points.push(current);
                    return;
                }
                
                for (const item of current) {
                    if (Array.isArray(item)) {
                        traverse(item);
                    }
                }
            }
            
            traverse(arr);
            return points;
        }
        
        const allPoints = findAllCoordinates(coords);
        
        if (allPoints.length === 0) {
            return null;
        }
        
        let sumX = 0;
        let sumY = 0;
        
        for (const point of allPoints) {
            sumX += point[0];
            sumY += point[1];
        }
        
        return [sumX / allPoints.length, sumY / allPoints.length];
    }
    
    createCircularBuffer(centerXY, radiusKm) {
        // 创建圆形缓冲区，使用更精确的方法
        const radiusMeters = radiusKm * 1000; // 半径单位为米
        
        // 使用几何计算方法创建圆形多边形
        const center = centerXY; // 使用输入的坐标作为中心点
        const numPoints = 64; // 圆形精度
        const circlePoints = [];
        
        for (let i = 0; i < numPoints; i++) {
            const angle = (i / numPoints) * 2 * Math.PI;
            // 使用球面计算来获得更精确的缓冲区
            const dx = radiusMeters * Math.cos(angle);
            const dy = radiusMeters * Math.sin(angle);
            
            // 在 EPSG:3857 坐标系中直接计算新坐标
            const newX = center[0] + dx;
            const newY = center[1] + dy;
            
            circlePoints.push([newX, newY]);
        }
        
        // 确保多边形闭合
        circlePoints.push(circlePoints[0]);
        
        // 创建多边形几何体
        const polygon = new ol.geom.Polygon([circlePoints]);
        
        return polygon;
    }

    clearDisasterBuffers() {
        if (this.bufferSource) {
            this.bufferSource.clear();
        }
        if (this.bufferLayer) {
            window.map.removeLayer(this.bufferLayer);
            this.bufferLayer = null;
        }
    }

    closePopup() {
        // 关闭弹窗时也清除缓冲区
        this.clearDisasterBuffers();
        
        if (this.popup) {
            window.map.removeOverlay(this.popup);
            this.popup = null;
        }
    }
    
    closePopupWithoutClearingBuffer() {
        // 关闭弹窗但不清除缓冲区
        if (this.popup) {
            window.map.removeOverlay(this.popup);
            this.popup = null;
        }
    }

    disableEconomyPopup() {
        // 移除经济数据弹窗交互
        if (window.map) {
            const interactions = window.map.getInteractions().getArray();
            for (let i = interactions.length - 1; i >= 0; i--) {
                const interaction = interactions[i];
                if (interaction instanceof ol.interaction.Select) {
                    // 检查是否是经济数据弹窗交互
                    const listeners = interaction.getListeners('select');
                    if (listeners && listeners.length > 0) {
                        window.map.removeInteraction(interaction);
                    }
                }
            }
        }
    }
}

// 灾害侧边栏管理器
class DisasterSidebarManager {
    constructor() {
        this.sidebar = null;
        this.isOpen = false;
        this.currentCategory = null;
        this.categoryNames = {
            'flood': '洪水灾害数据库',
            'snow': '积雪灾害数据库',
            'ice': '冰川灾害数据库',
            'permafrost': '冻土灾害数据库'
        };
        this.dropdown = null;
        this.toggle = null;
        this.init();
    }

    init() {
        this.sidebar = document.getElementById('disaster-sidebar');
        this.dropdown = document.getElementById('disaster-dropdown');
        this.toggle = document.querySelector('.dropdown-toggle[data-page="query"]');
        
        if (!this.sidebar || !this.dropdown) return;

        this.setupSidebarInteractions();
        this.registerNavCategoryHandler();
    }

    // 注册导航栏下拉项点击处理（由 main.js 统一导航调用）
    registerNavCategoryHandler() {
        window.applyNavCategory = (category) => {
            // 高亮对应的下拉菜单项
            document.querySelectorAll('#disaster-dropdown .dropdown-item').forEach(i => {
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
        const closeBtn = document.getElementById('disaster-sidebar-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.hideSidebar());
        }

        // 侧边栏遮罩（点击关闭）
        this.mask = document.getElementById('disaster-sidebar-mask');
        if (this.mask) {
            this.mask.addEventListener('click', () => this.hideSidebar());
        }

        // Esc 关闭
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.sidebar.classList.contains('active')) {
                this.hideSidebar();
            }
        });

        // 侧边栏内复选框事件处理
        const checkboxes = document.querySelectorAll('.disaster-layer-checkbox-sidebar');
        checkboxes.forEach(checkbox => {
            checkbox.addEventListener('change', (e) => {
                this.handleSidebarLayerToggle(e.target);
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
        const titleElement = document.getElementById('disaster-sidebar-title');
        if (titleElement) {
            // 根据类别显示不同的标题
            const categoryName = this.categoryNames[this.currentCategory] || '';
            titleElement.textContent = categoryName || '灾害数据库';
        }

        // 隐藏所有灾害分类
        const allCategories = document.querySelectorAll('.disaster-category-sidebar');
        allCategories.forEach(cat => {
            cat.style.display = 'none';
        });

        // 显示选中的灾害分类
        const selectedCategory = document.getElementById(`${this.currentCategory}-category-sidebar`);
        if (selectedCategory) {
            selectedCategory.style.display = 'block';
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
        // 同步现有图层勾选状态到侧边栏 - 支持所有灾害类型
        const layerTypes = [
            'rainfall-floods', 'snowmelt-floods', 'glacial-lake-floods', 'landslide-dam-floods',
            'snow-avalanche', 'blizzard', 'snow-cover',
            'glacier-collapse', 'ice-avalanche', 'glacier-failure', 'glacier-surging',
            'permafrost-melt', 'ground-subsidence', 'thermal-melting', 'frost-heave', 'rts-qtp'
        ];
        
        layerTypes.forEach(layerType => {
            const sidebarCheckbox = document.getElementById(`sidebar-layer-${layerType}`);
            
            if (sidebarCheckbox) {
                // 检查图层是否已加载
                const layerId = layerType.replace(/-/g, '_');
                const isLayerLoaded = window.disasterLayerManager.layers[layerId] !== undefined;
                sidebarCheckbox.checked = isLayerLoaded;
            }
        });
    }

    handleSidebarLayerToggle(checkbox) {
        const layerId = checkbox.id.replace('sidebar-layer-', '').replace(/-/g, '_');

        if (checkbox.checked) {
            // 芯片显示加载转圈，请求完成后移除
            const item = checkbox.closest('.disaster-layer-item-sidebar');
            if (item) item.classList.add('loading');
            Promise.resolve(window.disasterLayerManager.loadLayer(layerId)).finally(() => {
                if (item) item.classList.remove('loading');
            });
        } else {
            window.disasterLayerManager.removeLayer(layerId);
        }
    }
}

// 初始化灾害图层管理器
window.disasterLayerManager = new DisasterLayerManager();

// 初始化灾害侧边栏管理器
window.disasterSidebarManager = new DisasterSidebarManager();

// 查询页面专用功能
document.addEventListener('DOMContentLoaded', function() {
    // 检查是否为查询页面
    if (!window.location.pathname.endsWith('query.html')) {
        return;
    }

    // 初始化折叠面板
    const categoryHeaders = document.querySelectorAll('.category-header');
    categoryHeaders.forEach(header => {
        header.addEventListener('click', function() {
            const category = this.parentElement;
            const content = category.querySelector('.category-content');
            const icon = this.querySelector('.toggle-icon');
            
            if (content.classList.contains('expanded')) {
                content.classList.remove('expanded');
                icon.classList.remove('fa-chevron-up');
                icon.classList.add('fa-chevron-down');
            } else {
                content.classList.add('expanded');
                icon.classList.remove('fa-chevron-down');
                icon.classList.add('fa-chevron-up');
            }
        });
    });
});

