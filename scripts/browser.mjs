// A small driver for checking the app in a real browser, with no dependencies: it starts the installed
// Google Chrome headless (software rendering) and talks to it over the DevTools protocol.
// Used by scripts/check-*.mjs. Screenshots go to the folder given in OUT (default: ./.checks, ignored by git).
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const OUT = process.env.OUT ?? '.checks';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function openBrowser({ width = 1288, height = 672, mobile = false, scale = 1 } = {}) {
  const port = 9400 + Math.floor(Math.random() * 500);
  const profile = mkdtempSync(join(tmpdir(), 'moon-check-'));
  const chrome = spawn(CHROME, ['--headless=new', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let tabs;
  for (let i = 0; i < 60 && !tabs; i++) { try { tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await sleep(250); } }
  if (!tabs) { chrome.kill(); throw new Error('Chrome did not start'); }
  const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  let id = 0;
  const pending = new Map(), errors = [], requests = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id) pending.get(d.id)?.(d);
    else if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text);
    else if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
    else if (d.method === 'Network.requestWillBeSent') requests.push(d.params.request.url);
  };
  const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => {
    const r = (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result;
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const size = (w, h, m = false, s = 1) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: s, mobile: m });
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
  await size(width, height, mobile, scale);
  const center = async (sel) => JSON.parse(await ev(`(()=>{const r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()`));
  mkdirSync(OUT, { recursive: true });
  return {
    send, ev, size, errors, requests,
    goto: async (url, wait = 6000) => { await send('Page.navigate', { url }); await sleep(wait); },
    move: (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }),
    click: async (sel) => { const p = await center(sel); for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 }); },
    drag: async (x0, y0, x1, y1, steps = 12) => {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1 });
      for (let i = 1; i <= steps; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + (x1 - x0) * i / steps, y: y0 + (y1 - y0) * i / steps, button: 'left', buttons: 1 }); await sleep(30); }
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', clickCount: 1 });
    },
    key: async (key, code, vk, text) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, text }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk }); },
    offline: (off) => send('Network.emulateNetworkConditions', { offline: off, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }),
    shot: async (name, clip) => { const file = join(OUT, `${name}.png`); writeFileSync(file, Buffer.from((await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) })).result.data, 'base64')); return file; },
    close: () => { ws.close(); chrome.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch { /* still in use */ } },
  };
}
