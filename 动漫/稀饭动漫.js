// @name 稀饭动漫
// @author
// @description 刮削：支持，弹幕：支持，播放记录：支持
// @dependencies: axios, cheerio
// @version 1.1.3
// @downloadURL https://gh-proxy.org/https://github.com/zhao-wuyan/OmniBox-Spider/raw/refs/heads/fixed/动漫/稀饭动漫.js

/**
 * ============================================================================
 * 稀饭动漫 OmniBox 站源
 *
 * 站点已从旧版 MacCMS 模板整体改版为 Next.js App Router：
 *   - 旧：/index.php/ds_api/vod、/bangumi/{id}.html、/watch/...
 *   - 新：/anime/{id}、/anime/{id}/play/{episodeId}?source={code}
 *     列表页：/、/browse(可带 format/finished/year/tag/sort/page)、/recent、/rankings
 *     搜索页：/search?q=xxx
 *
 * 数据来源说明：
 *   - 列表页：服务端渲染的卡片 <a aria-label="片名" href="/anime/{id}">，直接解析 HTML
 *   - 详情页：剧集数据内嵌在 RSC 数据流 self.__next_f.push([1,"..."]) 中，
 *            其中 sources[] 为合法 JSON，做括号配对后可直接 JSON.parse
 *   - 播放页：视频直链由前端播放器运行时获取，服务端 HTML 不含 m3u8，
 *            因此优先用 SDK 的 sniffVideo 嗅探，失败则交给 OmniBox 解析
 *   - 搜索：站点 /search?q= 由前端渲染、服务端恒返回空列表，
 *          真正可用的搜索走它自己的 Supabase PostgREST：
 *          https://api.xifanacg.com/rest/v1/animes（支持中文/日文/拼音，取匹配度最高的前 24 条）
 *          兜底 https://api.xifanacg.com/rest/v1/rpc/suggest_animes
 *          只做精准查询，不提供翻页
 *          key 不写死在脚本里：运行时从站点首页引用的 JS 中抓取（公开只读
 *          publishable key，非 JWT 无 exp），缓存 7 天；遇到 401 自动丢弃重抓并重试。
 *          也可用环境变量 XIFAN_API_KEY 手动指定（指定后不再自动抓取）。
 * ============================================================================
 */

const axios = require("axios");
const cheerio = require("cheerio");
const OmniBox = require("omnibox_sdk");
const runner = require("spider_runner");

// 站点真实 SSR 域名。dm.xifanacg.com 对子路由一律回退到首页，不能用
const HOST = "https://next.xifanacg.com";
// 站点数据层是 Supabase，搜索/列表走它自己的 PostgREST。
// key 不写死在脚本里：站点前端本来就要用它建 Supabase 客户端，
// 所以运行时从首页引用的 JS 里抓一个，缓存 7 天；401 时重新抓取。
// 也支持用环境变量 XIFAN_API_KEY 手动指定（指定后不再自动抓取）。
const API_HOST = "https://api.xifanacg.com";
const API_CACHE_KEY = "xifan:supabase-key";
const API_KEY_TTL = 7 * 24 * 3600;
let apiKey = String(process.env.XIFAN_API_KEY || "").trim();
// 上次发现 key 的 chunk，命中时只需拉一个包（约 250KB）
let apiKeyChunk = "";
const API_PAGE_SIZE = 24;
const SEARCH_SELECT = [
  "id",
  "title",
  "title_original",
  "cover_url",
  "format",
  "type_id",
  "release_year",
  "bangumi_score",
  "current_episodes",
  "total_episodes",
  "is_finished",
  "remarks",
  "view_count",
].join(",");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";
const PAGE_SIZE = 24;
const DANMU_API = process.env.DANMU_API || "";

const axiosInstance = axios.create({
  timeout: 20000,
  headers: {
    "User-Agent": UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
    Referer: HOST + "/",
  },
  httpsAgent: new (require("https").Agent)({ rejectUnauthorized: false }),
  maxRedirects: 5,
});

// Supabase PostgREST 客户端（只读）。注意不能走 axios 的 params，
// 否则逻辑树里的括号/逗号会被二次编码，PostgREST 解析报 PGRST100。
// apikey 不写死在这里，改由 apiHeaders() 逐请求注入，以便失效后热更新
const apiInstance = axios.create({
  timeout: 20000,
  headers: {
    "User-Agent": UA,
    "content-type": "application/json",
    Referer: HOST + "/",
  },
  httpsAgent: new (require("https").Agent)({ rejectUnauthorized: false }),
  maxRedirects: 3,
});

