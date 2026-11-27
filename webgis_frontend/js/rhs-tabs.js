/* 右侧栏边缘竖标签（2026-11-27）
   与孪生示范页一致：点一下收起 / 展开右侧栏，不遮地图、不弹模态遮罩。
   右侧抽屉宽高都随内容自适应，这里负责把标签移到面板垂直中点，
   并把面板真实宽度同步给 --rhs-panel-w（展开时标签贴边用）。
   原导航的类别切换 / 业务事件全部不动。 */
(function () {
  'use strict';
  var tab = document.querySelector('.rhs-tab');
  if (!tab) return;
  var panel = document.querySelector('.disaster-sidebar, .simulate-sidebar, .alert-sidebar, .decision-sidebar');
  var mask = document.querySelector('.disaster-sidebar-mask, .simulate-sidebar-mask, .alert-sidebar-mask, .decision-sidebar-mask');
  if (!panel) return;

  function measure() {
    var rect = panel.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    // 面板宽度 → 收起时面板的 off-screen 距离等
    document.body.style.setProperty('--rhs-panel-w', Math.round(rect.width) + 'px');
    // 竖标签位置由 CSS 固定为「视口右缘正中」（position:fixed + top:50% + translateY(-50%)），
    // 不再跟随面板中点——原先按面板算会比屏幕中心偏下约 30px（2026-11-27 21:19）。
    tab.style.top = '';
    tab.style.marginTop = '';
  }

  function sync() {
    var open = panel.classList.contains('active');
    tab.setAttribute('aria-expanded', open ? 'true' : 'false');
    tab.title = open ? '收起右侧栏' : '展开右侧栏';
    measure();
  }

  tab.addEventListener('click', function () {
    var open = panel.classList.toggle('active');
    if (mask) mask.classList.toggle('active', open);
    sync();
  });

  // 顶部导航打开 / 关闭、关闭按钮、Esc 都会改 .active，标签状态跟着走
  if (window.MutationObserver) {
    new MutationObserver(sync).observe(panel, { attributes: true, attributeFilter: ['class'] });
  }
  // 面板内容变化导致高度/宽度变化时，标签继续贴中点
  if (window.ResizeObserver) {
    new ResizeObserver(measure).observe(panel);
  }
  window.addEventListener('resize', measure);
  sync();
})();
