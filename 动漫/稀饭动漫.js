// @name 稀饭动漫
// @author
// @description 刮削：支持，弹幕：支持，播放记录：支持
// @dependencies: axios, cheerio
// @version 1.1.0
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
 *
 * 注意：站点搜索结果由前端渲染，服务端 /search?q= 返回空列表。
 *       search() 按站点真实接口实现，站点修复后即可直接生效。
 * ============================================================================
 */

const axios = require("axios");
const cheerio = require("cheerio");
const OmniBox = require("omnibox_sdk");
const runner = require("spider_runner");

// 站点真实 SSR 域名。dm.xifanacg.com 对子路由一律回退到首页，不能用
const HOST = "https://next.xifanacg.com";
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

async function search(params = {}) {
  const keyword = String(params.keyword || params.key || params.wd || "").trim();
  const page = Math.max(Number(params.page || params.pg || 1) || 1, 1);
  if (!keyword) return { page, pagecount: 0, total: 0, list: [], keyword };

  try {
    const { data: html } = await axiosInstance.get(`${HOST}/search?q=${encodeURIComponent(keyword)}`);
    const list = extractCards(html);
    logInfo("search ok", { keyword, list: list.length });
    return {
      page,
      pagecount: list.length ? page : 0,
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