const CLASSES = [
  { type_id: "all", type_name: "全部番剧" },
  { type_id: "tv", type_name: "TV 动画" },
  { type_id: "movie", type_name: "剧场版" },
  { type_id: "ova", type_name: "OVA" },
  { type_id: "oad", type_name: "OAD" },
  { type_id: "web", type_name: "Web 动画" },
  { type_id: "other", type_name: "其他" },
];

const YEAR_VALUES = [{ n: "全部", v: "" }];
for (let y = 2026; y >= 2005; y--) YEAR_VALUES.push({ n: String(y), v: String(y) });

const FILTER_GROUPS = [
  {
    key: "finished",
    name: "状态",
    value: [
      { n: "全部", v: "" },
      { n: "连载中", v: "0" },
      { n: "完结", v: "1" },
    ],
  },
  { key: "year", name: "年份", value: YEAR_VALUES },
  {
    key: "tag",
    name: "标签",
    value: [
      { n: "全部", v: "" },
      { n: "漫画改", v: "漫画改" },
      { n: "小说改", v: "小说改" },
      { n: "奇幻", v: "奇幻" },
      { n: "战斗", v: "战斗" },
      { n: "原创", v: "原创" },
      { n: "恋爱", v: "恋爱" },
      { n: "校园", v: "校园" },
      { n: "百合", v: "百合" },
      { n: "后宫", v: "后宫" },
      { n: "科幻", v: "科幻" },
      { n: "游戏改", v: "游戏改" },
      { n: "悬疑", v: "悬疑" },
      { n: "冒险", v: "冒险" },
      { n: "穿越", v: "穿越" },
      { n: "音乐", v: "音乐" },
      { n: "运动", v: "运动" },
      { n: "机战", v: "机战" },
      { n: "喜剧", v: "喜剧" },
      { n: "少年向", v: "少年向" },
      { n: "推理", v: "推理" },
      { n: "少女向", v: "少女向" },
      { n: "职场", v: "职场" },
      { n: "美食", v: "美食" },
      { n: "青年向", v: "青年向" },
    ],
  },
  {
    key: "sort",
    name: "排序",
    value: [
      { n: "默认", v: "" },
      { n: "最新", v: "release_date" },
      { n: "最热", v: "view_count" },
      { n: "评分", v: "bangumi_score" },
    ],
  },
];

// 所有分类共用同一套筛选
const NORMALIZED_FILTERS = {};
for (const c of CLASSES) NORMALIZED_FILTERS[c.type_id] = FILTER_GROUPS;

const logInfo = (message, data = null) => {
  try {
    OmniBox.log("info", `[稀饭动漫] ${message}${data ? " " + JSON.stringify(data) : ""}`);
  } catch (_) {}
};

const logError = (message, error) => {
  try {
    OmniBox.log("error", `[稀饭动漫] ${message}: ${error && error.message ? error.message : error}`);
  } catch (_) {}
};

function pickParamValue(...values) {
  for (const v of values) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return "";
}

