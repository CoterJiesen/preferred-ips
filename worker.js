/**
 * Preferred IP Provider Worker
 * ----------------------------
 * 为 v2board 等面板提供"优选域名/IP 列表"接口，自带管理页维护。
 *
 * 功能：
 *   1. GET /api/ips   — 合并输出 内置优选域名 + 手动维护 + wetest拉取 + GitHub拉取
 *   2. GET /          — 管理页（登录后维护拉取地址 / 手动增删IP / 刷新）
 *   3. POST /api/admin— 管理动作（增删、设源、刷新），需登录 key
 *
 * 安全：所有接口都需要 AUTH_KEY（部署时通过环境变量设置），
 *       API 可用 ?key=xxx 或 Authorization: Bearer xxx 传递。
 *
 * KV 绑定：PREFERRED_IPS（存手动列表 / 拉取源配置 / 拉取缓存）
 *
 * 环境变量：
 *   AUTH_KEY           必填，管理页与接口的登录密钥
 */
const POOL_TTL = 15 * 60; // 拉取缓存 15 分钟（秒），与 CFnew 自动优选周期一致

/** 内置优选域名（来自 CFnew 直连域名列表，CNAME 到 Cloudflare 边缘） */
const BUILTIN_DOMAINS = [
  { name: "cloudflare.182682.xyz", domain: "cloudflare.182682.xyz" },
  { name: "speed.marisalnc.com", domain: "speed.marisalnc.com" },
  { domain: "freeyx.cloudflare88.eu.org" },
  { domain: "bestcf.top" },
  { domain: "cdn.2020111.xyz" },
  { domain: "cfip.cfcdn.vip" },
  { domain: "cf.0sm.com" },
  { domain: "cf.090227.xyz" },
  { domain: "cf.zhetengsha.eu.org" },
  { domain: "cloudflare.9jy.cc" },
  { domain: "cf.zerone-cdn.pp.ua" },
  { domain: "cfip.1323123.xyz" },
  { domain: "cnamefuckxxs.yuchen.icu" },
  { domain: "cloudflare-ip.mofashi.ltd" },
  { domain: "115155.xyz" },
  { domain: "cname.xirancdn.us" },
  { domain: "f3058171cad.002404.xyz" },
  { domain: "8.889288.xyz" },
  { domain: "cdn.tzpro.xyz" },
  { domain: "cf.877771.xyz" },
  { domain: "xn--b6gac.eu.org" },
];

/** 默认拉取源 */
const DEFAULT_SOURCES = {
  wetest_enable: true,
  wetest_v4: "https://www.wetest.vip/page/cloudflare/address_v4.html",
  wetest_v6_enable: true,
  wetest_v6: "https://www.wetest.vip/page/cloudflare/address_v6.html",
  github_enable: true,
  github_url: "https://raw.githubusercontent.com/qwer-search/bestip/refs/heads/main/kejilandbestip.txt",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/ips") {
      if (!authOk(request, url, env)) return json({ success: false, error: "forbidden" }, 403);
      try {
        return await handleIps(env);
      } catch (e) {
        return json({ success: false, error: e.message }, 500);
      }
    }
    if (path === "/api/admin") {
      if (!authOk(request, url, env)) return json({ success: false, error: "forbidden" }, 403);
      try {
        return await handleAdmin(request, env);
      } catch (e) {
        return json({ success: false, error: e.message }, 500);
      }
    }
    if (path === "/") {
      return new Response(PAGE_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    return json({ success: false, error: "not found" }, 404);
  },
};

// ===================== 鉴权 =====================

function authOk(request, url, env) {
  const key = env.AUTH_KEY || "";
  if (!key) return false;
  const fromQuery = url.searchParams.get("key") || "";
  const fromHeader = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "") ||
                     (request.headers.get("x-auth-key") || "");
  return safeEqual(fromQuery, key) || safeEqual(fromHeader, key);
}

