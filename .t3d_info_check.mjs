async function main() {
  const targets = await fetch('http://127.0.0.1:9223/json/list').then(r => r.json());
  let t = targets.find(x => x.type === 'page' && x.url.includes('terrain3d'));
  if (!t) t = targets.find(x => x.type === 'page');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  const id = { n: 0 };
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id.n;
    ws.addEventListener('message', function h(e) {
      const m = JSON.parse(e.data);
      if (m.id === i) { ws.removeEventListener('message', h); res(m); }
    });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  await new Promise(r => ws.addEventListener('open', r));
  const errors = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown')
      errors.push('EXCEPTION: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
      errors.push('CONSOLE.error: ' + m.params.args.map(a => a.value || a.description).join(' '));
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:5000/terrain3d.html' });
  await new Promise(r => setTimeout(r, 16000));
  const probe = await send('Runtime.evaluate', {
    expression: `(() => {
      const q = s => document.querySelector(s);
      return {
        infoName: q('#info .basin-name') ? q('#info .basin-name').innerText : null,
        infoMeta: q('#info .basin-meta') ? q('#info .basin-meta').innerText : null,
        legendTitle: q('#legend .lg-title') ? q('#legend .lg-title').innerText : null,
        legendRows: q('#legend') ? q('#legend').querySelectorAll('.lg-row').length : 0,
        hasHint: !!Array.from(q('#legend') ? q('#legend').querySelectorAll('.lg-row') : []).find(r => r.innerText.includes('点击')),
        errors: window.__t3d || 'pending',
      };
    })()`,
    returnByValue: true,
  });
  console.log('ERRORS:', errors.length ? errors : 'none');
  console.log('PROBE:', JSON.stringify(probe.result.result.value, null, 2));
  ws.close();
}
main().catch(e => { console.error(e); process.exit(1); });