function absolutize(input) {
  const value = String(input || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return HOST + (value.startsWith("/") ? value : "/" + value);
}

/** 取卡片列表页上的所有条目 */
function extractCards(html) {
  const $ = cheerio.load(html);
  const list = [];
  const seen = new Set();

  $('a[aria-label][href^="/anime/"]').each((_, el) => {
    const $a = $(el);
    const href = $a.attr("href") || "";
    const matched = href.match(/^\/anime\/(\d+)\/?$/);
    if (!matched) return;

    const vodId = `/anime/${matched[1]}`;
    if (seen.has(vodId)) return;

    // 首页轮播卡片的 aria-label 形如 "观看 片名"，需要去掉前缀
    const name = String($a.attr("aria-label") || "")
      .replace(/^观看\s*/, "")
      .trim();
    if (!name) return;

    const $img = $a.find("img").first();
    let pic = String($img.attr("src") || "").trim();
    if (!pic && $img.attr("srcset")) {
      pic = String($img.attr("srcset")).split(",")[0].trim().split(/\s+/)[0];
    }

    // 卡片副标题形如 "剧场版 · 2007" / "完结旧番 · 2002"
    const texts = $a
      .find("p")
      .map((__, p) => $(p).text().trim())
      .get()
      .filter(Boolean);

    const meta = texts.find((t) => t !== name && t.includes("·")) || "";
    // 分类页年份在 "剧场版 · 2007" 里；首页年份是独立的 4 位数字节点
    const yearMatch =
      (meta.match(/(19|20)\d{2}/) || [])[0] ||
      texts.find((t) => /^(19|20)\d{2}$/.test(t)) ||
      "";
    const statusPart = meta ? meta.split("·")[0].trim() : "";
    const badge = ($a.text().match(/(全\s*\d+\s*[集话]|更新至\s*\d+\s*[集话]|连载中|已完结)/) || [])[0] || "";
    const remarks = badge || statusPart;

    seen.add(vodId);
    list.push({
      vod_id: vodId,
      vod_name: name,
      vod_pic: pic,
      vod_year: yearMatch,
      vod_remarks: remarks,
    });
  });

  return list;
}

/** 从分页链接里推算总页数 */
function extractPageCount(html, page) {
  let max = Number(page) || 1;
  const reg = /\/browse\?[^"'\s>]*page=(\d+)/g;
  let m;
  while ((m = reg.exec(html)) !== null) {
    const n = Number(m[1]);
    if (n > max) max = n;
  }
  return max;
}

/** 拼接 RSC 数据流，返回未转义的文本 */
function extractFlight(html) {
  const reg = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  const parts = [];
  let m;
  while ((m = reg.exec(html)) !== null) {
    try {
      parts.push(JSON.parse(m[1]));
    } catch (_) {}
  }
  return parts.join("");
}

/** 在文本中定位 "key":[...] 并做括号配对，返回解析后的数组 */
function extractJsonArray(text, key) {
  const idx = text.indexOf(`"${key}":[`);
  if (idx < 0) return null;
  const start = text.indexOf("[", idx);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch (e) {
          logError("剧集 JSON 解析失败", e);
          return null;
        }
      }
    }
  }
  return null;
}

function buildBrowseUrl(tid, page, extend) {
  const params = new URLSearchParams();
  if (tid && tid !== "all") params.set("format", tid);
  if (extend.finished === "0" || extend.finished === "1") params.set("finished", extend.finished);
  if (extend.year) params.set("year", extend.year);
  if (extend.tag) params.set("tag", extend.tag);
  if (extend.sort) params.set("sort", extend.sort);
  if (Number(page) > 1) params.set("page", String(page));
  const qs = params.toString();
  return `${HOST}/browse${qs ? "?" + qs : ""}`;
}

async function home() {
  try {
    const { data: html } = await axiosInstance.get(`${HOST}/`);
    const list = extractCards(html).slice(0, 40);
    logInfo("home ok", { list: list.length });
    return { class: CLASSES, filters: NORMALIZED_FILTERS, list };
  } catch (e) {
    logError("home failed", e);
    return { class: CLASSES, filters: NORMALIZED_FILTERS, list: [] };
  }
}

async function category(params = {}) {
  const tid = pickParamValue(params.tid, params.type_id, params.categoryId, params.id) || "all";
  const page = Math.max(Number(params.page || params.pg || 1) || 1, 1);
  const extend = { ...(params.extend || {}), ...(params.filters || {}) };

  try {
    const url = buildBrowseUrl(tid, page, extend);
    const { data: html } = await axiosInstance.get(url);
    const list = extractCards(html);
    const pagecount = extractPageCount(html, page);
    logInfo("category ok", { tid, page, list: list.length, pagecount });
    return {
      list,
      page,
      pagecount,
      limit: PAGE_SIZE,
      total: pagecount * PAGE_SIZE,
      filters: NORMALIZED_FILTERS[tid] || FILTER_GROUPS,
    };
  } catch (e) {
    logError("category failed", e);
    return { list: [], page, pagecount: page, limit: PAGE_SIZE, total: 0, filters: NORMALIZED_FILTERS[tid] || FILTER_GROUPS };
  }
}

/** Supabase 行 -> OmniBox 列表项 */
function mapApiRow(row) {
  if (!row || !row.id) return null;
  const total = Number(row.total_episodes || 0);
  const current = Number(row.current_episodes || 0);
  let remarks = String(row.remarks || "").trim();
  if (!remarks) {
    if (row.is_finished && (total || current)) remarks = `全${total || current}集`;
    else if (current) remarks = `更新至${current}集`;
  }
  return {
    vod_id: `/anime/${row.id}`,
    vod_name: String(row.title || "").trim(),
    vod_pic: String(row.cover_url || "").trim(),
    vod_year: row.release_year ? String(row.release_year) : "",
    vod_remarks: remarks,
  };
}