/** 常数时间字符串比较，避免时序侧信道 */
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ===================== API: 输出合并列表 =====================

async function handleIps(env) {
  const manual = await kvGetJSON(env, "manual", []);
  const builtin = BUILTIN_DOMAINS.map((d) => ({ ip: d.domain, port: 443, name: d.name || d.domain }));
  const fetched = await getFetched(env, false);
  // 先按 ip:port 去重，再按 CFnew 规则命名并编号（v2board 展开节点时 name 必须唯一）
  const merged = cfnewNaming(dedupe([...manual, ...builtin, ...fetched])).slice(0, 500);
  return json({ success: true, count: merged.length, data: merged });
}

// ===================== API: 管理动作 =====================

async function handleAdmin(request, env) {
  if (request.method === "GET") {
    const manual = await kvGetJSON(env, "manual", []);
    const sources = await getSources(env);
    const fetched = await getFetched(env, false);
    return json({
      success: true,
      data: {
        sources,
        manual,
        builtin_count: BUILTIN_DOMAINS.length,
        fetched_count: fetched.length,
      },
    });
  }

  const body = await request.json().catch(() => ({}));
  const action = body.action;

  switch (action) {
    case "source": {
      const next = { ...(await getSources(env)) };
      for (const k of ["wetest_enable", "wetest_v6_enable", "github_enable"]) {
        if (body[k] !== undefined) next[k] = !!body[k];
      }
      for (const k of ["wetest_v4", "wetest_v6", "github_url"]) {
        if (body[k] !== undefined) next[k] = String(body[k]).trim();
      }
      await env.PREFERRED_IPS.put("sources", JSON.stringify(next));
      await env.PREFERRED_IPS.delete("pool_cache");
      return json({ success: true, data: next });
    }
    case "add": {
      const manual = await kvGetJSON(env, "manual", []);
      const items = parseItems(body.items, body.content);
      const seen = new Set(manual.map((e) => e.ip + ":" + e.port));
      let added = 0;
      for (const it of items) {
        const k = it.ip + ":" + it.port;
        if (seen.has(k)) continue;
        seen.add(k);
        manual.push(it);
        added++;
      }
      await env.PREFERRED_IPS.put("manual", JSON.stringify(manual));
      return json({ success: true, data: { added, manual_count: manual.length } });
    }
    case "remove": {
      let manual = await kvGetJSON(env, "manual", []);
      const targets = parseItems(body.items, body.content);
      const before = manual.length;
      if (targets.length) {
        const del = new Set(targets.map((t) => t.ip + ":" + t.port));
        manual = manual.filter((e) => !del.has(e.ip + ":" + e.port));
      }
      await env.PREFERRED_IPS.put("manual", JSON.stringify(manual));
      return json({ success: true, data: { removed: before - manual.length, manual_count: manual.length } });
    }
    case "clear": {
      await env.PREFERRED_IPS.put("manual", JSON.stringify([]));
      return json({ success: true, data: { manual_count: 0 } });
    }
    case "refresh": {
      const fetched = await getFetched(env, true);
      return json({ success: true, data: { fetched_count: fetched.length } });
    }
    case "purge": {
      await env.PREFERRED_IPS.delete("pool_cache");
      await env.PREFERRED_IPS.delete("pool_cache_at");
      return json({ success: true, data: { purged: true } });
    }
    default:
      return json({ success: false, error: "unknown action" }, 400);
  }
}

// ===================== 拉取源 =====================

async function getSources(env) {
  const saved = await kvGetJSON(env, "sources", {});
  return { ...DEFAULT_SOURCES, ...saved };
}

