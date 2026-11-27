/**
 * 冰冻圈灾害大模型聊天脚本（原生 JavaScript）
 * ==========================================
 * 职责：绑定 decision.html 中 #llm-chat-history / #llm-input / #llm-send-btn，
 * 通过后端 /api/llm/chat（SSE 流式）与 DeepSeek 对话，流式渲染回复。
 *
 * 2026-11-27 18:29 交互升级：
 * - 输入框改 textarea：Enter 发送 / Shift+Enter 换行，随内容自动增高（上限 96px）
 * - 空态（欢迎语 + 快捷提问）改为静态 HTML，首条消息后隐藏，新对话时恢复
 * - 新增「回到底部」浮动按钮（滚动离底 40px 以上出现）
 * - 新增「开始新对话」按钮（清空会话历史，重置空态）
 *
 * 约定：
 * - 全程原生 JS，不依赖 jQuery；
 * - 错误提示统一使用 UI.toast（无则降级 alert）；
 * - 聊天消息以 textContent 渲染，避免 XSS。
 */
(function () {
  'use strict';

  // 仅当决策页存在聊天框元素时才初始化
  const historyEl = document.getElementById('llm-chat-history');
  const inputEl = document.getElementById('llm-input');
  const sendBtn = document.getElementById('llm-send-btn');
  if (!historyEl || !inputEl || !sendBtn) return;

  const emptyEl = document.getElementById('llm-empty');
  const clearBtn = document.getElementById('llm-clear-btn');
  const scrollBtn = document.getElementById('llm-scroll-bottom');

  // 会话消息历史（不含 system，system 由后端注入）
  const messages = [];
  let streaming = false;

  function uiMsg(message, type) {
    if (window.UI && UI.toast) {
      UI.toast(message, type || 'warning');
    } else {
      window.alert(message);
    }
  }

  /** 空态显隐：首条消息发出后隐藏欢迎语与快捷提问 */
  function showEmpty(show) {
    if (emptyEl) emptyEl.style.display = show ? '' : 'none';
  }

  /** textarea 随内容增高，超过 96px 后内部滚动 */
  function autoGrow() {
    if (!inputEl || inputEl.tagName !== 'TEXTAREA') return;
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 96) + 'px';
  }

  function appendMessage(role, text) {
    showEmpty(false);
    const wrap = document.createElement('div');
    wrap.className = 'llm-msg';
    if (role === 'user') {
      wrap.classList.add('llm-msg-user');
    } else {
      wrap.classList.add('llm-msg-assistant');
    }
    const avatar = document.createElement('div');
    avatar.className = 'llm-msg-avatar';
    avatar.innerHTML = role === 'user'
      ? '<i class="fa fa-user-o"></i>'
      : '<i class="fa fa-microchip"></i>';
    const main = document.createElement('div');
    main.className = 'llm-msg-main';
    const label = document.createElement('div');
    label.className = 'llm-msg-role';
    label.textContent = role === 'user' ? '我' : '大模型';
    const body = document.createElement('div');
    body.className = 'llm-msg-body';
    body.textContent = text || '';
    main.appendChild(label);
    main.appendChild(body);
    wrap.appendChild(avatar);
    wrap.appendChild(main);
    historyEl.appendChild(wrap);
    scrollToBottom();
    return body;
  }

  function appendTyping() {
    showEmpty(false);
    const wrap = document.createElement('div');
    wrap.className = 'llm-msg llm-msg-assistant llm-msg-typing';
    const avatar = document.createElement('div');
    avatar.className = 'llm-msg-avatar';
    avatar.innerHTML = '<i class="fa fa-microchip"></i>';
    const main = document.createElement('div');
    main.className = 'llm-msg-main';
    const label = document.createElement('div');
    label.className = 'llm-msg-role';
    label.textContent = '冰冻圈灾害大模型';
    const body = document.createElement('div');
    body.className = 'llm-msg-body';
    body.textContent = '正在思考';
    // 横排三点加载动画
    const dots = document.createElement('span');
    dots.className = 'llm-typing-dots';
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement('span');
      dot.className = 'llm-typing-dot';
      dots.appendChild(dot);
    }
    body.appendChild(dots);
    main.appendChild(label);
    main.appendChild(body);
    wrap.appendChild(avatar);
    wrap.appendChild(main);
    historyEl.appendChild(wrap);
    scrollToBottom();
    return wrap;
  }

  function scrollToBottom(smooth) {
    if (smooth && historyEl.scrollTo) {
      historyEl.scrollTo({ top: historyEl.scrollHeight, behavior: 'smooth' });
    } else {
      historyEl.scrollTop = historyEl.scrollHeight;
    }
  }

  function setSending(disable) {
    streaming = disable;
    sendBtn.disabled = disable;
    inputEl.disabled = disable;
    const icon = sendBtn.querySelector('i');
    if (icon) {
      icon.className = disable ? 'fa fa-circle-o-notch fa-spin' : 'fa fa-paper-plane';
    }
  }

  async function sendMessage() {
    const text = inputEl.value.trim();
    if (!text || streaming) return;

    inputEl.value = '';
    autoGrow();
    messages.push({ role: 'user', content: text });
    appendMessage('user', text);

    const typingWrap = appendTyping();
    setSending(true);
    // 保留"正在思考 + 横排三点"动画；首个内容 chunk 到达后再替换
    const replyBody = typingWrap.querySelector('.llm-msg-body');
    let replyStarted = false;

    let fullReply = '';
    try {
      const resp = await fetch('/api/llm/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: messages })
      });

      if (!resp.ok) {
        let msg = `请求失败（${resp.status}）`;
        try {
          const err = await resp.json();
          if (err.message) msg = err.message;
        } catch (e) { /* ignore */ }
        throw new Error(msg);
      }
      if (!resp.body) {
        throw new Error('当前浏览器不支持流式响应');
      }

      // 解析 SSE 流
      const reader = resp.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let errored = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // 按行切分，保留最后一个不完整行
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const obj = JSON.parse(data);
            if (obj.error) {
              errored = true;
              throw new Error(obj.error);
            }
            if (obj.content) {
              if (!replyStarted) {
                // 首个内容 chunk：移除"正在思考"加载占位，开始写入真实回复
                replyStarted = true;
                replyBody.innerHTML = '';
              }
              fullReply += obj.content;
              replyBody.textContent = fullReply;
              scrollToBottom();
            }
          } catch (e) {
            if (!(e instanceof SyntaxError)) {
              errored = true;
              throw e;
            }
          }
        }
      }

      if (!errored && !fullReply) {
        throw new Error('大模型未返回有效内容');
      }
    } catch (e) {
      console.error('[冰冻圈灾害大模型] 请求失败:', e);
      replyBody.textContent = '';
      uiMsg('对话失败：' + (e && e.message ? e.message : e), 'error');
    } finally {
      setSending(false);
      // 保留已收到的内容；若有内容则记录到历史，否则移除占位气泡
      if (fullReply) {
        messages.push({ role: 'assistant', content: fullReply });
        typingWrap.classList.remove('llm-msg-typing');
      } else {
        typingWrap.remove();
        // 一条都没发出去时恢复空态
        if (!historyEl.querySelector('.llm-msg')) showEmpty(true);
      }
      scrollToBottom();
    }
  }

  // ---- 事件绑定 ----
  sendBtn.addEventListener('click', function () {
    sendMessage();
  });

  inputEl.addEventListener('input', autoGrow);
  inputEl.addEventListener('keydown', function (e) {
    // Enter 发送；Shift+Enter 换行；输入法组合中不拦截
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });

  // 快捷提问：填入问题并直接发送
  document.querySelectorAll('.llm-suggest-chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      if (streaming) return;
      const q = chip.getAttribute('data-q') || chip.textContent.trim();
      inputEl.value = q;
      autoGrow();
      sendMessage();
    });
  });

  // 回到底部：离底超过 40px 时显示
  if (scrollBtn) {
    historyEl.addEventListener('scroll', function () {
      const gap = historyEl.scrollHeight - historyEl.scrollTop - historyEl.clientHeight;
      scrollBtn.classList.toggle('show', gap > 40);
    });
    scrollBtn.addEventListener('click', function () {
      scrollToBottom(true);
    });
  }

  // 开始新对话
  if (clearBtn) {
    clearBtn.addEventListener('click', function () {
      if (streaming) return;
      messages.length = 0;
      historyEl.querySelectorAll('.llm-msg').forEach(function (n) { n.remove(); });
      showEmpty(true);
      inputEl.value = '';
      autoGrow();
      if (scrollBtn) scrollBtn.classList.remove('show');
      inputEl.focus();
    });
  }

  // 初始：空态由 HTML 静态渲染，不再在 JS 里补欢迎语
  autoGrow();
})();