/**
 * PostgREST 的逻辑树用 "," 和 "()" 做分隔，关键词里带这些字符会把
 * or=(...) 解析坏掉（PGRST100）。这里按标点切成几段，取最长的一段，
 * 再去掉其余会破坏语法的字符。取不到可用片段时返回空串，走 RPC 兜底。
 */
function sanitizeKeyword(keyword) {
  const base = String(keyword || "").trim();
  if (!base) return "";
  const parts = base
    .split(/[,，、]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const picked = parts.sort((a, b) => b.length - a.length)[0] || base;
  return picked.replace(/[()*"%\\&?=]/g, " ").replace(/\s+/g, " ").trim();
}

/** 从 Content-Range（形如 "0-23/57"、或空集时的星号斜杠 0）里取总数 */
function parseTotal(contentRange) {
  const m = String(contentRange || "").match(/\/(\d+)\s*$/);
  return m ? Number(m[1]) : 0;
}

/** 每次请求动态注入 key，便于失效后热更新 */
function apiHeaders(extra) {
  return {
    apikey: apiKey,
    authorization: `Bearer ${apiKey}`,
    ...(extra || {}),
  };
}

/** 401/403 视为 key 失效 */
function isAuthError(error) {
  const resp = error && error.response;
  if (resp && (resp.status === 401 || resp.status === 403)) return true;
  const data = resp && resp.data;
  const text = typeof data === "string" ? data : data && data.message ? String(data.message) : "";
  return /unauthorized|invalid api key|no api key/i.test(text);
}

/**
 * 从站点公开 JS 里重新抓 publishable key。
 * 站点前端本来就要用它建 Supabase 客户端，所以 key 一定在某个 chunk 里。
 */
async function discoverApiKey() {
  const tryChunk = async (path) => {
    try {
      const url = /^https?:\/\//i.test(path) ? path : HOST + path;
      const { data } = await axiosInstance.get(url, {
        headers: { Accept: "*/*" },
        responseType: "text",
      });
      const m = String(data).match(/sb_publishable_[A-Za-z0-9_]+/);
      return m ? { key: m[0], chunk: path } : null;
    } catch (_) {
      return null;
    }
  };

  // 1) 先试已知 chunk（约 250KB）
  if (apiKeyChunk) {
    const hit = await tryChunk(apiKeyChunk);
    if (hit) return hit;
  }

  // 2) 兜底：拉首页，扫描它引用的全部 chunk
  try {
    const { data: html } = await axiosInstance.get(`${HOST}/`);
    const paths = Array.from(
      new Set(String(html).match(/\/_next\/static\/chunks\/[A-Za-z0-9_.-]+\.js/g) || [])
    );
    for (let i = 0; i < paths.length; i += 6) {
      const hit = (await Promise.all(paths.slice(i, i + 6).map(tryChunk))).find(Boolean);
      if (hit) return hit;
    }
  } catch (e) {
    logError("discover api key failed", e);
  }
  return null;
}

/* ---------------------------- key 获取与缓存 ---------------------------- */

async function cacheGet(key) {
  try {
    return await OmniBox.getCache(key);
  } catch (_) {
    return null;
  }
}

async function cacheSet(key, value, ttl) {
  try {
    await OmniBox.setCache(key, value, ttl);
  } catch (_) {}
}

async function cacheDelete(key) {
  try {
    await OmniBox.deleteCache(key);
  } catch (_) {}
}

/** 从缓存恢复上次抓到的 key，避免每次请求都去扫 JS */
async function loadCachedApiKey() {
  const raw = await cacheGet(API_CACHE_KEY);
  if (!raw) return false;
  let obj = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch (_) {
      return false;
    }
  }
  const key = obj && typeof obj.key === "string" ? obj.key.trim() : "";
  if (!/^sb_publishable_[A-Za-z0-9_]+$/.test(key)) return false;
  apiKey = key;
  apiKeyChunk = typeof obj.chunk === "string" ? obj.chunk : "";
  return true;
}

async function saveCachedApiKey() {
  await cacheSet(
    API_CACHE_KEY,
    JSON.stringify({ key: apiKey, chunk: apiKeyChunk, at: Date.now() }),
    API_KEY_TTL
  );
}

/** 保证 apiKey 可用：内存 -> 缓存 -> 现场抓取 */
async function ensureApiKey() {
  if (apiKey) return true;
  if (await loadCachedApiKey()) return true;

  const hit = await discoverApiKey();
  if (!hit || !hit.key) {
    logError("discover api key failed", "站点 JS 中未找到可用 key");
    return false;
  }
  apiKey = hit.key;
  apiKeyChunk = hit.chunk || "";
  await saveCachedApiKey();
  logInfo("api key discovered", { chunk: apiKeyChunk, tail: apiKey.slice(-6) });
  return true;
}

/** key 失效时丢弃并重抓一次；成功返回 true */
async function refreshApiKey() {
  // 用户显式指定了环境变量时不自动改，避免覆盖用户设置
  if (process.env.XIFAN_API_KEY) return false;
  apiKey = "";
  apiKeyChunk = "";
  await cacheDelete(API_CACHE_KEY);
  return ensureApiKey();
}

/** 统一入口：先确保有 key，401 时刷新并重试一次 */
async function withApi(run) {
  if (!(await ensureApiKey())) throw new Error("未获取到站点 API key");
  try {
    return await run();
  } catch (e) {
    if (isAuthError(e) && (await refreshApiKey())) return await run();
    throw e;
  }
}

/** 带鉴权失效重试的 GET */
function apiGet(url, extraHeaders) {
  return withApi(() => apiInstance.get(url, { headers: apiHeaders(extraHeaders) }));
}

/** 带鉴权失效重试的 POST */
function apiPost(path, body, extraHeaders) {
  return withApi(() => apiInstance.post(path, body, { headers: apiHeaders(extraHeaders) }));
}

/**
 * 兜底搜索：站点自带的联想 RPC，服务端匹配标题/原名/别名/拼音，
 * 对含标点的关键词最稳，但最多只返回 20 条且不能翻页。
 */
async function searchBySuggest(keyword) {
  const { data } = await apiPost("/rest/v1/rpc/suggest_animes", {
    q: keyword,
    lim: 24,
  });
  if (!Array.isArray(data)) return [];
  return data.map(mapApiRow).filter(Boolean);
}

async function search(params = {}) {
  const keyword = String(params.keyword || params.key || params.wd || params.text || "").trim();
  // 只做精准查询，不提供翻页：固定取匹配度最高的前 24 条
  const page = Math.max(Number(params.page || params.pg || 1) || 1, 1);
  if (!keyword) return { page, pagecount: 0, total: 0, limit: 0, list: [], keyword };
  // 调用方要第 2 页及以后时直接返回空，避免重复返回第一页造成列表死循环
  if (page > 1) return { page, pagecount: 1, total: 0, limit: 0, list: [], keyword };

  const safe = sanitizeKeyword(keyword);

  // 主路径：直接查 animes 表，一次取第一页
  if (safe) {
    try {
      const pattern = `*${safe}*`;
      const url =
        `${API_HOST}/rest/v1/animes?select=${SEARCH_SELECT}` +
        `&is_published=eq.true` +
        `&or=(search_title.ilike.${encodeURIComponent(pattern)},` +
        `pinyin_name.ilike.${encodeURIComponent(pattern)})` +
        `&order=bangumi_score.desc.nullslast,view_count.desc` +
        `&limit=${API_PAGE_SIZE}&offset=0`;

      const res = await apiGet(url, { Prefer: "count=exact" });
      const rows = Array.isArray(res.data) ? res.data : [];
      const list = rows.map(mapApiRow).filter(Boolean);
      const matched = parseTotal(res.headers && (res.headers["content-range"] || res.headers["Content-Range"]));

      if (list.length) {
        logInfo("search ok", { keyword, list: list.length, matched });
        return { page: 1, pagecount: 1, limit: API_PAGE_SIZE, total: list.length, list, keyword };
      }
    } catch (e) {
      logError("search via animes table failed", e);
    }
  }

  // 兜底：RPC 联想搜索（关键词含标点或上一步无结果时）
  try {
    const list = await searchBySuggest(keyword);
    logInfo("search ok (rpc)", { keyword, list: list.length });
    return {
      page: 1,
      pagecount: list.length ? 1 : 0,
      limit: list.length,
      total: list.length,
      list,
      keyword,
    };
  } catch (e) {
    logError("search failed", e);
    return { page, pagecount: 0, limit: 0, total: 0, list: [], keyword };
  }
}

async function detail(params = {}) {
  const vodId = pickParamValue(params.vod_id, params.videoId, params.id, params);
  const url = absolutize(vodId);
  if (!url) return { list: [] };

  try {
    const { data: html } = await axiosInstance.get(url);
    const flight = extractFlight(html);

    // 标题与年份：优先用 <title>，格式为 "片名 (2026) · 稀饭动漫 Next"
    const rawTitle = String((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || "").trim();
    let vodName = rawTitle.replace(/\s*·\s*稀饭动漫.*$/i, "").trim();
    let vodYear = "";
    const yearInTitle = vodName.match(/\((\d{4})\)\s*$/);
    if (yearInTitle) {
      vodYear = yearInTitle[1];
      vodName = vodName.replace(/\s*\(\d{4}\)\s*$/, "").trim();
    }

    if (!vodName && flight) {
      const t = flight.match(/"title":"([^"]+)"/);
      if (t) vodName = t[1];
    }

    const posterMatch = flight.match(/"poster":"(https?:\/\/[^"]+)"/);
    const pic = posterMatch ? posterMatch[1].replace(/\\\//g, "/") : "";

    const descMatch = flight.match(/"description":"((?:[^"\\]|\\.)*)"/);
    let content = "";
    if (descMatch) {
      try {
        content = JSON.parse(`"${descMatch[1]}"`).replace(/\\n/g, "\n");
      } catch (_) {
        content = descMatch[1];
      }
    }

    if (!vodYear) {
      const ym = flight.match(/"release_year":(\d{4})/);
      if (ym) vodYear = ym[1];
    }

    // 剧集：sources[].episodes[]
    const sources = extractJsonArray(flight, "sources") || [];
    const animeId = (url.match(/\/anime\/(\d+)/) || [])[1] || "";
    const vodPlaySources = [];

    for (const source of sources) {
      const code = String(source.code || "");
      const episodes = (Array.isArray(source.episodes) ? source.episodes : [])
        .map((ep) => {
          const epId = ep && ep.id;
          if (!epId) return null;
          const num = ep.episode_number;
          const title = String(ep.title || "").trim();
          const name = num ? `第${num}集${title ? " " + title : ""}` : title || String(epId);
          return {
            name,
            playId: `/anime/${animeId}/play/${epId}?source=${code}`,
          };
        })
        .filter(Boolean);

      if (episodes.length) {
        vodPlaySources.push({ name: String(source.name || code || "默认线路"), episodes });
      }
    }

    const currentMatch = flight.match(/"current_episodes":(\d+)/);
    const totalMatch = flight.match(/"total_episodes":(\d+)/);
    const remarks = currentMatch
      ? `更新至 ${currentMatch[1]}${totalMatch ? " / " + totalMatch[1] : ""} 集`
      : "";

    logInfo("detail ok", {
      vodName,
      sources: vodPlaySources.length,
      episodes: vodPlaySources.reduce((n, s) => n + s.episodes.length, 0),
    });

    return {
      list: [
        {
          vod_id: url,
          vod_name: vodName,
          vod_pic: pic,
          vod_remarks: remarks,
          vod_year: vodYear,
          vod_content: content,
          vod_play_sources: vodPlaySources,
        },
      ],
    };
  } catch (e) {
    logError("detail failed", e);
    return { list: [] };
  }
}

