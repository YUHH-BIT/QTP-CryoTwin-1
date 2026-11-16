/**
 * 冰冻圈灾害大模型聊天脚本（原生 JavaScript）
 * ==========================================
 * 职责：绑定 decision.html 中 #llm-chat-history / #llm-input / #llm-send-btn，
 * 通过后端 /api/llm/chat（SSE 流式）与 DeepSeek 对话，流式渲染回复。
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

  function appendMessage(role, text) {
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

  function scrollToBottom() {
    historyEl.scrollTop = historyEl.scrollHeight;
  }

  function setSending(disable) {
    streaming = disable;
    sendBtn.disabled = disable;
    inputEl.disabled = disable;
    sendBtn.querySelector('i').className = disable
      ? 'fa fa-circle-o-notch fa-spin'
      : 'fa fa-paper-plane';
  }

  async function sendMessage() {
    const text = inputEl.value.trim();
    if (!text || streaming) return;

    inputEl.value = '';
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
      }
      scrollToBottom();
    }
  }

  // 事件绑定
  sendBtn.addEventListener('click', function () {
    sendMessage();
  });
  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendMessage();
    }
  });

  // 欢迎语（问候 + 身份定位 + 示例引导 + 能力边界，简明扼要）
  appendMessage(
    'assistant',
    '您好，我是「冰冻圈灾害大模型」，可为您研判青藏高原冰冻圈灾害的机理、风险与防治对策。\n\
'
  );
})();
