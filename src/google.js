// Google Ads API — только чтение (отчёты), без изменений в аккаунтах.
// С 9 сентября 2026 developer token не нужен: доступ (Test / Explorer / Basic) выдаётся Google Cloud проекту,
// которому принадлежит OAuth-клиент. Explorer — 2 880 операций в сутки по боевым аккаунтам, для отчётов хватает.
//
// Подключение без ключей в чате: страница /<MCP_SECRET>/google — вписать client ID/secret OAuth-клиента,
// нажать «Войти через Google»; refresh-токен воркер сам кладёт в KV (binding STATE).
// Секреты воркера GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET / GOOGLE_ADS_REFRESH_TOKEN / GOOGLE_ADS_LOGIN_CUSTOMER_ID
// по-прежнему работают и важнее записей в KV.

const VER = "v26";
const API = `https://googleads.googleapis.com/${VER}`;
const SCOPE = "https://www.googleapis.com/auth/adwords openid email";
const CALLBACK = "/oauth/google/callback";
const K = { client: "google:client", refresh: "google:refresh", customer: "google:customer", login: "google:login" };

const has = (env, key) => Boolean(env[key] && env[key] !== "x");
const digits = (v) => String(v ?? "").replace(/[-\s]/g, "");
const kvGet = async (env, key) => (env.STATE ? env.STATE.get(key, "json") : null);
const kvPut = async (env, key, v) => {
  if (!env.STATE) throw new Error("У воркера нет KV (binding STATE) — проверьте wrangler.toml.");
  await env.STATE.put(key, JSON.stringify(v));
};

async function client(env) {
  if (has(env, "GOOGLE_ADS_CLIENT_ID") && has(env, "GOOGLE_ADS_CLIENT_SECRET")) return { id: env.GOOGLE_ADS_CLIENT_ID, secret: env.GOOGLE_ADS_CLIENT_SECRET, from: "secret" };
  const c = await kvGet(env, K.client);
  return c?.id && c?.secret ? { ...c, from: "kv" } : null;
}

async function refresh(env) {
  if (has(env, "GOOGLE_ADS_REFRESH_TOKEN")) return { token: env.GOOGLE_ADS_REFRESH_TOKEN, email: null, at: null, from: "secret" };
  const r = await kvGet(env, K.refresh);
  return r?.token ? { ...r, from: "kv" } : null;
}

async function loginId(env) {
  if (has(env, "GOOGLE_ADS_LOGIN_CUSTOMER_ID")) return digits(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID);
  return (await kvGet(env, K.login)) || null;
}

async function defaultCustomer(env) {
  if (has(env, "GOOGLE_ADS_CUSTOMER_ID")) return digits(env.GOOGLE_ADS_CUSTOMER_ID);
  return (await kvGet(env, K.customer)) || null;
}

async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function apiError(status, data) {
  const e = Array.isArray(data) ? data[0]?.error : data?.error;
  const details = (e?.details || []).flatMap((d) => d.errors || []).map((x) => `${Object.values(x.errorCode || {})[0] || ""}: ${x.message}`).filter(Boolean);
  const msg = details.length ? details.join("; ") : e?.message || (typeof data === "string" ? data.slice(0, 500) : JSON.stringify(data).slice(0, 500));
  const hint = /DEVELOPER_TOKEN|NOT_ALLOWED_FOR_ACCESS_LEVEL|access level/i.test(msg)
    ? " Похоже, у Cloud-проекта уровень Test: в Cloud Console → Google Ads API → Overview нажмите «Apply for access» (Explorer)."
    : /USER_PERMISSION_DENIED|login-customer-id/i.test(msg)
      ? " Если аккаунт доступен через управляющий (MCC), укажите его ID как login_customer_id."
      : "";
  return new Error(`Google Ads HTTP ${status}: ${msg}${hint}`);
}

