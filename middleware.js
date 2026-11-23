// EdgeOne Makers 平台中间件：全站访问密码保护
// 运行在边缘 V8 环境，仅使用 Web API（crypto.subtle / TextEncoder / Response）。
// 未通过校验：页面请求返回登录页，其他请求（含 /api/*）返回 401 JSON。
// 通过校验：next() 原样转发，DSH 前端与 SSE 长连接均不受影响。
export const config = { matcher: ['/:path*'] };

const COOKIE_NAME = 'dsh_gate';
const SESSION_SECONDS = 60 * 60 * 24 * 30; // 30 天
const encoder = new TextEncoder();

// 前端静态资源（bundle / 插件 / 样式 / 图标）不参与鉴权。
// 原因：这些是公开的前端代码，不含任何数据；而 DSH 前端会在页面存活期间
// 按需 import 插件 chunk，一旦被 401 拦截，加载器会抛出
// "failed to import loader entry ... bundle script failed to load"，
// 用户只能手动刷新才能恢复。真正的数据与模型额度在 /api/* 与 /rpc 后面。
const PUBLIC_PREFIXES = ['/plugins/', '/assets/', '/static/', '/_next/'];
const PUBLIC_FILES = new Set([
  '/favicon.ico',
  '/favicon.svg',
  '/favicon.png',
  '/manifest.webmanifest',
  '/site.webmanifest',
  '/robots.txt',
]);

function isPublicAsset(path) {
  if (path.endsWith('.html')) return false; // 页面本身仍受保护
  if (PUBLIC_FILES.has(path)) return true;
  return PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sign(secret, data) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(data)));
}

// 常量时间字符串比较，避免逐字符短路带来的时序侧信道
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readCookie(header, name) {
  if (!header) return '';
  for (const chunk of header.split(';')) {
    const i = chunk.indexOf('=');
    if (i < 0) continue;
    if (chunk.slice(0, i).trim() === name) return chunk.slice(i + 1).trim();
  }
  return '';
}

async function sessionValid(token, secret) {
  if (!token || !secret) return false;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;
  const expires = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const ts = Number(expires);
  if (!Number.isFinite(ts) || ts < Date.now()) return false;
  return safeEqual(await sign(secret, expires), signature);
}

