// Google Ads API — отчёты (только чтение) и узкий набор правок: минус-слова аккаунта, настройки конверсий,
// цели кампаний, закрепление заголовков. Правка без apply: true только проверяется Google (validateOnly).
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
const MATCH = ["PHRASE", "EXACT", "BROAD"];

// ---------- правки ----------
// Только то, что ниже: минус-слова аккаунта, настройки конверсии, цели кампании, закрепление заголовков.
// Всё одной атомарной пачкой через googleAds:mutate; без apply — validateOnly (Google проверяет, ничего не меняя).

async function mutate(env, cid, ops, apply, login) {
  if (!ops.length) return { applied: false, changed: [] };
  const data = await call(env, `/customers/${cid}/googleAds:mutate`, { body: { mutateOperations: ops, validateOnly: !apply }, login });
  const changed = (data?.mutateOperationResponses || []).map((r) => Object.values(r)[0]?.resourceName).filter(Boolean);
  return { applied: Boolean(apply), changed };
}

const idOf = (v, what) => {
  const s = digits(v);
  if (!/^\d+$/.test(s)) throw new Error(`${what} — число`);
  return s;
};

function negativeOf(k) {
  const text = String(typeof k === "string" ? k : k?.text || "").trim().replace(/\s+/g, " ").toLowerCase();
  const match = String((typeof k === "object" && k?.match) || "PHRASE").toUpperCase();
  if (!text || text.length > 80 || text.split(" ").length > 10) throw new Error(`минус-слово «${text}»: 1–80 символов, до 10 слов`);
  if (/[!@%^*()={};~`<>?\\|,]/.test(text)) throw new Error(`минус-слово «${text}»: недопустимый символ`);
  if (!MATCH.includes(match)) throw new Error(`match: ${MATCH.join(", ")}`);
  return { text, match };
}

async function accountNegatives(env, cid, login) {
  const sets = await gaql(env, cid, "SELECT shared_set.resource_name, shared_set.name, shared_set.member_count FROM shared_set WHERE shared_set.type = 'ACCOUNT_LEVEL_NEGATIVE_KEYWORDS' AND shared_set.status = 'ENABLED'", login);
  const attached = new Set((await gaql(env, cid, "SELECT customer_negative_criterion.negative_keyword_list.shared_set FROM customer_negative_criterion WHERE customer_negative_criterion.type = 'NEGATIVE_KEYWORD_LIST'", login))
    .map((r) => r.customerNegativeCriterion?.negativeKeywordList?.sharedSet).filter(Boolean));
  const set = sets.map((r) => r.sharedSet).find((s) => attached.has(s.resourceName)) || sets[0]?.sharedSet || null;
  const items = set
    ? (await gaql(env, cid, `SELECT shared_criterion.resource_name, shared_criterion.keyword.text, shared_criterion.keyword.match_type FROM shared_criterion WHERE shared_set.id = ${set.resourceName.split("/").pop()}`, login))
        .map((r) => ({ resource: r.sharedCriterion.resourceName, text: r.sharedCriterion.keyword?.text, match: r.sharedCriterion.keyword?.matchType }))
        .filter((k) => k.text)
    : [];
  return { set, attached: Boolean(set && attached.has(set.resourceName)), items };
}

async function negativesTool(env, args) {
  const cid = await customerOf(env, args);
  const login = loginOf(args);
  const cur = await accountNegatives(env, cid, login);
  const key = (k) => `${k.match}|${k.text.toLowerCase()}`;
  if (args.action === "list") return { customer_id: cid, list: cur.set?.name || null, attached: cur.attached, count: cur.items.length, keywords: cur.items.map(({ text, match }) => ({ text, match })) };

  const wanted = [...new Map((args.keywords || []).map(negativeOf).map((k) => [key(k), k])).values()];
  if (!wanted.length) throw new Error("keywords — список минус-слов");
  const have = new Map(cur.items.map((k) => [key(k), k]));

  if (args.action === "remove") {
    const found = wanted.filter((k) => have.has(key(k)));
    const res = await mutate(env, cid, found.map((k) => ({ sharedCriterionOperation: { remove: have.get(key(k)).resource } })), args.apply, login);
    return { customer_id: cid, ...res, removed: found, not_found: wanted.filter((k) => !have.has(key(k))) };
  }
  if (args.action !== "add") throw new Error("action: list, add, remove");

  const fresh = wanted.filter((k) => !have.has(key(k)));
  if (cur.items.length + fresh.length > 1000) throw new Error(`на аккаунт — не больше 1000 минус-слов (сейчас ${cur.items.length}, добавляется ${fresh.length})`);
  const ops = [];
  let set = cur.set?.resourceName;
  if (!set) {
    set = `customers/${cid}/sharedSets/-1`;
    ops.push({ sharedSetOperation: { create: { resourceName: set, name: "Account negatives", type: "ACCOUNT_LEVEL_NEGATIVE_KEYWORDS" } } });
  }
  if (!cur.attached) ops.push({ customerNegativeCriterionOperation: { create: { negativeKeywordList: { sharedSet: set } } } });
  for (const k of fresh) ops.push({ sharedCriterionOperation: { create: { sharedSet: set, keyword: { text: k.text, matchType: k.match } } } });
  const res = fresh.length ? await mutate(env, cid, ops, args.apply, login) : { applied: false, changed: [] };
  return { customer_id: cid, ...res, list: cur.set?.name || "Account negatives (новый)", added: fresh, already_there: wanted.filter((k) => have.has(key(k))) };
}

async function conversionTool(env, args) {
  const cid = await customerOf(env, args);
  const login = loginOf(args);
  const id = idOf(args.conversion_action_id, "conversion_action_id");
  const fields = {};
  if (args.phone_call_duration_seconds !== undefined) {
    const s = Number(args.phone_call_duration_seconds);
    if (!Number.isInteger(s) || s < 0 || s > 3600) throw new Error("phone_call_duration_seconds — целое 0…3600");
    fields.phoneCallDurationSeconds = String(s);
  }
  if (args.primary_for_goal !== undefined) fields.primaryForGoal = Boolean(args.primary_for_goal);
  if (!Object.keys(fields).length) throw new Error("Что менять: phone_call_duration_seconds и/или primary_for_goal");
  const [row] = await gaql(env, cid, `SELECT conversion_action.resource_name, conversion_action.name, conversion_action.type, conversion_action.phone_call_duration_seconds, conversion_action.primary_for_goal FROM conversion_action WHERE conversion_action.id = ${id}`, login);
  if (!row) throw new Error(`Конверсия ${id} не найдена`);
  const a = row.conversionAction;
  const res = await mutate(env, cid, [{ conversionActionOperation: { update: { resourceName: a.resourceName, ...fields }, updateMask: Object.keys(fields).join(",") } }], args.apply, login);
  return {
    customer_id: cid, ...res, conversion: a.name, type: a.type,
    before: { phone_call_duration_seconds: Number(a.phoneCallDurationSeconds ?? 0), primary_for_goal: Boolean(a.primaryForGoal) },
    after: { ...(fields.phoneCallDurationSeconds ? { phone_call_duration_seconds: Number(fields.phoneCallDurationSeconds) } : {}), ...("primaryForGoal" in fields ? { primary_for_goal: fields.primaryForGoal } : {}) },
  };
}

async function campaignGoalTool(env, args) {
  const cid = await customerOf(env, args);
  const login = loginOf(args);
  const camp = idOf(args.campaign_id, "campaign_id");
  const category = String(args.category || "").toUpperCase();
  const origin = String(args.origin || "").toUpperCase();
  if (!/^[A-Z_]+$/.test(category) || !/^[A-Z_]+$/.test(origin)) throw new Error("category / origin — как в Google Ads, напр. CONTACT / GOOGLE_HOSTED");
  if (typeof args.biddable !== "boolean") throw new Error("biddable — true или false");
  const resourceName = `customers/${cid}/campaignConversionGoals/${camp}~${category}~${origin}`;
  const [row] = await gaql(env, cid, `SELECT campaign.name, campaign_conversion_goal.biddable FROM campaign_conversion_goal WHERE campaign_conversion_goal.resource_name = '${resourceName}'`, login);
  if (!row) throw new Error(`У кампании ${camp} нет цели ${category} / ${origin}`);
  const res = await mutate(env, cid, [{ campaignConversionGoalOperation: { update: { resourceName, biddable: args.biddable }, updateMask: "biddable" } }], args.apply, login);
  return { customer_id: cid, ...res, campaign: row.campaign?.name, goal: `${category} / ${origin}`, before: Boolean(row.campaignConversionGoal?.biddable), after: args.biddable };
}

async function pinTool(env, args) {
  const cid = await customerOf(env, args);
  const login = loginOf(args);
  const id = idOf(args.ad_id, "ad_id");
  const pos = String(args.position || "").toUpperCase();
  if (!["HEADLINE_1", "HEADLINE_2", "HEADLINE_3", "NONE"].includes(pos)) throw new Error("position: HEADLINE_1, HEADLINE_2, HEADLINE_3 или NONE");
  const texts = new Set((args.texts || []).map(String));
  if (!texts.size) throw new Error("texts — заголовки для закрепления");
  const [row] = await gaql(env, cid, `SELECT ad_group_ad.ad.resource_name, ad_group_ad.ad.type, ad_group_ad.ad.responsive_search_ad.headlines FROM ad_group_ad WHERE ad_group_ad.ad.id = ${id} LIMIT 1`, login);
  const ad = row?.adGroupAd?.ad;
  if (!ad) throw new Error(`Объявление ${id} не найдено`);
  if (ad.type !== "RESPONSIVE_SEARCH_AD") throw new Error(`Объявление ${id} — не адаптивное поисковое (${ad.type})`);
  const current = ad.responsiveSearchAd?.headlines || [];
  const missing = [...texts].filter((t) => !current.some((h) => h.text === t));
  if (missing.length) throw new Error(`Нет таких заголовков в объявлении: ${missing.join(" | ")}`);
  // отправляем весь список (Google заменяет его целиком): тексты те же, меняется только закрепление выбранных
  const headlines = current.map((h) => {
    const pinned = texts.has(h.text) ? (pos === "NONE" ? undefined : pos) : h.pinnedField;
    return pinned ? { text: h.text, pinnedField: pinned } : { text: h.text };
  });
  const res = await mutate(env, cid, [{ adOperation: { update: { resourceName: ad.resourceName, responsiveSearchAd: { headlines } }, updateMask: "responsiveSearchAd.headlines" } }], args.apply, login);
  return { customer_id: cid, ...res, ad_id: id, headlines: headlines.map((h) => (h.pinnedField ? `${h.text}  [${h.pinnedField}]` : h.text)) };
}

async function budgetTool(env, args) {
  const cid = await customerOf(env, args);
  const login = loginOf(args);
  const camp = idOf(args.campaign_id, "campaign_id");
  const amount = Number(args.daily_budget);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) throw new Error("daily_budget — сумма в день в валюте аккаунта, больше 0");
  const [row] = await gaql(env, cid, `SELECT campaign.name, campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.explicitly_shared, campaign_budget.reference_count FROM campaign WHERE campaign.id = ${camp}`, login);
  if (!row?.campaignBudget) throw new Error(`Кампания ${camp} не найдена`);
  const b = row.campaignBudget;
  // общий бюджет меняет сразу все кампании на нём — только с явным shared: true
  const isShared = b.explicitlyShared || Number(b.referenceCount || 1) > 1;
  let sharedWith;
  if (isShared) {
    if (args.shared !== true) throw new Error(`У кампании «${row.campaign.name}» общий бюджет на ${b.referenceCount} кампаний — чтобы изменить его для всех, передайте shared: true`);
    const rows = await gaql(env, cid, `SELECT campaign.name FROM campaign WHERE campaign.campaign_budget = '${b.resourceName}' AND campaign.status != 'REMOVED'`, login);
    sharedWith = rows.map((r) => r.campaign.name);
  }
  const micros = String(Math.round(amount * 100) * 10000);
  const res = await mutate(env, cid, [{ campaignBudgetOperation: { update: { resourceName: b.resourceName, amountMicros: micros }, updateMask: "amount_micros" } }], args.apply, login);
  return { customer_id: cid, ...res, campaign: row.campaign.name, ...(sharedWith ? { shared_with: sharedWith } : {}), before: money(b.amountMicros), after: money(micros) };
}

async function keywordMatchTool(env, args) {
  const cid = await customerOf(env, args);
  const login = loginOf(args);
  const camp = idOf(args.campaign_id, "campaign_id");
  const to = String(args.to_match || "PHRASE").toUpperCase();
  if (!["PHRASE", "EXACT"].includes(to)) throw new Error("to_match: PHRASE или EXACT");
  const only = args.keywords?.length ? new Set(args.keywords.map((t) => String(t).trim().toLowerCase())) : null;
  const rows = await gaql(env, cid, `SELECT ad_group.resource_name, ad_group.name, ad_group_criterion.resource_name, ad_group_criterion.status, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.cpc_bid_micros, ad_group_criterion.final_urls FROM ad_group_criterion WHERE campaign.id = ${camp} AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = FALSE AND ad_group_criterion.status != 'REMOVED' AND ad_group.status != 'REMOVED'`, login);
  const list = rows.map((r) => ({ group: r.adGroup.resourceName, group_name: r.adGroup.name, res: r.adGroupCriterion.resourceName, status: r.adGroupCriterion.status, text: r.adGroupCriterion.keyword.text, match: r.adGroupCriterion.keyword.matchType, bid: r.adGroupCriterion.cpcBidMicros, urls: r.adGroupCriterion.finalUrls }));
  const key = (g, t, m) => `${g}|${t.toLowerCase()}|${m}`;
  const exist = new Map(list.map((k) => [key(k.group, k.text, k.match), k]));
  // переводим только широкое соответствие
  const src = list.filter((k) => k.match === "BROAD" && k.status === "ENABLED" && (!only || only.has(k.text.toLowerCase())));
  if (!src.length) throw new Error(only ? "Среди включённых слов кампании в широком соответствии нет указанных" : "В кампании нет включённых слов в широком соответствии");
  const ops = [];
  const out = [];
  for (const k of src) {
    const twin = exist.get(key(k.group, k.text, to));
    if (twin) {
      // такое слово уже есть — включаем его, новое не создаём
      if (twin.status !== "ENABLED") ops.push({ adGroupCriterionOperation: { update: { resourceName: twin.res, status: "ENABLED" }, updateMask: "status" } });
    } else {
      const create = { adGroup: k.group, status: "ENABLED", keyword: { text: k.text, matchType: to } };
      if (k.bid) create.cpcBidMicros = k.bid;
      if (k.urls?.length) create.finalUrls = k.urls;
      ops.push({ adGroupCriterionOperation: { create } });
    }
    // старое слово — на паузу, не удаляем: откат = включить его обратно
    ops.push({ adGroupCriterionOperation: { update: { resourceName: k.res, status: "PAUSED" }, updateMask: "status" } });
    out.push({ keyword: k.text, ad_group: k.group_name, from: k.match, to, existing: Boolean(twin) });
  }
  const res = await mutate(env, cid, ops, args.apply, login);
  return { customer_id: cid, ...res, campaign_id: camp, switched: out };
}

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
    description: `Google Ads API ${VER}: запрос только на чтение — GET или POST к …:search / …:searchStream. Изменения (mutate) запрещены — для правок есть отдельные инструменты ниже.`,
    inputSchema: obj({
      method: { type: "string", enum: ["GET", "POST"], default: "POST" },
      path: { type: "string", description: "Путь после /v26, напр. /customers/1234567890/googleAds:search" },
      body: { type: "object", additionalProperties: true },
      ...LOGIN,
    }, ["path"]),
  },
  // ---- правки: узкий набор; без apply: true Google только проверяет запрос (validateOnly) и ничего не меняет ----
  {
    name: "google_ads_negative_keywords",
    description: "Google Ads, ПРАВКА: минус-слова на уровне всего аккаунта (действуют на поиск и Performance Max). action=list — показать; add — добавить (список создаётся сам, дубли пропускаются); remove — убрать. Без apply: true — только проверка.",
    inputSchema: obj({
      ...CID, ...LOGIN,
      action: { type: "string", enum: ["list", "add", "remove"] },
      keywords: { type: "array", description: "Слова: строка или {text, match}. match: PHRASE (по умолчанию), EXACT, BROAD", items: { anyOf: [{ type: "string" }, obj({ text: { type: "string" }, match: { type: "string", enum: MATCH } }, ["text"])] } },
      apply: { type: "boolean", description: "true — применить; иначе только проверка" },
    }, ["action"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "google_ads_conversion_update",
    description: "Google Ads, ПРАВКА действия-конверсии: минимальная длительность звонка (сек), после которой он считается конверсией, и/или «основная» (участвует в ставках). Без apply: true — только проверка.",
    inputSchema: obj({
      ...CID, ...LOGIN,
      conversion_action_id: { type: "string" },
      phone_call_duration_seconds: { type: "integer", description: "Для звонков: от скольких секунд считать конверсией" },
      primary_for_goal: { type: "boolean" },
      apply: { type: "boolean", description: "true — применить; иначе только проверка" },
    }, ["conversion_action_id"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "google_ads_campaign_goal",
    description: "Google Ads, ПРАВКА: участвует ли цель (категория + источник) в ставках конкретной кампании, напр. CONTACT + GOOGLE_HOSTED — «клики по кнопке звонка». Без apply: true — только проверка.",
    inputSchema: obj({
      ...CID, ...LOGIN,
      campaign_id: { type: "string" },
      category: { type: "string", description: "Напр. CONTACT, PHONE_CALL_LEAD, PURCHASE, GET_DIRECTIONS" },
      origin: { type: "string", description: "Напр. GOOGLE_HOSTED, CALL_FROM_ADS, WEBSITE" },
      biddable: { type: "boolean" },
      apply: { type: "boolean", description: "true — применить; иначе только проверка" },
    }, ["campaign_id", "category", "origin", "biddable"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "google_ads_pin_headlines",
    description: "Google Ads, ПРАВКА адаптивного поискового объявления: закрепить уже существующие заголовки на позицию (HEADLINE_1…3) или открепить (NONE). Тексты не меняются. Без apply: true — только проверка.",
    inputSchema: obj({
      ...CID, ...LOGIN,
      ad_id: { type: "string" },
      texts: { type: "array", items: { type: "string" }, description: "Точные тексты заголовков из объявления" },
      position: { type: "string", enum: ["HEADLINE_1", "HEADLINE_2", "HEADLINE_3", "NONE"] },
      apply: { type: "boolean", description: "true — применить; иначе только проверка" },
    }, ["ad_id", "texts", "position"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "google_ads_campaign_budget",
    description: "Google Ads, ПРАВКА: дневной бюджет кампании (в валюте аккаунта). Общий бюджет на несколько кампаний меняется только с shared: true (сразу для всех). Без apply: true — только проверка.",
    inputSchema: obj({
      ...CID, ...LOGIN,
      campaign_id: { type: "string" },
      daily_budget: { type: "number", description: "Новый бюджет в день, напр. 60" },
      shared: { type: "boolean", description: "true — разрешить правку общего бюджета (изменится у всех кампаний на нём)" },
      apply: { type: "boolean", description: "true — применить; иначе только проверка" },
    }, ["campaign_id", "daily_budget"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "google_ads_keyword_match",
    description: "Google Ads, ПРАВКА: перевести ключевые слова кампании из широкого (BROAD) в фразовое или точное соответствие. Google не меняет тип у существующего слова, поэтому создаётся копия с новым типом, а старое ставится на паузу (откат — включить старое). keywords пусто — все включённые широкие слова кампании. Без apply: true — только проверка.",
    inputSchema: obj({
      ...CID, ...LOGIN,
      campaign_id: { type: "string" },
      keywords: { type: "array", items: { type: "string" }, description: "Тексты слов (опц.; по умолчанию все)" },
      to_match: { type: "string", enum: ["PHRASE", "EXACT"], description: "По умолчанию PHRASE" },
      apply: { type: "boolean", description: "true — применить; иначе только проверка" },
    }, ["campaign_id"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
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

    case "google_ads_negative_keywords":
      return negativesTool(env, args);
    case "google_ads_conversion_update":
      return conversionTool(env, args);
    case "google_ads_campaign_goal":
      return campaignGoalTool(env, args);
    case "google_ads_pin_headlines":
      return pinTool(env, args);
    case "google_ads_campaign_budget":
      return budgetTool(env, args);
    case "google_ads_keyword_match":
      return keywordMatchTool(env, args);

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
