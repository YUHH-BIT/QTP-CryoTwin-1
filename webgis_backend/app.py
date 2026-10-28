# -*- coding: utf-8 -*-
import os
import logging
from flask import (Flask, render_template, send_from_directory,
                   request, jsonify, redirect, session, url_for)
from flask_cors import CORS
from config import config
from modules.geocode import geocode_bp
from modules.data_query import query_bp
from modules.basin import basin_bp
from modules.simulate import simulate_bp
from modules.alert import alert_bp
from modules.economy import economy_bp
from modules.disaster import disaster_bp
from modules.snowmelt_flood import snowmelt_flood_bp
from modules.llm import llm_bp
from modules.expert import expert_bp
from modules.decision import decision_bp
from modules.auth import auth_bp
from modules.system import system_bp
from modules.admin import admin_bp
from modules.scene3d import scene3d_bp, tiles3d_bp
from modules import admin_db

# 统一日志配置：模块内仅用 logging.getLogger(__name__)，不重复调用 basicConfig
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s [%(name)s] %(message)s')

# 允许的跨域来源（前端由 Flask 同源服务，此处主要兼容 Vite 开发代理）
ALLOWED_ORIGINS = [
    'http://localhost:3000', 'http://127.0.0.1:3000',
    'http://localhost:5000', 'http://127.0.0.1:5000',
]


