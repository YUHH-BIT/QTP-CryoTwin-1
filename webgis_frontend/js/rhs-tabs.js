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
    // 面板宽度 → 展开时标签的 right 偏移，以及收起时面板的 off-screen 距离
    document.body.style.setProperty('--rhs-panel-w', Math.round(rect.width) + 'px');
    // 标签对齐面板垂直中点（标签高 104px，上移 52px）
    tab.style.top = Math.round(rect.top + rect.height / 2 + window.pageYOffset) + 'px';
    tab.style.marginTop = '-52px';
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