function setCookie(value, maxAge) {
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function htmlHeaders() {
  return { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
}

function loginPage(message) {
  const alert = message ? `<p class="err" role="alert">${message}</p>` : '';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b0e14">
<meta name="robots" content="noindex">
<title>访问验证 · DeepSeek Harness</title>
<style>
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;display:grid;place-items:center;padding:24px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;background:radial-gradient(1200px 620px at 18% -12%,#1b2a4a 0%,#0b0e14 55%,#07090d 100%);color:#e6ebf5;-webkit-font-smoothing:antialiased}
.card{width:min(400px,100%);background:rgba(20,25,36,.74);border:1px solid rgba(255,255,255,.08);border-radius:20px;padding:32px 28px 26px;backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);box-shadow:0 24px 80px rgba(0,0,0,.55)}
.brand{display:flex;align-items:center;gap:11px;margin-bottom:24px}
.logo{width:38px;height:38px;display:grid;place-items:center;border-radius:11px;background:linear-gradient(135deg,#3b82f6,#6366f1);box-shadow:0 6px 18px rgba(59,130,246,.35);flex:none}
.logo svg{width:22px;height:22px}
.brand b{display:block;font-size:14.5px;letter-spacing:.2px;line-height:1.3}
.brand span{font-size:10.5px;color:#8b97ad;letter-spacing:1.8px;text-transform:uppercase}
h1{margin:0 0 6px;font-size:21px;font-weight:650;letter-spacing:-.2px}
p.sub{margin:0 0 22px;font-size:13.5px;line-height:1.6;color:#98a4b8}
label{display:block;font-size:12.5px;font-weight:600;color:#aeb9cc;margin-bottom:8px}
input{width:100%;height:48px;padding:0 14px;border-radius:12px;border:1px solid rgba(255,255,255,.12);background:rgba(10,14,20,.72);color:#fff;font-size:16px;outline:none;transition:border-color .16s,box-shadow .16s}
input::placeholder{color:#5f6b7f}
input:focus{border-color:#4f8cff;box-shadow:0 0 0 3px rgba(79,140,255,.18)}
button{width:100%;height:48px;margin-top:16px;border:none;border-radius:12px;background:linear-gradient(135deg,#3b82f6,#6366f1);color:#fff;font-size:15.5px;font-weight:650;cursor:pointer;transition:filter .16s,transform .06s}
button:hover{filter:brightness(1.08)}
button:active{transform:scale(.99)}
.err{margin:0 0 16px;padding:10px 12px;border-radius:10px;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.28);color:#fca5a5;font-size:13px;line-height:1.5}
.foot{margin-top:20px;text-align:center;font-size:11.5px;color:#5f6b7f}
@media(max-width:420px){.card{padding:26px 20px 22px;border-radius:18px}}
</style>
</head>
<body>
<main class="card">
  <div class="brand">
    <span class="logo"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3.2 13.4C6.4 7.4 10 4.4 14.2 4.4c2.2 0 3.6 1 4.3 2.6M3.2 13.4c4 1.4 8 1 12-1.6" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="17.6" cy="8.6" r="1.2" fill="#fff"/></svg></span>
    <div><b>DeepSeek Harness</b><span>EdgeOne Makers</span></div>
  </div>
  <h1>访问验证</h1>
  <p class="sub">此工作区已启用访问密码保护，请输入密码后继续。</p>
  ${alert}
  <form method="post" action="/__dsh/login">
    <label for="pw">访问密码</label>
    <input id="pw" name="password" type="password" autocomplete="current-password" placeholder="请输入密码" autofocus required>
    <button type="submit">进入工作区</button>
  </form>
  <p class="foot">受 EdgeOne 边缘节点保护</p>
</main>
</body>
</html>`;
}

export async function middleware(context) {
  const { request, next, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const secret = String(env?.DSH_AUTH_SECRET || '');
  const expected = String(env?.DSH_ACCESS_PASSWORD || '');

  if (path === '/__dsh/logout') {
    return new Response(null, {
      status: 302,
      headers: { location: '/', 'set-cookie': setCookie('', 0), 'cache-control': 'no-store' },
    });
  }

  if (path === '/__dsh/login') {
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
    let password = '';
    try {
      const form = await request.formData();
      password = String(form.get('password') || '');
    } catch {
      // 表单解析失败按空密码处理
    }
    if (!expected || !secret) {
      return new Response(loginPage('服务端尚未配置访问密码（DSH_ACCESS_PASSWORD / DSH_AUTH_SECRET）'), { status: 500, headers: htmlHeaders() });
    }
    if (!safeEqual(password, expected)) {
      return new Response(loginPage('密码不正确，请重试。'), { status: 200, headers: htmlHeaders() });
    }
    const expires = String(Date.now() + SESSION_SECONDS * 1000);
    const token = `${expires}.${await sign(secret, expires)}`;
    return new Response(null, {
      status: 302,
      headers: { location: '/', 'set-cookie': setCookie(token, SESSION_SECONDS), 'cache-control': 'no-store' },
    });
  }

  // 静态前端资源直接放行，避免 Cookie 失效时插件 chunk 被拦导致加载器报错
  if (isPublicAsset(path)) {
    return next();
  }

  const token = readCookie(request.headers.get('cookie'), COOKIE_NAME);
  if (await sessionValid(token, secret)) {
    // 同时把签名回传给下游，供 agents 入口做二次校验（若平台透传自定义头）
    return next({ headers: { 'x-dsh-gate': token } });
  }

  const accept = request.headers.get('accept') || '';
  const wantsHtml = accept.includes('text/html') || path === '/' || path.endsWith('.html');
  if ((request.method === 'GET' || request.method === 'HEAD') && wantsHtml) {
    return new Response(loginPage(''), { status: 200, headers: htmlHeaders() });
  }

  // 兜底：万一仍有脚本请求被拦，返回一段跳回登录页的代码，
  // 而不是让 DSH 加载器抛出 "failed to load plugins" 这种无从下手的错误。
  const dest = request.headers.get('sec-fetch-dest') || '';
  if (request.method === 'GET' && (dest === 'script' || accept.includes('javascript'))) {
    return new Response("try{location.replace('/')}catch(e){}", {
      status: 200,
      headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  return new Response(JSON.stringify({ error: 'UNAUTHORIZED', message: '需要访问密码' }), {
    status: 401,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