/** 拉取 wetest + GitHub，合并去重，带 KV 缓存 */
async function getFetched(env, force) {
  if (!force) {
    const cache = await env.PREFERRED_IPS.get("pool_cache");
    const cachedAt = parseInt((await env.PREFERRED_IPS.get("pool_cache_at")) || "0", 10);
    if (cache && Date.now() - cachedAt < POOL_TTL * 1000) {
      try { return JSON.parse(cache); } catch (e) {}
    }
  }
  const s = await getSources(env);
  const jobs = [];
  if (s.wetest_enable) {
    if (s.wetest_v4) jobs.push(fetchWetest(s.wetest_v4).catch((e) => []));
    if (s.wetest_v6_enable && s.wetest_v6) jobs.push(fetchWetest(s.wetest_v6).catch((e) => []));
  }
  if (s.github_enable && s.github_url) {
    jobs.push(fetchGithub(s.github_url).catch((e) => []));
  }
  const results = await Promise.allSettled(jobs);
  const list = [];
  for (const r of results) if (r.status === "fulfilled") list.push(...r.value);
  const pool = dedupe(list);
  await env.PREFERRED_IPS.put("pool_cache", JSON.stringify(pool));
  await env.PREFERRED_IPS.put("pool_cache_at", String(Date.now()));
  return pool;
}

async function fetchWetest(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error("wetest HTTP " + res.status);
  const html = await res.text();
  const out = [];
  const rowRe = /<tr[\s\S]*?<\/tr>/g;
  const cellRe = /<td data-label="线路名称">(.+?)<\/td>[\s\S]*?<td data-label="优选地址">([\d.:a-fA-F]+)<\/td>[\s\S]*?<td data-label="数据中心">(.+?)<\/td>/;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const c = m[0].match(cellRe);
    if (c && c[1] && c[2]) {
      const isp = c[1].replace(/<.*?>/g, "").trim();
      const ip = c[2].trim();
      const colo = c[3] ? c[3].replace(/<.*?>/g, "").trim() : "";
      out.push({ ip, port: 443, isp, colo, name: isp || colo || ip });
    }
  }
  return out;
}

async function fetchGithub(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error("github HTTP " + res.status);
  const text = await res.text();
  return text.split(/\r?\n/).map(parseLine).filter(Boolean);
}

// ===================== 解析 =====================

/** 把 "ip[:port][#name]" 或 JSON items 解析为 {ip,port,name} 数组 */
function parseItems(items, content) {
  const out = [];
  if (Array.isArray(items)) {
    for (const it of items) {
      if (it && it.ip) out.push({ ip: String(it.ip).trim(), port: it.port || 443, name: it.name || String(it.ip) });
    }
    return out;
  }
  if (typeof content === "string") {
    for (const line of content.split(/\r?\n/)) {
      const e = parseLine(line);
      if (e) out.push(e);
    }
  }
  return out;
}

/** 解析单行 ip[:port][#name]，支持裸 IPv6 与 [IPv6]:port */
function parseLine(line) {
  line = line.trim();
  if (!line || line.startsWith("#") || line.startsWith("//")) return null;
  let name = null;
  const hash = line.indexOf("#");
  if (hash !== -1) {
    name = line.slice(hash + 1).trim();
    line = line.slice(0, hash).trim();
  }
  let ip = line;
  let port = null;
  if (line.startsWith("[")) {
    const end = line.indexOf("]");
    if (end !== -1) {
      ip = line.slice(1, end);
      const after = line.slice(end + 1);
      if (after.startsWith(":")) port = parseInt(after.slice(1), 10);
    }
  } else if ((line.match(/:/g) || []).length > 1) {
    // 裸 IPv6，整体当地址
  } else {
    const colon = line.lastIndexOf(":");
    if (colon !== -1 && /^\d+$/.test(line.slice(colon + 1))) {
      ip = line.slice(0, colon);
      port = parseInt(line.slice(colon + 1), 10);
    }
  }
  if (!ip) return null;
  return { ip, port: port && port > 0 ? port : 443, name: name || ip };
}

function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const e of arr) {
    if (!e || !e.ip) continue;
    const k = e.ip + ":" + e.port;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ ip: e.ip, port: e.port || 443, name: e.name || e.ip });
  }
  return out;
}

