// ads-mcp — Cloudflare Worker
// Реклама: Яндекс Директ (API v5) + VK Реклама (ads.vk.com) + Google Ads (API v26: отчёты + узкий набор правок — src/google.js).
// URL для коннектора: https://<worker>.workers.dev/<MCP_SECRET>/mcp
// Подключение Google Ads: https://<worker>.workers.dev/<MCP_SECRET>/google
// Секреты: MCP_SECRET,
//   YANDEX_DIRECT_TOKEN (OAuth), YANDEX_DIRECT_LOGIN (Client-Login, опц.),
//   VK_ADS_TOKEN,
//   Google Ads — необязательно (страница /google сохраняет всё в KV): GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET,
//   GOOGLE_ADS_REFRESH_TOKEN, GOOGLE_ADS_LOGIN_CUSTOMER_ID, GOOGLE_ADS_CUSTOMER_ID.

import { GOOGLE_TOOLS, googleRoute, googleTool } from "./google.js";

const PROTOCOL = "2025-06-18";
const MAX_OUT = 50000;

const DIRECT_API = "https://api.direct.yandex.com/json/v5";
const VKADS_API = "https://ads.vk.com/api/v2";

// ---------- инструменты ----------

const TOOLS = [
  {
    name: "direct_campaigns",
    description: "Яндекс Директ: список рекламных кампаний — Id, имя, состояние, статус, тип, дневной бюджет. API v5, сервис campaigns.",
    inputSchema: {
      type: "object",
      properties: {
        states: { type: "array", items: { type: "string" }, description: "Фильтр по состояниям: ON, OFF, SUSPENDED, ENDED, CONVERTED, ARCHIVED" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "direct_keywords",
    description: "Яндекс Директ: ключевые фразы — Id, фраза, кампания, группа, статус, ставка. API v5, сервис keywords.",
    inputSchema: {
      type: "object",
      properties: {
        campaign_ids: { type: "array", items: { type: "integer" }, description: "Фильтр по Id кампаний" },
        limit: { type: "integer", default: 100, description: "Лимит на страницу (макс 10000)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "direct_report",
    description: "Яндекс Директ: отчёт статистики (Reports API, TSV). По умолчанию CAMPAIGN_PERFORMANCE_REPORT за 30 дней: показы, клики, расход, CTR.",
    inputSchema: {
      type: "object",
      properties: {
        report_type: { type: "string", description: "Тип отчёта, напр. CAMPAIGN_PERFORMANCE_REPORT" },
        fields: { type: "array", items: { type: "string" }, description: "Поля отчёта (по умолчанию Date,CampaignName,Impressions,Clicks,Cost,Ctr)" },
        date_range: { type: "string", description: "Период: LAST_30_DAYS, LAST_7_DAYS, TODAY, YESTERDAY, ... (по умолчанию LAST_30_DAYS)" },
        date_from: { type: "string", description: "YYYY-MM-DD (вместе с date_to → CUSTOM_DATE)" },
        date_to: { type: "string", description: "YYYY-MM-DD" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "direct_request",
    description: "Универсальный запрос к Яндекс Директ API v5. service — имя сервиса (campaigns, adgroups, ads, keywords, ...). body — JSON тела (method + params). Токен и заголовки подставляются.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Сервис API, напр. campaigns" },
        body: { type: "object", additionalProperties: true, description: "Тело запроса {method, params}" },
      },
      required: ["service", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "vk_ads_stats",
    description: "VK Реклама (ads.vk.com): дневная статистика — показы, клики, расход. metric: campaigns | banners | ad_plans.",
    inputSchema: {
      type: "object",
      properties: {
        metric: { type: "string", enum: ["campaigns", "banners", "ad_plans"], default: "campaigns" },
        ids: { type: "array", items: { type: "integer" }, description: "Id объектов (опц.)" },
        date_from: { type: "string", description: "YYYY-MM-DD (по умолчанию 30 дней назад)" },
        date_to: { type: "string", description: "YYYY-MM-DD (по умолчанию сегодня)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "vk_ads_request",
    description: "Универсальный запрос к API VK Рекламы (ads.vk.com/api/v2). path относительно /api/v2. Bearer-токен подставляется автоматически.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["GET", "POST"], default: "GET" },
        path: { type: "string", description: "Путь API, напр. /statistics/campaigns/day.json" },
        params: { type: "object", additionalProperties: true, description: "Query-параметры" },
        body: { type: "object", additionalProperties: true, description: "Тело POST-запроса" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  ...GOOGLE_TOOLS,
];

// ---------- утилиты ----------

function cut(s, n = MAX_OUT) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n) + `\n…[обрезано, всего ${s.length} символов]` : s;
}

function pretty(x) {
  return cut(typeof x === "string" ? x : JSON.stringify(x, null, 2));
}

function need(env, key, hint) {
  if (!env[key] || env[key] === "x") throw new Error(`Не задан секрет ${key} у воркера. ${hint}`);
  return env[key];
}

function has(env, key) {
  return Boolean(env[key] && env[key] !== "x");
}

async function jfetch(url, init = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${typeof url === "string" ? url : url.toString()}: ${cut(typeof data === "string" ? data : JSON.stringify(data), 1500)}`);
  return data;
}

function qs(url, query) {
  const u = new URL(url);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) u.searchParams.set(k, v.join(","));
      else u.searchParams.set(k, String(v));
    }
  }
  return u;
}

function daysAgo(n) {
  return new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
}

// direct — вызов Яндекс Директ API v5 (JSON) / Reports (TSV).
async function direct(env, service, body, extraHeaders = {}) {
  const token = need(env, "YANDEX_DIRECT_TOKEN", "OAuth-токен Яндекс Директ: oauth.yandex.ru → приложение с правом Директ → токен.");
  const headers = {
    Authorization: `Bearer ${token}`,
    "Accept-Language": "ru",
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders,
  };
  if (has(env, "YANDEX_DIRECT_LOGIN")) headers["Client-Login"] = env.YANDEX_DIRECT_LOGIN;
  const res = await fetch(`${DIRECT_API}/${service}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(`Direct HTTP ${res.status}: ${cut(typeof data === "string" ? data : JSON.stringify(data), 1500)}`);
  if (data && data.error) throw new Error(`Direct error ${data.error.error_code}: ${data.error.error_string} — ${data.error.error_detail || ""}`);
  return data;
}

// vkads — вызов API VK Рекламы (Bearer).
async function vkads(env, method, path, { params, body } = {}) {
  const token = need(env, "VK_ADS_TOKEN", "Токен VK Рекламы: ads.vk.com → настройки → доступ к API (Bearer-токен).");
  const init = { method, headers: { Authorization: `Bearer ${token}` } };
  if (body) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return jfetch(qs(`${VKADS_API}${path}`, params), init);
}

// ---------- реализация инструментов ----------

async function callTool(name, args, env) {
  switch (name) {
    case "direct_campaigns": {
      const body = { method: "get", params: { SelectionCriteria: {}, FieldNames: ["Id", "Name", "State", "Status", "Type", "DailyBudget"] } };
      if (args.states) body.params.SelectionCriteria.States = args.states;
      const d = await direct(env, "campaigns", body);
      return pretty(d.result || d);
    }

    case "direct_keywords": {
      const body = { method: "get", params: { SelectionCriteria: {}, FieldNames: ["Id", "Keyword", "CampaignId", "AdGroupId", "State", "Status", "Bid"], Page: { Limit: Math.min(args.limit || 100, 10000) } } };
      if (args.campaign_ids) body.params.SelectionCriteria.CampaignIds = args.campaign_ids;
      const d = await direct(env, "keywords", body);
      return pretty(d.result || d);
    }

    case "direct_report": {
      const params = {
        FieldNames: args.fields || ["Date", "CampaignName", "Impressions", "Clicks", "Cost", "Ctr"],
        ReportName: args.report_name || `report_${Date.now()}`,
        ReportType: args.report_type || "CAMPAIGN_PERFORMANCE_REPORT",
        DateRangeType: args.date_range || "LAST_30_DAYS",
        Format: "TSV",
        IncludeVAT: "YES",
      };
      if (args.date_from && args.date_to) {
        params.DateRangeType = "CUSTOM_DATE";
        params.SelectionCriteria = { DateFrom: args.date_from, DateTo: args.date_to };
      } else {
        params.SelectionCriteria = {};
      }
      const d = await direct(env, "reports", { params }, { skipReport: "false", returnMoneyInMicros: "false", processingMode: "auto" });
      return typeof d === "string" ? cut(d) : pretty(d);
    }

    case "direct_request":
      return pretty(await direct(env, args.service, args.body || {}));

    case "vk_ads_stats": {
      const params = { date_from: args.date_from || daysAgo(30), date_to: args.date_to || daysAgo(0) };
      if (args.ids) params.id = Array.isArray(args.ids) ? args.ids.join(",") : args.ids;
      const metric = args.metric || "campaigns";
      return pretty(await vkads(env, "GET", `/statistics/${metric}/day.json`, { params }));
    }

    case "vk_ads_request":
      return pretty(await vkads(env, args.method || "GET", args.path, { params: args.params, body: args.body }));

    default: {
      const g = await googleTool(name, args, env);
      if (g === undefined) throw new Error(`Неизвестный инструмент: ${name}`);
      return pretty(g);
    }
  }
}

// ---------- JSON-RPC 2.0 ----------

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function handleMessage(msg, env) {
  if (!msg || typeof msg !== "object") return rpcError(null, -32600, "Invalid request");
  const { id, method, params } = msg;
  if (id === undefined || id === null) return null;
  try {
    switch (method) {
      case "initialize":
        return rpcResult(id, {
          protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: "ads-mcp", version: "1.1.0" },
        });
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: TOOLS });
      case "resources/list":
        return rpcResult(id, { resources: [] });
      case "prompts/list":
        return rpcResult(id, { prompts: [] });
      case "tools/call": {
        try {
          const text = await callTool(params?.name, params?.arguments ?? {}, env);
          return rpcResult(id, { content: [{ type: "text", text }] });
        } catch (e) {
          return rpcResult(id, { content: [{ type: "text", text: `Ошибка: ${e.message}` }], isError: true });
        }
      }
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    return rpcError(id, -32603, e.message);
  }
}

const JSON_HEADERS = { "Content-Type": "application/json" };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const page = await googleRoute(request, env, parts, url);
    if (page) return page;
    const ok = env.MCP_SECRET && parts.length === 2 && parts[0] === env.MCP_SECRET && parts[1] === "mcp";
    if (!ok) return new Response("Not found", { status: 404 });

    if (request.method === "DELETE") return new Response(null, { status: 204 });
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST, DELETE" } });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify(rpcError(null, -32700, "Parse error")), { status: 400, headers: JSON_HEADERS });
    }

    if (Array.isArray(body)) {
      const out = [];
      for (const msg of body) {
        const r = await handleMessage(msg, env);
        if (r) out.push(r);
      }
      if (!out.length) return new Response(null, { status: 202 });
      return new Response(JSON.stringify(out), { headers: JSON_HEADERS });
    }

    const res = await handleMessage(body, env);
    if (!res) return new Response(null, { status: 202 });
    return new Response(JSON.stringify(res), { headers: JSON_HEADERS });
  },
};