def create_app(config_name=None):
    if config_name is None:
        config_name = os.environ.get('FLASK_CONFIG', 'default')

    app = Flask(
        __name__,
        static_folder='../webgis_frontend',   # 前端静态资源目录
        template_folder='../webgis_frontend'
    )
    app.config.from_object(config[config_name])
    config[config_name].ensure_dirs()

    # 初始化系统管理数据库（用户/角色/权限/日志），幂等
    # 内置 3 个角色对应的默认账号（账号密码来自 .env；生产环境请及时修改/清理）
    admin_db.init_admin_db(app.config['BASE_DIR'], default_users=[
        {'username': app.config.get('ADMIN_USERNAME', 'admin'),
         'password': app.config.get('ADMIN_PASSWORD', 'admin123'),
         'display_name': '系统管理员', 'role_code': 'admin'},
        {'username': app.config.get('OPERATOR_USERNAME', 'operator'),
         'password': app.config.get('OPERATOR_PASSWORD', 'operator123'),
         'display_name': '运维人员', 'role_code': 'operator'},
        {'username': app.config.get('VIEWER_USERNAME', 'viewer'),
         'password': app.config.get('VIEWER_PASSWORD', 'viewer123'),
         'display_name': '访客', 'role_code': 'viewer'},
    ])

    # 会话安全配置
    app.secret_key = app.config['SECRET_KEY']
    app.config['SESSION_COOKIE_HTTPONLY'] = True
    app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
    app.config['PERMANENT_SESSION_LIFETIME'] = 60 * 60 * 8  # 8 小时

    # 开发/演示期不缓存模板与静态资源：
    # 非 debug 模式下 Jinja 会把模板缓存在进程内存里，改了 HTML 必须重启进程才生效
    # （2026-10-28 排查"导航栏改了没变"耗了很久，根因就是这个）。
    # 打开自动重载后，改模板/静态文件刷新页面即生效。
    app.config['TEMPLATES_AUTO_RELOAD'] = True
    app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0

    @app.after_request
    def _no_store_html(resp):
        """HTML 一律不缓存：页面结构与导航改动频繁，避免浏览器展示旧页面。"""
        if resp.mimetype in ('text/html', 'application/xhtml+xml'):
            resp.headers['Cache-Control'] = 'no-store, max-age=0'
        return resp

    # 全局路径配置
    app.config['BACKEND_DIR'] = app.config['BASE_DIR']
    app.config['FRONTEND_DIR'] = os.path.join(
        app.config['BASE_DIR'], 'webgis_frontend')

    # CORS：仅允许白名单来源（禁止通配 *)
    CORS(app, resources={"/*": {"origins": ALLOWED_ORIGINS}},
         supports_credentials=True)

    # 注册蓝图
    app.register_blueprint(auth_bp)
    app.register_blueprint(system_bp)
    app.register_blueprint(admin_bp)
    app.register_blueprint(scene3d_bp)
    app.register_blueprint(tiles3d_bp)
    app.register_blueprint(geocode_bp)
    app.register_blueprint(query_bp)
    app.register_blueprint(basin_bp)
    app.register_blueprint(simulate_bp)
    app.register_blueprint(alert_bp)
    app.register_blueprint(economy_bp)
    app.register_blueprint(disaster_bp)
    app.register_blueprint(snowmelt_flood_bp)
    app.register_blueprint(llm_bp)
    app.register_blueprint(expert_bp)
    app.register_blueprint(decision_bp)

    # ---------------- 页面路由 ----------------
    @app.route('/')
    @app.route('/index.html')
    def index_html():
        return render_template("index.html")

    @app.route('/query.html')
    def query_page():
        return render_template('query.html')

    @app.route('/simulate.html')
    def simulate_page():
        return render_template('simulate.html')

    @app.route('/alert.html')
    def alert_page():
        return render_template('alert.html')

    @app.route('/decision.html')
    def decision_page():
        return render_template('decision.html')

    # 三维地形（简易版）：Three.js 单块地形，数据由 scripts/build_terrain_page.py 生成
    @app.route('/terrain3d.html')
    def terrain3d_page():
        return render_template('terrain3d.html')

    @app.route('/terrain3d/<path:filename>')
    def serve_terrain3d_data(filename):
        return send_from_directory(
            os.path.join(app.config['FRONTEND_DIR'], 'terrain3d'), filename)

    @app.route('/login.html')
    def login_page():
        return render_template('login.html')

    # 系统管理页：需要登录，未登录跳转登录页
    @app.route('/admin.html')
    def admin_page():
        if not session.get('user'):
            return redirect(url_for('login_page', return_url='admin.html'))
        return render_template('admin.html')

    # ---------------- 静态文件访问 ----------------
    # 后端运行产物（径流 / 淹没 / 风险栅格等），物理位置：data/webgis/outputs/
    # 历史原因对外 URL 仍沿用 /backend-static/...，前端无需改动。
    @app.route('/backend-static/<path:filename>')
    def serve_backend_static(filename):
        return send_from_directory(
            app.config['OUTPUTS_DIR'], filename)

    @app.route('/backend-static/runoff_results/<path:filename>')
    def serve_runoff_results(filename):
        return send_from_directory(
            app.config['RUNOFF_OUTPUT_DIR'], filename)

    @app.route('/backend-static/flood_inundation/<path:filename>')
    def serve_flood_results(filename):
        return send_from_directory(
            app.config['FLOOD_INUNDATION_DIR'], filename)

    @app.route('/backend-static/risk_results/<path:filename>')
    def serve_risk_results(filename):
        return send_from_directory(
            app.config['RISK_RESULTS_DIR'], filename)

    @app.route('/static/masks/<path:filename>')
    def serve_mask_files(filename):
        return send_from_directory(app.config['MASKS_DIR'], filename)

    @app.route('/static/pngs/<path:filename>')
    def serve_png_files(filename):
        return send_from_directory(app.config['PNGS_DIR'], filename)

    @app.route('/static/animations/<path:filename>')
    def serve_animation_files(filename):
        return send_from_directory(app.config['ANIMATIONS_DIR'], filename)

    # 前端 JS / CSS
    @app.route('/js/<path:filename>')
    def serve_js(filename):
        return send_from_directory(
            os.path.join(app.config['FRONTEND_DIR'], 'js'), filename)

    @app.route('/css/<path:filename>')
    def serve_css(filename):
        return send_from_directory(
            os.path.join(app.config['FRONTEND_DIR'], 'css'), filename)

    # Cesium 引擎静态资源（自托管 Build/Cesium：Workers/Assets/Widgets/ThirdParty）。
    # 前端需设置 window.CESIUM_BASE_URL = '/cesium/'，否则 Worker 等资源 404。
    @app.route('/cesium/<path:filename>')
    def serve_cesium(filename):
        return send_from_directory(
            os.path.join(app.config['FRONTEND_DIR'], 'cesium'), filename)


    # GeoJSON 数据文件（前端地图图层使用；仅允许 .geojson，避免暴露其他原始文件）
    # 注：geo/ 已按语义分层（disaster/boundary/hydrology/...），
    #     filename 需带子目录，如 disaster/PFs_HMA.geojson
    @app.route('/data/raw/geo/<path:filename>')
    def serve_geojson_data(filename):
        if not filename.lower().endswith('.geojson'):
            return jsonify({'success': False, 'message': '只允许访问 GeoJSON 文件'}), 403
        geo_dir = os.path.join(app.config['BASE_DIR'], 'data', 'raw', 'geo')
        return send_from_directory(geo_dir, filename)

    @app.route('/favicon.ico')
    def favicon():
        # 品牌图标（assets/branding/app-icon.ico，与桌面快捷方式同源）；
        # 文件缺失时退化为 204，避免浏览器控制台报错。
        if os.path.isfile(app.config['APP_ICON']):
            return send_from_directory(
                app.config['BRANDING_DIR'], 'app-icon.ico',
                mimetype='image/x-icon')
        return ('', 204)

    # ---------------- 健康检查 ----------------
    @app.route('/api/health')
    def health():
        return jsonify({
            'status': 'ok',
            'service': 'cryo-floods-webgis',
            'time': __import__('time').strftime('%Y-%m-%d %H:%M:%S'),
        })

    # ---------------- 统一错误处理 ----------------
    @app.errorhandler(404)
    def not_found(e):
        if request.path.startswith('/api/'):
            return jsonify({'success': False, 'message': '接口不存在'}), 404
        return ('<h1>404 Not Found</h1><p>页面不存在</p>'), 404

    @app.errorhandler(500)
    def internal_error(e):
        # 避免把内部异常细节暴露给客户端
        return jsonify({'success': False, 'message': '服务器内部错误'}), 500

    return app


app = create_app()

if __name__ == '__main__':
    host = os.environ.get('HOST', '127.0.0.1')
    port = int(os.environ.get('PORT', '5000'))
    app.run(host=host, port=port,
            debug=app.config.get('DEBUG', False),
            threaded=True)