/** 规范化名称：去括号/协议/路径，空白→下划线（对应 CFnew 处理值节点别名部分） */
function cleanName(v, fallback) {
  let s = String(v || "").trim();
  if (!s || /^自定义优选-/i.test(s)) s = fallback;
  s = s.replace(/^\[([^\]]+)\]$/, "$1").replace(/^https?:\/\//i, "").replace(/[/?#].*$/, "").replace(/\s+/g, "_");
  return s || fallback;
}

/** 是否为 IP（IPv4 或含冒号的 IPv6） */
function isIp(host) {
  if (!host) return false;
  return host.includes(":") || /^(\d{1,3}\.){3}\d{1,3}$/.test(host);
}

/**
 * 按 CFnew 命名规则给整个池命名并编号：
 *  IPv6 → IPv6优选；域名 → 优选域名；IPv4 → isp[-colo]（无 isp 用 IPv4优选）
 *  每个基础名独立编号 -01、-02…（保证 name 唯一）
 */
function cfnewNaming(arr) {
  const counters = {};
  const out = [];
  for (const e of arr) {
    const host = String(e.ip || "").trim().replace(/^\[([^\]]+)\]$/, "$1");
    let base;
    if (host.includes(":") && /^[0-9a-fA-F:.]+$/.test(host)) {
      base = "IPv6优选";
    } else if (!isIp(host)) {
      base = "域名";
    } else {
      const isp = cleanName(e.isp || e.name, "IPv4优选");
      const colo = cleanName(e.colo, "");
      base = colo ? isp + "." + colo : isp;
    }
    counters[base] = (counters[base] || 0) + 1;
    out.push({ ...e, name: base + "." + String(counters[base]).padStart(2, "0") });
  }
  return out;
}

// ===================== KV / 响应工具 =====================