let tokenCache = { key: "", token: "", exp: 0 };
async function accessToken(env) {
  const c = await client(env);
  if (!c) throw new Error("Google Ads не подключён: откройте страницу /<MCP_SECRET>/google этого воркера и впишите OAuth-клиент.");
  const r = await refresh(env);
  if (!r) throw new Error("Google Ads не подключён: на странице /<MCP_SECRET>/google нажмите «Войти через Google».");
  const key = `${c.id}|${r.token.slice(-12)}`;
  if (tokenCache.key === key && Date.now() < tokenCache.exp - 60000) return tokenCache.token;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: c.id, client_secret: c.secret, refresh_token: r.token }),
  });
  const data = await readJson(res);
  if (!res.ok) {
    if (data?.error === "invalid_grant") throw new Error("Вход в Google истёк или отозван — на странице /<MCP_SECRET>/google войдите заново. (Если приложение в Cloud Console в статусе Testing, токен живёт 7 дней — переведите его в Production.)");
    throw new Error(`Google OAuth HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  tokenCache = { key, token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

async function call(env, path, { method = "POST", body, login } = {}) {
  const headers = { Authorization: `Bearer ${await accessToken(env)}` };
  // developer token больше не обязателен и игнорируется; шлём, только если он задан
  if (has(env, "GOOGLE_ADS_DEVELOPER_TOKEN")) headers["developer-token"] = env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const lid = login === undefined ? await loginId(env) : login;
  if (lid) headers["login-customer-id"] = lid;
  const init = { method, headers };
  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body || {});
  }
  const res = await fetch(`${API}${path}`, init);
  const data = await readJson(res);
  if (!res.ok) throw apiError(res.status, data);
  return data;
}

/** GAQL через searchStream: все строки одним массивом. */
async function gaql(env, cid, query, login) {
  const data = await call(env, `/customers/${cid}/googleAds:searchStream`, { body: { query }, login });
  return (Array.isArray(data) ? data : [data]).flatMap((b) => b.results || []);
}

// ---------- период и проверка ввода (GAQL собирается строкой — только проверенные значения) ----------

const DURING = ["TODAY", "YESTERDAY", "LAST_7_DAYS", "LAST_14_DAYS", "LAST_30_DAYS", "THIS_MONTH", "LAST_MONTH", "THIS_WEEK_MON_TODAY", "LAST_WEEK_MON_SUN"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function period(args) {
  if (args.date_from || args.date_to) {
    const from = args.date_from || args.date_to;
    const to = args.date_to || args.date_from;
    if (!DATE.test(from) || !DATE.test(to)) throw new Error("date_from / date_to — в формате YYYY-MM-DD");
    return { where: `segments.date BETWEEN '${from}' AND '${to}'`, label: `${from}…${to}` };
  }
  const p = String(args.period || "LAST_30_DAYS").toUpperCase();
  if (!DURING.includes(p)) throw new Error(`period: ${DURING.join(", ")} (или date_from/date_to)`);
  return { where: `segments.date DURING ${p}`, label: p };
}

async function customerOf(env, args) {
  const cid = digits(args.customer_id) || (await defaultCustomer(env));
  if (!cid) throw new Error("Укажите customer_id (список — google_ads_accounts).");
  if (!/^\d{6,12}$/.test(cid)) throw new Error("customer_id — 10 цифр, можно с дефисами");
  return cid;
}

function loginOf(args) {
  if (args.login_customer_id === undefined || args.login_customer_id === null || args.login_customer_id === "") return undefined;
  const v = digits(args.login_customer_id);
  if (!/^\d{6,12}$/.test(v)) throw new Error("login_customer_id — 10 цифр");
  return v;
}

function limitOf(args, def, max = 1000) {
  const n = Number(args.limit ?? def);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : def;
}

// ---------- числа ----------

const money = (micros) => Math.round(Number(micros || 0) / 1e4) / 100;
const num = (v) => Math.round(Number(v || 0) * 100) / 100;

function stats(m = {}) {
  const impressions = Number(m.impressions || 0);
  const clicks = Number(m.clicks || 0);
  const cost = money(m.costMicros);
  const conversions = num(m.conversions);
  return {
    impressions,
    clicks,
    cost,
    conversions,
    value: num(m.conversionsValue),
    ctr: impressions ? Math.round((clicks / impressions) * 10000) / 100 : 0,
    cpc: clicks ? Math.round((cost / clicks) * 100) / 100 : 0,
    cpa: conversions ? Math.round((cost / conversions) * 100) / 100 : null,
  };
}

function total(rows) {
  const t = { impressions: 0, clicks: 0, cost: 0, conversions: 0, value: 0 };
  for (const r of rows) for (const k of Object.keys(t)) t[k] += r[k] || 0;
  for (const k of ["cost", "conversions", "value"]) t[k] = Math.round(t[k] * 100) / 100;
  return { ...t, ctr: t.impressions ? Math.round((t.clicks / t.impressions) * 10000) / 100 : 0, cpc: t.clicks ? Math.round((t.cost / t.clicks) * 100) / 100 : 0, cpa: t.conversions ? Math.round((t.cost / t.conversions) * 100) / 100 : null };
}

const METRICS = "metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value";

// ---------- инструменты ----------

const CID = { customer_id: { type: "string", description: "ID аккаунта Google Ads (можно с дефисами). Пусто — аккаунт по умолчанию, выбранный при подключении." } };
const LOGIN = { login_customer_id: { type: "string", description: "ID управляющего аккаунта (MCC), если доступ к аккаунту через него (опц.)" } };
const PERIOD = {
  period: { type: "string", enum: DURING, description: "Период (по умолчанию LAST_30_DAYS)" },
  date_from: { type: "string", description: "YYYY-MM-DD (вместо period)" },
  date_to: { type: "string", description: "YYYY-MM-DD" },
};
const obj = (properties, required) => ({ type: "object", properties, ...(required ? { required } : {}), additionalProperties: false });

export const GOOGLE_TOOLS = [
  {
    name: "google_ads_status",
    description: "Google Ads: подключён ли (OAuth-клиент, вход в Google, аккаунт по умолчанию). Ключей не показывает.",
    inputSchema: obj({}),
  },
  {
    name: "google_ads_accounts",
    description: "Google Ads: аккаунты, доступные подключённому Google-пользователю — ID, название, валюта, часовой пояс, управляющий ли (у MCC — подчинённые аккаунты).",
    inputSchema: obj({}),
  },
  {
    name: "google_ads_campaigns",
    description: "Google Ads: кампании за период — статус, тип, дневной бюджет, показы, клики, расход, CTR, CPC, конверсии, ценность, цена конверсии. Деньги — в валюте аккаунта.",
    inputSchema: obj({ ...CID, ...LOGIN, ...PERIOD, include_removed: { type: "boolean", description: "Показать и удалённые кампании" } }),
  },
  {
    name: "google_ads_daily",
    description: "Google Ads: статистика по дням (весь аккаунт или одна кампания) — показы, клики, расход, конверсии.",
    inputSchema: obj({ ...CID, ...LOGIN, ...PERIOD, campaign_id: { type: "string", description: "ID кампании (опц.)" } }),
  },
  {
    name: "google_ads_search_terms",
    description: "Google Ads: реальные поисковые запросы, по которым показывались объявления — клики, расход, конверсии. Сортировка по расходу.",
    inputSchema: obj({ ...CID, ...LOGIN, ...PERIOD, campaign_id: { type: "string", description: "ID кампании (опц.)" }, limit: { type: "integer", description: "Сколько строк (по умолчанию 50, макс 1000)" } }),
  },
  {
    name: "google_ads_keywords",
    description: "Google Ads: ключевые слова — текст, тип соответствия, статус, показатель качества, показы, клики, расход, конверсии. Сортировка по расходу.",
    inputSchema: obj({ ...CID, ...LOGIN, ...PERIOD, campaign_id: { type: "string", description: "ID кампании (опц.)" }, limit: { type: "integer", description: "Сколько строк (по умолчанию 100, макс 1000)" } }),
  },
  {
    name: "google_ads_conversions",
    description: "Google Ads: действия-конверсии — название, статус, категория, основная ли для целей, источник, и send_to (AW-…/метка) для тега на сайте.",
    inputSchema: obj({ ...CID, ...LOGIN }),
  },
  {
    name: "google_ads_search",
    description: "Google Ads: произвольный GAQL-запрос (только чтение, searchStream), напр. SELECT campaign.name, metrics.clicks FROM campaign WHERE segments.date DURING LAST_7_DAYS.",
    inputSchema: obj({ ...CID, ...LOGIN, query: { type: "string", description: "GAQL" } }, ["query"]),
  },
  {
    name: "google_ads_request",
    description: `Google Ads API ${VER}: запрос только на чтение — GET или POST к …:search / …:searchStream. Изменения (mutate) запрещены.`,
    inputSchema: obj({
      method: { type: "string", enum: ["GET", "POST"], default: "POST" },
      path: { type: "string", description: "Путь после /v26, напр. /customers/1234567890/googleAds:search" },
      body: { type: "object", additionalProperties: true },
      ...LOGIN,
    }, ["path"]),
  },
];

export async function googleTool(name, args, env) {
  switch (name) {
    case "google_ads_status": {
      const [c, r, cid, lid] = await Promise.all([client(env), refresh(env), defaultCustomer(env), loginId(env)]);
      return {
        api: VER,
        oauth_client: c ? `задан (${c.from === "kv" ? "страница /google" : "секрет воркера"})` : "нет",
        google_login: r ? { email: r.email, connected_at: r.at, source: r.from === "kv" ? "страница /google" : "секрет воркера" } : "нет",
        default_customer_id: cid,
        login_customer_id: lid,
        ready: Boolean(c && r),
        note: "Доступ к боевым аккаунтам даёт уровень Explorer у Google Cloud проекта OAuth-клиента (Cloud Console → Google Ads API → Overview). Developer token не нужен.",
      };
    }

    case "google_ads_accounts": {
      const list = await call(env, "/customers:listAccessibleCustomers", { method: "GET", login: null });
      const ids = (list.resourceNames || []).map((n) => n.split("/")[1]);
      const out = [];
      for (const id of ids) {
        try {
          const [row] = await gaql(env, id, "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, customer.test_account, customer.status FROM customer LIMIT 1", null);
          const c = row?.customer || {};
          const item = { id, name: c.descriptiveName || null, currency: c.currencyCode, time_zone: c.timeZone, manager: Boolean(c.manager), test: Boolean(c.testAccount), status: c.status };
          if (c.manager) {
            const kids = await gaql(env, id, "SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, customer_client.status, customer_client.currency_code FROM customer_client WHERE customer_client.level = 1", id);
            item.clients = kids.map((k) => ({ id: String(k.customerClient.id), name: k.customerClient.descriptiveName || null, manager: Boolean(k.customerClient.manager), status: k.customerClient.status, currency: k.customerClient.currencyCode }));
          }
          out.push(item);
        } catch (e) {
          out.push({ id, error: e.message });
        }
      }
      return { default_customer_id: await defaultCustomer(env), accounts: out };
    }

    case "google_ads_campaigns": {
      const cid = await customerOf(env, args);
      const p = period(args);
      const where = [p.where, ...(args.include_removed ? [] : ["campaign.status != 'REMOVED'"])].join(" AND ");
      const rows = await gaql(env, cid, `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign_budget.amount_micros, ${METRICS} FROM campaign WHERE ${where} ORDER BY metrics.cost_micros DESC`, loginOf(args));
      const items = rows.map((r) => ({
        id: String(r.campaign.id),
        name: r.campaign.name,
        status: r.campaign.status,
        type: r.campaign.advertisingChannelType,
        bidding: r.campaign.biddingStrategyType,
        daily_budget: r.campaignBudget ? money(r.campaignBudget.amountMicros) : null,
        ...stats(r.metrics),
      }));
      return { customer_id: cid, period: p.label, total: total(items), campaigns: items };
    }

    case "google_ads_daily": {
      const cid = await customerOf(env, args);
      const p = period(args);
      const camp = args.campaign_id ? digits(args.campaign_id) : "";
      if (camp && !/^\d+$/.test(camp)) throw new Error("campaign_id — число");
      const q = camp
        ? `SELECT segments.date, ${METRICS} FROM campaign WHERE ${p.where} AND campaign.id = ${camp} ORDER BY segments.date`
        : `SELECT segments.date, ${METRICS} FROM customer WHERE ${p.where} ORDER BY segments.date`;
      const items = (await gaql(env, cid, q, loginOf(args))).map((r) => ({ date: r.segments.date, ...stats(r.metrics) }));
      return { customer_id: cid, period: p.label, campaign_id: camp || null, total: total(items), days: items };
    }

    case "google_ads_search_terms": {
      const cid = await customerOf(env, args);
      const p = period(args);
      const camp = args.campaign_id ? digits(args.campaign_id) : "";
      if (camp && !/^\d+$/.test(camp)) throw new Error("campaign_id — число");
      const rows = await gaql(env, cid, `SELECT search_term_view.search_term, search_term_view.status, campaign.name, ad_group.name, ${METRICS} FROM search_term_view WHERE ${p.where}${camp ? ` AND campaign.id = ${camp}` : ""} ORDER BY metrics.cost_micros DESC LIMIT ${limitOf(args, 50)}`, loginOf(args));
      return {
        customer_id: cid,
        period: p.label,
        terms: rows.map((r) => ({ term: r.searchTermView.searchTerm, status: r.searchTermView.status, campaign: r.campaign?.name, ad_group: r.adGroup?.name, ...stats(r.metrics) })),
      };
    }

    case "google_ads_keywords": {
      const cid = await customerOf(env, args);
      const p = period(args);
      const camp = args.campaign_id ? digits(args.campaign_id) : "";
      if (camp && !/^\d+$/.test(camp)) throw new Error("campaign_id — число");
      const rows = await gaql(env, cid, `SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, ad_group_criterion.quality_info.quality_score, campaign.name, ad_group.name, ${METRICS} FROM keyword_view WHERE ${p.where} AND ad_group_criterion.status != 'REMOVED'${camp ? ` AND campaign.id = ${camp}` : ""} ORDER BY metrics.cost_micros DESC LIMIT ${limitOf(args, 100)}`, loginOf(args));
      return {
        customer_id: cid,
        period: p.label,
        keywords: rows.map((r) => ({
          keyword: r.adGroupCriterion.keyword?.text,
          match: r.adGroupCriterion.keyword?.matchType,
          status: r.adGroupCriterion.status,
          quality: r.adGroupCriterion.qualityInfo?.qualityScore ?? null,
          campaign: r.campaign?.name,
          ad_group: r.adGroup?.name,
          ...stats(r.metrics),
        })),
      };
    }

    case "google_ads_conversions": {
      const cid = await customerOf(env, args);
      const rows = await gaql(env, cid, "SELECT conversion_action.id, conversion_action.name, conversion_action.status, conversion_action.type, conversion_action.category, conversion_action.primary_for_goal, conversion_action.counting_type, conversion_action.origin, conversion_action.tag_snippets FROM conversion_action WHERE conversion_action.status != 'REMOVED'", loginOf(args));
      return {
        customer_id: cid,
        conversions: rows.map((r) => {
          const a = r.conversionAction;
          const snippet = (a.tagSnippets || []).map((t) => t.eventSnippet || "").join("\n");
          const sendTo = [...new Set([...snippet.matchAll(/send_to['"]?\s*:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]))];
          return { id: String(a.id), name: a.name, status: a.status, type: a.type, category: a.category, primary: Boolean(a.primaryForGoal), counting: a.countingType, origin: a.origin, send_to: sendTo };
        }),
      };
    }

    case "google_ads_search": {
      const cid = await customerOf(env, args);
      const q = String(args.query || "").trim();
      if (!/^select\s/i.test(q)) throw new Error("query — GAQL, начинается с SELECT");
      return { customer_id: cid, rows: await gaql(env, cid, q, loginOf(args)) };
    }

    case "google_ads_request": {
      const method = (args.method || "POST").toUpperCase();
      const path = String(args.path || "");
      if (!path.startsWith("/") || /\.\.|\?/.test(path)) throw new Error("path — путь API от /v26, без ?.. и ..");
      // только чтение: GET или поиск; любые mutate/upload/apply запрещены
      if (method === "POST" ? !/:(search|searchStream)$/.test(path) : method !== "GET") throw new Error("Разрешено только чтение: GET или POST к …:search / …:searchStream");
      return call(env, path, { method, body: args.body, login: loginOf(args) });
    }

    default:
      return undefined;
  }
}

// ---------- страница подключения и OAuth ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function sign(env, text) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`google-oauth:${env.MCP_SECRET}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
}

async function makeState(env) {
  const body = b64u(new TextEncoder().encode(JSON.stringify({ exp: Date.now() + 15 * 60000, n: crypto.randomUUID() })));
  return `${body}.${await sign(env, body)}`;
}

async function checkState(env, state) {
  const [body, sig] = String(state || "").split(".");
  if (!body || !sig || sig !== (await sign(env, body))) return false;
  try {
    const { exp } = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
    return Date.now() < exp;
  } catch {
    return false;
  }
}

function page(title, inner, status = 200) {
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title><style>
body{font:15px/1.5 system-ui,sans-serif;max-width:640px;margin:32px auto;padding:0 16px;color:#1d1d1f;background:#fff}
h1{font-size:22px}label{display:block;margin:12px 0 4px;font-weight:600}input{width:100%;box-sizing:border-box;padding:9px;border:1px solid #bbb;border-radius:8px;font:inherit}
button,.btn{display:inline-block;margin-top:16px;padding:10px 18px;border:0;border-radius:8px;background:#1a73e8;color:#fff;font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
code{background:#f1f3f4;padding:2px 5px;border-radius:4px;word-break:break-all}.ok{color:#188038}.bad{color:#c5221f}.box{background:#f8f9fa;border-radius:10px;padding:12px 14px;margin:14px 0}
@media (prefers-color-scheme:dark){body{background:#121212;color:#eee}code,.box{background:#222}input{background:#1b1b1b;color:#eee;border-color:#444}}
</style></head><body>${inner}</body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}

async function setupPage(env, origin, note = "") {
  const [c, r, cid] = await Promise.all([client(env), refresh(env), defaultCustomer(env)]);
  const lid = await loginId(env);
  const redirect = `${origin}${CALLBACK}`;
  return page("Google Ads — подключение", `<h1>Google Ads → ads-mcp</h1>${note}
<div class="box">OAuth-клиент: ${c ? `<b class="ok">задан</b> (${esc(c.id.slice(0, 12))}…)` : '<b class="bad">нет</b>'}<br>
Вход в Google: ${r ? `<b class="ok">есть</b>${r.email ? ` — ${esc(r.email)}` : ""}` : '<b class="bad">нет</b>'}<br>
Аккаунт по умолчанию: ${cid ? esc(cid) : "—"}${lid ? ` · через MCC ${esc(lid)}` : ""}</div>
${c ? `<a class="btn" href="google/connect">${r ? "Войти через Google заново" : "Войти через Google"}</a>` : ""}
<form method="post">
<label>OAuth client ID</label><input name="client_id" autocomplete="off" placeholder="…apps.googleusercontent.com" ${c?.from === "secret" ? "disabled" : ""}>
<label>OAuth client secret</label><input name="client_secret" type="password" autocomplete="off" ${c?.from === "secret" ? "disabled" : ""}>
<label>ID аккаунта по умолчанию (необязательно)</label><input name="customer_id" placeholder="123-456-7890" value="${esc(cid || "")}">
<label>ID управляющего аккаунта MCC (необязательно)</label><input name="login_customer_id" placeholder="если доступ через MCC" value="${esc(lid || "")}">
<button type="submit">Сохранить${c ? "" : " и войти через Google"}</button></form>
<p class="box">В Google Cloud Console у OAuth-клиента (тип «Web application») в «Authorized redirect URIs» должен быть:<br><code>${esc(redirect)}</code><br>
Экран согласия — опубликован (In production), иначе вход живёт 7 дней. Пустое поле client secret при сохранении не стирает уже сохранённый.</p>`);
}

/** Маршруты страницы подключения. null — не наш путь. */
export async function googleRoute(request, env, parts, url) {
  const origin = url.origin;
  const secretOk = env.MCP_SECRET && parts[0] === env.MCP_SECRET;

  if (secretOk && parts.length === 2 && parts[1] === "google") {
    if (request.method === "POST") {
      const f = await request.formData();
      const id = String(f.get("client_id") || "").trim();
      const secret = String(f.get("client_secret") || "").trim();
      const cid = digits(f.get("customer_id"));
      const lid = digits(f.get("login_customer_id"));
      if ((cid && !/^\d{6,12}$/.test(cid)) || (lid && !/^\d{6,12}$/.test(lid))) return setupPage(env, origin, '<p class="bad">ID аккаунта — 10 цифр.</p>');
      const old = await kvGet(env, K.client);
      if (id || secret) {
        if (!/\.apps\.googleusercontent\.com$/.test(id || old?.id || "")) return setupPage(env, origin, '<p class="bad">Client ID должен заканчиваться на .apps.googleusercontent.com</p>');
        await kvPut(env, K.client, { id: id || old.id, secret: secret || old?.secret || "" });
      }
      if (cid) await kvPut(env, K.customer, cid);
      else if (env.STATE) await env.STATE.delete(K.customer);
      if (lid) await kvPut(env, K.login, lid);
      else if (env.STATE) await env.STATE.delete(K.login);
      const [c, r] = await Promise.all([client(env), refresh(env)]);
      if (c?.secret && !r) return Response.redirect(`${origin}/${parts[0]}/google/connect`, 303);
      return setupPage(env, origin, '<p class="ok">Сохранено.</p>');
    }
    return setupPage(env, origin);
  }

  if (secretOk && parts.length === 3 && parts[1] === "google" && parts[2] === "connect") {
    const c = await client(env);
    if (!c?.secret) return setupPage(env, origin, '<p class="bad">Сначала впишите client ID и secret.</p>');
    const q = new URLSearchParams({
      client_id: c.id,
      redirect_uri: `${origin}${CALLBACK}`,
      response_type: "code",
      scope: SCOPE,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state: await makeState(env),
    });
    return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${q}`, 302);
  }

  if (url.pathname === CALLBACK) {
    if (!(await checkState(env, url.searchParams.get("state")))) return page("Ошибка", "<h1>Ссылка устарела</h1><p>Откройте страницу подключения и нажмите «Войти через Google» ещё раз.</p>", 400);
    if (url.searchParams.get("error")) return page("Отменено", `<h1>Вход отменён</h1><p>${esc(url.searchParams.get("error"))}</p>`, 400);
    const c = await client(env);
    if (!c?.secret) return page("Ошибка", "<h1>Нет OAuth-клиента</h1>", 400);
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: url.searchParams.get("code") || "", client_id: c.id, client_secret: c.secret, redirect_uri: `${origin}${CALLBACK}` }),
    });
    const data = await readJson(res);
    if (!res.ok) return page("Ошибка", `<h1>Google не выдал токен</h1><p>${esc(data?.error_description || data?.error || res.status)}</p>`, 400);
    if (!/adwords/.test(data.scope || "")) return page("Ошибка", "<h1>Нет доступа к Google Ads</h1><p>На экране согласия оставьте галочку «Google Ads».</p>", 400);
    if (!data.refresh_token) return page("Ошибка", '<h1>Google не прислал refresh-токен</h1><p>Удалите доступ приложения в <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a> и войдите ещё раз.</p>', 400);
    let email = null;
    try {
      email = JSON.parse(atob(data.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).email || null;
    } catch {}
    await kvPut(env, K.refresh, { token: data.refresh_token, email, at: new Date().toISOString() });
    tokenCache = { key: "", token: "", exp: 0 };
    // какие аккаунты видны; если один — он и будет по умолчанию
    let list = "";
    try {
      const r = await googleTool("google_ads_accounts", {}, env);
      const plain = r.accounts.filter((a) => !a.error && !a.manager);
      if (!(await defaultCustomer(env)) && plain.length === 1) await kvPut(env, K.customer, plain[0].id);
      list = `<div class="box"><b>Аккаунты:</b><br>${r.accounts.map((a) => (a.error ? `${esc(a.id)} — <span class="bad">${esc(a.error)}</span>` : `${esc(a.id)} — ${esc(a.name || "без названия")} (${esc(a.currency)})${a.manager ? ` · MCC: ${(a.clients || []).map((k) => `${esc(k.id)} ${esc(k.name || "")}`).join(", ")}` : ""}`)).join("<br>")}</div>`;
    } catch (e) {
      list = `<p class="bad">Вход сохранён, но список аккаунтов не получен: ${esc(e.message)}</p>`;
    }
    return page("Подключено", `<h1 class="ok">Google Ads подключён</h1><p>${email ? `Вход: ${esc(email)}. ` : ""}Окно можно закрыть.</p>${list}`);
  }

  return null;
}