async function play(params = {}) {
  const playPath = pickParamValue(params.play_id, params.playId, params.id, params);
  const url = absolutize(playPath);
  if (!url) return { urls: [], parse: 0 };

  const header = {
    "User-Agent": UA,
    Referer: url,
    Origin: HOST,
  };

  // 站点播放页不含直链，优先交给 SDK 嗅探
  try {
    if (typeof OmniBox.sniffVideo === "function") {
      const sniffed = await OmniBox.sniffVideo(url, header);
      const found = typeof sniffed === "string" ? sniffed : sniffed && (sniffed.url || sniffed.playUrl);
      if (found && /^https?:\/\//i.test(found)) {
        logInfo("play sniff ok", { url: String(found).slice(0, 100) });
        return {
          urls: [{ name: "稀饭动漫", url: found }],
          header,
          parse: /\.(m3u8|mp4)(\?|$)/i.test(found) ? 0 : 1,
        };
      }
    }
  } catch (e) {
    logError("sniffVideo failed", e);
  }

  // 兜底：把播放页交给 OmniBox 解析
  logInfo("play fallback to parse", { url });
  return {
    urls: [{ name: "稀饭动漫", url }],
    header,
    parse: 1,
  };
}

module.exports = { home, category, search, detail, play };

runner.run(module.exports);