async function kvGetJSON(env, key, fallback) {
  try {
    const v = await env.PREFERRED_IPS.get(key);
    return v ? JSON.parse(v) : fallback;
  } catch (e) {
    return fallback;
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// ===================== 管理页 =====================

const PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>优选IP Provider 管理</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:#f4f6f9;color:#333;padding:24px}
  .wrap{max-width:860px;margin:0 auto}
  h1{font-size:20px;margin-bottom:4px}
  .sub{color:#888;font-size:13px;margin-bottom:20px}
  .card{background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.08);padding:20px;margin-bottom:20px}
  .card h2{font-size:15px;margin-bottom:12px}
  .btn{display:inline-block;border:1px solid #d9dde3;background:#fff;color:#333;padding:6px 14px;border-radius:5px;cursor:pointer;font-size:13px}
  .btn:hover{background:#f6f8fa}
  .btn-primary{background:#409eff;border-color:#409eff;color:#fff}
  .btn-danger{color:#d9534f}
  .btn:disabled{opacity:.5;cursor:not-allowed}
  input[type=text],textarea{width:100%;border:1px solid #d9dde3;border-radius:5px;padding:6px 10px;font-size:13px;font-family:inherit}
  input[type=text]:focus,textarea:focus{outline:none;border-color:#409eff}
  textarea{min-height:90px;resize:vertical}
  .form-row{display:flex;gap:10px;margin-top:10px;flex-wrap:wrap;align-items:center}
  .form-row .btn{white-space:nowrap}
  .lbl{display:block;font-size:12px;color:#888;margin:8px 0 4px}
  .chk{display:flex;align-items:center;gap:6px;font-size:13px;margin-bottom:8px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:7px 10px;border-bottom:1px solid #f0f2f5}
  th{background:#fafbfc;color:#666;font-weight:600}
  tr:hover td{background:#fafcff}
  .empty{color:#999;text-align:center;padding:18px}
  .msg{position:fixed;top:20px;right:20px;padding:10px 16px;border-radius:6px;color:#fff;font-size:13px;opacity:0;transition:opacity .25s;z-index:99;max-width:70vw}
  .msg.show{opacity:1}
  .msg.ok{background:#67c23a}.msg.err{background:#f56c6c}
  #login{max-width:360px;margin:80px auto}
</style>
</head>
<body>
<div id="login" class="card" style="display:none">
  <h2>管理登录</h2>
  <div class="lbl">登录密钥（AUTH_KEY）</div>
  <input type="text" id="key-input" autocomplete="off">
  <div class="form-row"><button class="btn btn-primary" onclick="doLogin()">登录</button></div>
</div>

<div class="wrap" id="main" style="display:none">
  <h1>优选IP Provider 管理</h1>
  <div class="sub">合并输出：内置优选域名 + 手动维护 + wetest拉取 + GitHub拉取。接口 <code>/api/ips?key=xxx</code></div>

  <div class="card">
    <h2>拉取源配置 <span id="src-status" class="sub"></span></h2>
    <label class="chk"><input type="checkbox" id="wetest_enable"> 启用 wetest 拉取</label>
    <div class="lbl">wetest IPv4 地址</div>
    <input type="text" id="wetest_v4">
    <label class="chk"><input type="checkbox" id="wetest_v6_enable"> 启用 wetest IPv6 拉取</label>
    <div class="lbl">wetest IPv6 地址</div>
    <input type="text" id="wetest_v6">
    <label class="chk"><input type="checkbox" id="github_enable"> 启用 GitHub 拉取</label>
    <div class="lbl">GitHub 列表 URL</div>
    <input type="text" id="github_url">
    <div class="form-row">
      <button class="btn btn-primary" onclick="saveSources()">保存拉取源</button>
      <button class="btn" onclick="refresh()">立即刷新拉取</button>
      <button class="btn" onclick="purgeCache()">清空拉取缓存</button>
    </div>
  </div>

  <div class="card">
    <h2>手动维护 <span id="manual-status" class="sub"></span></h2>
    <div class="lbl">每行一个 ip[:port][#名称]（留空仅用于清空）</div>
    <textarea id="manual-input" placeholder="1.1.1.1:443#香港&#10;cloudflare.182682.xyz#优选域名"></textarea>
    <div class="form-row">
      <button class="btn btn-primary" onclick="addManual()">添加/追加</button>
      <button class="btn" onclick="removeManual()">按内容移除</button>
      <button class="btn btn-danger" onclick="clearManual()">清空手动列表</button>
    </div>
    <table style="margin-top:14px">
      <thead><tr><th>IP/域名</th><th>端口</th><th>名称</th><th></th></tr></thead>
      <tbody id="manual-tbody"></tbody>
    </table>
  </div>
</div>

<div class="msg" id="msg"></div>

<script>
var key = localStorage.getItem('pf_key') || '';

function toast(text, ok){var el=document.getElementById('msg');el.textContent=text;el.className='msg show '+(ok?'ok':'err');clearTimeout(el._t);el._t=setTimeout(function(){el.className='msg';},2600);}
function showLogin(){document.getElementById('login').style.display='block';document.getElementById('main').style.display='none';}
function showMain(){document.getElementById('login').style.display='none';document.getElementById('main').style.display='block';}
function doLogin(){key=document.getElementById('key-input').value.trim();localStorage.setItem('pf_key',key);load();}

async function api(action, payload){
  var res = await fetch('/api/admin', {
    method: 'POST',
    headers: {'Content-Type':'application/json','Authorization':'Bearer '+key},
    body: JSON.stringify(Object.assign({action:action}, payload||{}))
  });
  if (res.status===401||res.status===403){ toast('密钥错误或未登录',false); key=''; localStorage.removeItem('pf_key'); showLogin(); throw new Error('auth'); }
  var data = await res.json();
  if (!data.success) throw new Error(data.error||('HTTP '+res.status));
  return data.data;
}
async function getState(){
  var res = await fetch('/api/admin', {headers:{'Authorization':'Bearer '+key}});
  if (res.status===401||res.status===403){ throw new Error('auth'); }
  var data = await res.json();
  if (!data.success) throw new Error(data.error||('HTTP '+res.status));
  return data.data;
}

async function load(){
  try {
    var d = await getState();
    showMain();
    document.getElementById('wetest_enable').checked = !!d.sources.wetest_enable;
    document.getElementById('wetest_v4').value = d.sources.wetest_v4||'';
    document.getElementById('wetest_v6_enable').checked = d.sources.wetest_v6_enable === undefined ? true : !!d.sources.wetest_v6_enable;
    document.getElementById('wetest_v6').value = d.sources.wetest_v6||'';
    document.getElementById('github_enable').checked = !!d.sources.github_enable;
    document.getElementById('github_url').value = d.sources.github_url||'';
    document.getElementById('src-status').textContent = '（内置 '+d.builtin_count+' + 拉取 '+d.fetched_count+'）';
    renderManual(d.manual);
  } catch(e){ if(e.message==='auth'){ showLogin(); } else { toast('加载失败：'+e.message,false); } }
}

function renderManual(list){
  document.getElementById('manual-status').textContent = '（'+list.length+' 条）';
  var tb = document.getElementById('manual-tbody');
  if (!list.length){ tb.innerHTML='<tr><td colspan="4" class="empty">暂无手动条目</td></tr>'; return; }
  tb.innerHTML = list.map(function(e,i){
    return '<tr><td>'+esc(e.ip)+'</td><td>'+e.port+'</td><td>'+esc(e.name||'')+'</td>'+
      '<td><button class="btn btn-danger" data-ip="'+esc(e.ip)+'" data-port="'+e.port+'" onclick="delOne(this)">删</button></td></tr>';
  }).join('');
}
function delOne(btn){
  api('remove',{items:[{ip:btn.dataset.ip, port:parseInt(btn.dataset.port,10)}]}).then(function(){toast('已删除',true);load();}).catch(function(e){toast(e.message,false);});
}

async function saveSources(){
  try {
    await api('source', {
      wetest_enable: document.getElementById('wetest_enable').checked,
      wetest_v4: document.getElementById('wetest_v4').value.trim(),
      wetest_v6_enable: document.getElementById('wetest_v6_enable').checked,
      wetest_v6: document.getElementById('wetest_v6').value.trim(),
      github_enable: document.getElementById('github_enable').checked,
      github_url: document.getElementById('github_url').value.trim()
    });
    toast('拉取源已保存，缓存已清', true); load();
  } catch(e){ toast('保存失败：'+e.message, false); }
}
async function refresh(){
  try { var r = await api('refresh',{}); toast('刷新完成，拉取 '+r.fetched_count+' 条', true); load(); }
  catch(e){ toast('刷新失败：'+e.message, false); }
}
async function purgeCache(){
  try { await api('purge',{}); toast('拉取缓存已清', true); }
  catch(e){ toast('清缓存失败：'+e.message, false); }
}
async function addManual(){
  var content = document.getElementById('manual-input').value;
  if(!content.trim()){ toast('请输入内容', false); return; }
  try { var r = await api('add',{content:content}); toast('新增 '+r.added+' 条', true); document.getElementById('manual-input').value=''; load(); }
  catch(e){ toast('添加失败：'+e.message, false); }
}
async function removeManual(){
  var content = document.getElementById('manual-input').value;
  try { var r = await api('remove',{content:content}); toast('移除 '+r.removed+' 条', true); document.getElementById('manual-input').value=''; load(); }
  catch(e){ toast('移除失败：'+e.message, false); }
}
async function clearManual(){
  if(!confirm('确定清空全部手动条目？')) return;
  try { await api('clear',{}); toast('已清空', true); load(); }
  catch(e){ toast('清空失败：'+e.message, false); }
}

function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

if (key) load(); else showLogin();
</script>
</body>
</html>`;
