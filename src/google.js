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
const DAYS_ENUM = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];

// ---------- правки ----------
// Только то, что ниже: минус-слова аккаунта и кампании, настройки и создание конверсии, цели кампании, бюджет, соответствие
// ключевых слов, места показа, тексты и ссылки объявлений, быстрые ссылки и уточнения. Удаления кампаний, групп и объявлений нет.
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

// ---------- расписание показов и бюджет по дням недели ----------

const DAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];
const hourOf = (v, what) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 24) throw new Error(`${what} — целый час 0…24`);
  return n;
};

async function scheduleTool(env, args) {
  const cid = await customerOf(env, args);
  const login = loginOf(args);
  const ids = (args.campaign_ids || []).map((v) => idOf(v, "campaign_ids"));
  const where = ids.length ? ` AND campaign.id IN (${ids.join(",")})` : "";
  const rows = await gaql(env, cid, `SELECT campaign.id, campaign.name, campaign_criterion.resource_name, campaign_criterion.ad_schedule.day_of_week, campaign_criterion.ad_schedule.start_hour, campaign_criterion.ad_schedule.start_minute, campaign_criterion.ad_schedule.end_hour, campaign_criterion.ad_schedule.end_minute, campaign_criterion.bid_modifier FROM campaign_criterion WHERE campaign_criterion.type = 'AD_SCHEDULE' AND campaign.status != 'REMOVED'${where}`, login);
  const cur = rows.map((r) => ({
    campaign: r.campaign.id, name: r.campaign.name, resource: r.campaignCriterion.resourceName,
    day: r.campaignCriterion.adSchedule.dayOfWeek, start: Number(r.campaignCriterion.adSchedule.startHour || 0), end: Number(r.campaignCriterion.adSchedule.endHour || 0),
    startMin: r.campaignCriterion.adSchedule.startMinute, endMin: r.campaignCriterion.adSchedule.endMinute,
    bid: r.campaignCriterion.bidModifier,
  }));
  const show = (list) => list.map((x) => `${x.name}: ${x.day} ${x.start}:00–${x.end}:00${x.bid && x.bid !== 1 ? ` (ставка ×${x.bid})` : ""}`);
  if ((args.action || "list") === "list") return { customer_id: cid, schedule: show(cur) };
  if (args.action !== "set") throw new Error("action: list или set");
  if (!ids.length) throw new Error("campaign_ids — какие кампании менять");
  const start = hourOf(args.start_hour, "start_hour");
  const end = hourOf(args.end_hour, "end_hour");
  if (end <= start) throw new Error("end_hour должен быть позже start_hour");
  const ops = [];
  const after = [];
  for (const camp of ids) {
    const mine = cur.filter((x) => x.campaign === camp);
    // нет расписания — показы круглосуточно; создаём на все 7 дней
    const base = mine.length ? mine : DAYS.map((day) => ({ campaign: camp, name: camp, day, start: -1, end: -1, bid: undefined }));
    for (const x of base) {
      if (x.start === start && x.end === end && x.startMin === "ZERO" && x.endMin === "ZERO") { after.push(x); continue; }
      // день и часы у расписания не меняются — удаляем и создаём заново с той же поправкой ставки
      if (x.resource) ops.push({ campaignCriterionOperation: { remove: x.resource } });
      ops.push({ campaignCriterionOperation: { create: {
        campaign: `customers/${cid}/campaigns/${camp}`,
        adSchedule: { dayOfWeek: x.day, startHour: start, startMinute: "ZERO", endHour: end, endMinute: "ZERO" },
        ...(x.bid && x.bid !== 1 ? { bidModifier: x.bid } : {}),
      } } });
      after.push({ ...x, start, end });
    }
  }
  const res = await mutate(env, cid, ops, args.apply, login);
  return { customer_id: cid, ...res, before: show(cur.filter((x) => ids.includes(x.campaign))), after: show(after) };
}

const PLAN = "budget_plan";
const PLAN_LOG = "budget_plan_log";

async function accountDay(env, plan) {
  const tz = plan.time_zone || "Europe/Warsaw";
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(new Date()).toUpperCase();
}

/** Ставит бюджеты плана на текущий день недели (в часовом поясе аккаунта). Повторный запуск ничего не меняет. */
export async function runBudgetPlan(env, opts = {}) {
  const plan = opts.plan || (await kvGet(env, PLAN));
  if (!plan?.items?.length) return null;
  const day = await accountDay(env, plan);
  const weekend = (plan.weekend_days || []).includes(day);
  const results = [];
  for (const it of plan.items) {
    const target = weekend ? it.weekend : it.weekday;
    try {
      const [row] = await gaql(env, plan.customer_id, `SELECT campaign.name, campaign_budget.amount_micros FROM campaign WHERE campaign.id = ${idOf(it.campaign_id, "campaign_id")}`, plan.login_customer_id);
      const now = money(row?.campaignBudget?.amountMicros);
      if (Math.abs(now - target) < 0.01) { results.push({ campaign: row?.campaign?.name || it.campaign_id, budget: now, changed: false }); continue; }
      const r = await budgetTool(env, { customer_id: plan.customer_id, login_customer_id: plan.login_customer_id, campaign_id: it.campaign_id, daily_budget: target, shared: Boolean(it.shared), apply: opts.apply !== false });
      results.push({ campaign: r.campaign, before: r.before, budget: r.after, changed: r.applied });
    } catch (e) {
      results.push({ campaign: it.campaign_id, error: String(e.message || e).slice(0, 300) });
    }
  }
  const log = { at: new Date().toISOString(), day, weekend, results };
  if (opts.apply !== false && env.STATE) await kvPut(env, PLAN_LOG, log);
  return log;
}

async function budgetPlanTool(env, args) {
  const action = args.action || "show";
  if (action === "show") {
    const [plan, last] = await Promise.all([kvGet(env, PLAN), kvGet(env, PLAN_LOG)]);
    return { plan: plan || "нет плана — бюджеты не меняются по дням", last_run: last };
  }
  if (action === "clear") {
    if (args.apply) await env.STATE.delete(PLAN);
    return { applied: Boolean(args.apply), plan: null, note: "бюджеты остаются такими, какие стоят сейчас" };
  }
  if (action === "run") {
    const plan = await kvGet(env, PLAN);
    if (!plan) throw new Error("плана нет — сначала action=set");
    const log = await runBudgetPlan(env, { plan, apply: Boolean(args.apply) });
    return { applied: Boolean(args.apply), ...log };
  }
  if (action !== "set") throw new Error("action: show, set, run или clear");
  const cid = await customerOf(env, args);
  const login = loginOf(args);
  const weekendDays = (args.weekend_days?.length ? args.weekend_days : ["FRIDAY", "SATURDAY", "SUNDAY"]).map((d) => String(d).toUpperCase());
  if (weekendDays.some((d) => !DAYS.includes(d))) throw new Error(`weekend_days: ${DAYS.join(", ")}`);
  const items = (args.items || []).map((it) => {
    const weekday = Number(it.weekday);
    const weekend = Number(it.weekend);
    if (!(weekday > 0 && weekend > 0 && weekday <= 100000 && weekend <= 100000)) throw new Error("items: weekday и weekend — бюджет в день, больше 0");
    return { campaign_id: idOf(it.campaign_id, "campaign_id"), weekday, weekend, shared: Boolean(it.shared) };
  });
  if (!items.length) throw new Error("items — [{campaign_id, weekday, weekend, shared?}]");
  const [tzRow] = await gaql(env, cid, "SELECT customer.time_zone FROM customer LIMIT 1", login);
  // проверка: каждая правка проходит validateOnly (кампания есть, общий бюджет помечен shared)
  for (const it of items) {
    await budgetTool(env, { customer_id: cid, login_customer_id: login, campaign_id: it.campaign_id, daily_budget: it.weekday, shared: it.shared });
  }
  const plan = { customer_id: cid, login_customer_id: login, time_zone: tzRow?.customer?.timeZone || "Europe/Warsaw", weekend_days: weekendDays, items, saved_at: new Date().toISOString() };
  if (!args.apply) return { applied: false, plan };
  await kvPut(env, PLAN, plan);
  const now = await runBudgetPlan(env, { plan });
  return { applied: true, plan, now };
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

// ---- места показа, минус-слова кампании, тексты и ссылки объявлений, расширения, новая конверсия ----

const bare = (h) => String(h || "").toLowerCase().replace(/^www\./, "");
const len = (t) => [...String(t)].length;

// хосты сайта рекламодателя — из ссылок включённых объявлений и групп объектов; новые ссылки только на них
async function ownHosts(env, cid, login) {
  const ads = await gaql(env, cid, "SELECT ad_group_ad.ad.final_urls FROM ad_group_ad WHERE ad_group_ad.status = 'ENABLED' AND campaign.status = 'ENABLED'", login);
  const groups = await gaql(env, cid, "SELECT asset_group.final_urls FROM asset_group WHERE asset_group.status = 'ENABLED' AND campaign.status = 'ENABLED'", login);
  const hosts = new Set();
  for (const u of [...ads.flatMap((r) => r.adGroupAd?.ad?.finalUrls || []), ...groups.flatMap((r) => r.assetGroup?.finalUrls || [])]) {
    try { hosts.add(bare(new URL(u).host)); } catch { /* битая ссылка — пропускаем */ }
  }
  return hosts;
}

async function siteUrl(env, cid, login, u, hosts) {
  let x;
  try { x = new URL(String(u || "")); } catch { throw new Error(`«${u}» — не ссылка`); }
  if (x.protocol !== "https:" || x.username || x.password) throw new Error(`«${u}» — нужна ссылка https без логина`);
  const own = hosts || (await ownHosts(env, cid, login));
  if (!own.has(bare(x.host))) throw new Error(`«${u}» — не на сайте рекламодателя (${[...own].join(", ") || "нет включённых объявлений"})`);
  return x.toString();
}

async function geoTool(env, args) {
  const cid = await customerOf(env, args);
  const login = loginOf(args);
  const camp = idOf(args.campaign_id, "campaign_id");
  const rows = await gaql(env, cid, `SELECT campaign.id, campaign_criterion.resource_name, campaign_criterion.negative, campaign_criterion.location.geo_target_constant FROM campaign_criterion WHERE campaign.id = ${camp} AND campaign_criterion.type = 'LOCATION'`, login);
  const cur = rows.map((r) => ({ res: r.campaignCriterion.resourceName, geo: r.campaignCriterion.location.geoTargetConstant.split("/").pop(), negative: Boolean(r.campaignCriterion.negative) }));
  const ids = [...new Set((args.location_ids || []).map((v) => idOf(v, "location_ids")))];
  const all = [...new Set([...ids, ...cur.map((c) => c.geo)])];
  const names = new Map(all.length
    ? (await gaql(env, cid, `SELECT geo_target_constant.id, geo_target_constant.canonical_name, geo_target_constant.status FROM geo_target_constant WHERE geo_target_constant.id IN (${all.join(",")})`, login)).map((g) => [String(g.geoTargetConstant.id), g.geoTargetConstant])
    : []);
  const view = (list) => list.map((c) => ({ id: c.geo, name: names.get(c.geo)?.canonicalName || null, negative: c.negative }));
  if (args.action === "list") return { customer_id: cid, campaign_id: camp, locations: view(cur) };

  if (!ids.length) throw new Error("location_ids — ID мест (geo_target_constant), напр. 1011475 — Гданьск");
  const unknown = ids.filter((id) => names.get(id)?.status !== "ENABLED");
  if (unknown.length) throw new Error(`Нет таких мест: ${unknown.join(", ")}`);
  const negative = Boolean(args.negative);
  const removes = [];
  const creates = [];
  let after = cur.slice();
  if (args.action === "add") {
    for (const id of ids) {
      const same = cur.find((c) => c.geo === id);
      if (same && same.negative === negative) continue;
      // было с другим знаком (исключено ↔ показ) — сначала убираем старое условие
      if (same) { removes.push({ campaignCriterionOperation: { remove: same.res } }); after = after.filter((c) => c !== same); }
      creates.push({ campaignCriterionOperation: { create: { campaign: `customers/${cid}/campaigns/${camp}`, negative, location: { geoTargetConstant: `geoTargetConstants/${id}` } } } });
      after.push({ geo: id, negative });
    }
  } else if (args.action === "remove") {
    for (const id of ids) {
      const same = cur.find((c) => c.geo === id && c.negative === negative);
      if (same) { removes.push({ campaignCriterionOperation: { remove: same.res } }); after = after.filter((c) => c !== same); }
    }
  } else throw new Error("action: list, add, remove");
  if (!after.some((c) => !c.negative)) throw new Error("После правки у кампании не останется ни одного места показа — реклама пошла бы по всему миру. Ничего не изменено.");
  const res = await mutate(env, cid, [...removes, ...creates], args.apply, login);
  return { customer_id: cid, campaign_id: camp, ...res, before: view(cur), after: view(after) };
}

async function campaignNegativesTool(env, args) {
  const cid = await customerOf(env, args);
  const login = loginOf(args);
  const camp = idOf(args.campaign_id, "campaign_id");
  const rows = await gaql(env, cid, `SELECT campaign.id, campaign_criterion.resource_name, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type FROM campaign_criterion WHERE campaign.id = ${camp} AND campaign_criterion.type = 'KEYWORD' AND campaign_criterion.negative = TRUE`, login);
  const cur = rows.map((r) => ({ resource: r.campaignCriterion.resourceName, text: r.campaignCriterion.keyword?.text, match: r.campaignCriterion.keyword?.matchType })).filter((k) => k.text);
  const key = (k) => `${k.match}|${k.text.toLowerCase()}`;
  if (args.action === "list") {
    const q = String(args.contains || "").trim().toLowerCase();
    const list = q ? cur.filter((k) => k.text.toLowerCase().includes(q)) : cur;
    return { customer_id: cid, campaign_id: camp, count: cur.length, ...(q ? { matching: list.length } : {}), keywords: list.slice(0, 500).map(({ text, match }) => ({ text, match })) };
  }
  const wanted = [...new Map((args.keywords || []).map(negativeOf).map((k) => [key(k), k])).values()];
  if (!wanted.length) throw new Error("keywords — список минус-слов");
  const have = new Map(cur.map((k) => [key(k), k]));
  if (args.action === "remove") {
    const found = wanted.filter((k) => have.has(key(k)));
    const res = await mutate(env, cid, found.map((k) => ({ campaignCriterionOperation: { remove: have.get(key(k)).resource } })), args.apply, login);
    return { customer_id: cid, campaign_id: camp, ...res, removed: found, not_found: wanted.filter((k) => !have.has(key(k))) };
  }
  if (args.action !== "add") throw new Error("action: list, add, remove");
  const fresh = wanted.filter((k) => !have.has(key(k)));
  const res = await mutate(env, cid, fresh.map((k) => ({ campaignCriterionOperation: { create: { campaign: `customers/${cid}/campaigns/${camp}`, negative: true, keyword: { text: k.text, matchType: k.match } } } })), args.apply, login);
  return { customer_id: cid, campaign_id: camp, ...res, added: fresh, already_there: wanted.filter((k) => have.has(key(k))) };
}

async function adEditTool(env, args) {
  const cid = await customerOf(env, args);
  const login = loginOf(args);
  const id = idOf(args.ad_id, "ad_id");
  const [row] = await gaql(env, cid, `SELECT ad_group_ad.ad.resource_name, ad_group_ad.ad.type, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions FROM ad_group_ad WHERE ad_group_ad.ad.id = ${id} LIMIT 1`, login);
  const ad = row?.adGroupAd?.ad;
  if (!ad) throw new Error(`Объявление ${id} не найдено`);
  if (ad.type !== "RESPONSIVE_SEARCH_AD") throw new Error(`Объявление ${id} — не адаптивное поисковое (${ad.type})`);
  const pick = (list) => (list || []).map((t) => (t.pinnedField ? { text: t.text, pinnedField: t.pinnedField } : { text: t.text }));
  const before = { headlines: pick(ad.responsiveSearchAd?.headlines), descriptions: pick(ad.responsiveSearchAd?.descriptions) };
  const hl = before.headlines.map((t) => ({ ...t }));
  const ds = before.descriptions.map((t) => ({ ...t }));
  const where = (text) => (hl.find((t) => t.text === text) ? hl : ds.find((t) => t.text === text) ? ds : null);
  const fresh = [];
  for (const r of args.replace || []) {
    const list = where(String(r?.from ?? ""));
    if (!list) throw new Error(`Нет такого текста в объявлении: «${r?.from}»`);
    const item = list.find((t) => t.text === r.from);
    item.text = String(r.to ?? "").trim();
    fresh.push({ text: item.text, kind: list === hl ? "headline" : "description" });
  }
  for (const text of args.remove || []) {
    const list = where(String(text));
    if (!list) throw new Error(`Нет такого текста в объявлении: «${text}»`);
    list.splice(list.findIndex((t) => t.text === text), 1);
  }
  for (const text of args.add_headlines || []) { hl.push({ text: String(text).trim() }); fresh.push({ text: String(text).trim(), kind: "headline" }); }
  for (const text of args.add_descriptions || []) { ds.push({ text: String(text).trim() }); fresh.push({ text: String(text).trim(), kind: "description" }); }
  for (const f of fresh) {
    const max = f.kind === "headline" ? 30 : 90;
    if (!f.text) throw new Error("Пустой текст");
    if (!f.text.includes("{") && len(f.text) > max) throw new Error(`«${f.text}» — ${len(f.text)} знаков, для ${f.kind === "headline" ? "заголовка" : "описания"} максимум ${max}`);
  }
  const dup = (list) => list.map((t) => t.text.toLowerCase()).find((t, i, a) => a.indexOf(t) !== i);
  if (dup(hl) || dup(ds)) throw new Error(`Повтор текста: «${dup(hl) || dup(ds)}»`);
  if (hl.length < 3 || hl.length > 15) throw new Error(`Заголовков должно быть 3–15, выходит ${hl.length}`);
  if (ds.length < 2 || ds.length > 4) throw new Error(`Описаний должно быть 2–4, выходит ${ds.length}`);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const rsa = {};
  const mask = [];
  if (!same(hl, before.headlines)) { rsa.headlines = hl; mask.push("responsiveSearchAd.headlines"); }
  if (!same(ds, before.descriptions)) { rsa.descriptions = ds; mask.push("responsiveSearchAd.descriptions"); }
  if (!mask.length) throw new Error("Нечего менять: replace, remove, add_headlines, add_descriptions");
  const res = await mutate(env, cid, [{ adOperation: { update: { resourceName: ad.resourceName, responsiveSearchAd: rsa }, updateMask: mask.join(",") } }], args.apply, login);
  const show = (list) => list.map((t) => (t.pinnedField ? `${t.text}  [${t.pinnedField}]` : t.text));
  return { customer_id: cid, ad_id: id, ...res, headlines: show(hl), descriptions: show(ds) };
}

async function finalUrlTool(env, args) {
  const cid = await customerOf(env, args);
  const login = loginOf(args);
  const which = ["ad_id", "asset_group_id", "asset_id"].filter((k) => args[k]);
  if (which.length !== 1) throw new Error("Укажите что-то одно: ad_id, asset_group_id или asset_id (ссылка расширения)");
  const url = await siteUrl(env, cid, login, args.final_url);
  let op;
  let before;
  let what;
  if (args.ad_id) {
    const id = idOf(args.ad_id, "ad_id");
    const [row] = await gaql(env, cid, `SELECT ad_group_ad.ad.resource_name, ad_group_ad.ad.final_urls FROM ad_group_ad WHERE ad_group_ad.ad.id = ${id} LIMIT 1`, login);
    const ad = row?.adGroupAd?.ad;
    if (!ad) throw new Error(`Объявление ${id} не найдено`);
    before = ad.finalUrls || [];
    what = `объявление ${id}`;
    op = { adOperation: { update: { resourceName: ad.resourceName, finalUrls: [url] }, updateMask: "finalUrls" } };
  } else if (args.asset_group_id) {
    const id = idOf(args.asset_group_id, "asset_group_id");
    const [row] = await gaql(env, cid, `SELECT asset_group.resource_name, asset_group.name, asset_group.final_urls FROM asset_group WHERE asset_group.id = ${id}`, login);
    if (!row) throw new Error(`Группа объектов ${id} не найдена`);
    before = row.assetGroup.finalUrls || [];
    what = `группа объектов «${row.assetGroup.name}»`;
    op = { assetGroupOperation: { update: { resourceName: row.assetGroup.resourceName, finalUrls: [url] }, updateMask: "finalUrls" } };
  } else {
    const id = idOf(args.asset_id, "asset_id");
    const [row] = await gaql(env, cid, `SELECT asset.resource_name, asset.type, asset.final_urls, asset.sitelink_asset.link_text, asset.promotion_asset.promotion_target FROM asset WHERE asset.id = ${id}`, login);
    if (!row) throw new Error(`Объект ${id} не найден`);
    const a = row.asset;
    if (!["SITELINK", "PROMOTION"].includes(a.type)) throw new Error(`Объект ${id} — ${a.type}; ссылку меняю только у быстрых ссылок и промоакций`);
    before = a.finalUrls || [];
    what = `${a.type === "SITELINK" ? "быстрая ссылка" : "промоакция"} «${a.sitelinkAsset?.linkText || a.promotionAsset?.promotionTarget}»`;
    op = { assetOperation: { update: { resourceName: a.resourceName, finalUrls: [url] }, updateMask: "finalUrls" } };
  }
  const res = await mutate(env, cid, [op], args.apply, login);
  return { customer_id: cid, ...res, target: what, before, after: [url] };
}

const ASSET_FIELDS = ["SITELINK", "CALLOUT", "PROMOTION", "PRICE", "STRUCTURED_SNIPPET", "CALL"];
// минимум текстов в группе объектов Performance Max (меньше Google не примет)
const GROUP_TEXT_MIN = { HEADLINE: 3, LONG_HEADLINE: 1, DESCRIPTION: 2 };
// и максимум (больше Google не примет)
const GROUP_TEXT_MAX = { HEADLINE: 15, LONG_HEADLINE: 5, DESCRIPTION: 5 };
const GROUP_TEXT_LEN = { HEADLINE: 30, LONG_HEADLINE: 90, DESCRIPTION: 90 };

async function assetsTool(env, args) {
  const cid = await customerOf(env, args);
  const login = loginOf(args);
  const action = args.action;
  const camps = [...new Set((args.campaign_ids || []).map((v) => idOf(v, "campaign_ids")))];
  const fields = ASSET_FIELDS.map((f) => `'${f}'`).join(", ");
  const linked = async () => {
    const c = await gaql(env, cid, `SELECT campaign.id, campaign.name, campaign.status, campaign_asset.field_type, campaign_asset.status, asset.id, asset.final_urls, asset.sitelink_asset.link_text, asset.callout_asset.callout_text, asset.promotion_asset.promotion_target FROM campaign_asset WHERE campaign.status = 'ENABLED' AND campaign_asset.status != 'REMOVED' AND campaign_asset.field_type IN (${fields})`, login);
    const a = await gaql(env, cid, `SELECT customer_asset.field_type, customer_asset.status, asset.id, asset.final_urls, asset.sitelink_asset.link_text, asset.callout_asset.callout_text, asset.promotion_asset.promotion_target FROM customer_asset WHERE customer_asset.status != 'REMOVED' AND customer_asset.field_type IN (${fields})`, login);
    const text = (x) => x.sitelinkAsset?.linkText || x.calloutAsset?.calloutText || x.promotionAsset?.promotionTarget || null;
    return [
      ...a.map((r) => ({ level: "account", campaign_id: null, campaign: null, field: r.customerAsset.fieldType, status: r.customerAsset.status, asset_id: String(r.asset.id), text: text(r.asset), url: r.asset.finalUrls?.[0] || null })),
      ...c.map((r) => ({ level: "campaign", campaign_id: String(r.campaign.id), campaign: r.campaign.name, field: r.campaignAsset.fieldType, status: r.campaignAsset.status, asset_id: String(r.asset.id), text: text(r.asset), url: r.asset.finalUrls?.[0] || null })),
    ];
  };
  if (action === "list") return { customer_id: cid, assets: await linked() };

  if (action === "unlink") {
    const asset = idOf(args.asset_id, "asset_id");
    const field = String(args.field_type || "").toUpperCase();
    // тексты Performance Max живут в группе объектов, а не в кампании
    if (args.asset_group_id) {
      const group = idOf(args.asset_group_id, "asset_group_id");
      if (!GROUP_TEXT_MIN[field]) throw new Error(`asset_group_id: field_type ${Object.keys(GROUP_TEXT_MIN).join(", ")}`);
      const rows = await gaql(env, cid, `SELECT asset.id, asset.text_asset.text FROM asset_group_asset WHERE asset_group.id = ${group} AND asset_group_asset.status = 'ENABLED' AND asset_group_asset.field_type = '${field}'`, login);
      const hit = rows.find((r) => String(r.asset.id) === asset);
      if (!hit) throw new Error(`Текст ${asset} (${field}) не подключён к группе ${group}`);
      if (rows.length - 1 < GROUP_TEXT_MIN[field]) throw new Error(`В группе останется ${rows.length - 1} (${field}), нужно не меньше ${GROUP_TEXT_MIN[field]} — сначала добавьте замену`);
      const res = await mutate(env, cid, [{ assetGroupAssetOperation: { remove: `customers/${cid}/assetGroupAssets/${group}~${asset}~${field}` } }], args.apply, login);
      return { customer_id: cid, ...res, unlinked: [{ level: "asset_group", asset_group: group, field, text: hit.asset.textAsset?.text ?? null }], left: rows.length - 1, note: "Сам текст не удаляется — его можно подключить обратно в Google Ads" };
    }
    if (!ASSET_FIELDS.includes(field)) throw new Error(`field_type: ${ASSET_FIELDS.join(", ")}`);
    const now = (await linked()).filter((l) => l.asset_id === asset && l.field === field);
    const hits = args.account ? now.filter((l) => l.level === "account") : now.filter((l) => l.level === "campaign" && (!camps.length || camps.includes(l.campaign_id)));
    if (!hits.length) throw new Error(`Объект ${asset} (${field}) ${args.account ? "не подключён к аккаунту" : "не подключён к этим кампаниям"}`);
    const ops = hits.map((l) => (l.level === "account"
      ? { customerAssetOperation: { remove: `customers/${cid}/customerAssets/${asset}~${field}` } }
      : { campaignAssetOperation: { remove: `customers/${cid}/campaignAssets/${l.campaign_id}~${asset}~${field}` } }));
    const res = await mutate(env, cid, ops, args.apply, login);
    return { customer_id: cid, ...res, unlinked: hits.map(({ level, campaign, text }) => ({ level, campaign, text })), note: "Сам объект не удаляется — его можно подключить обратно в Google Ads" };
  }

  if (action === "link") {
    const asset = idOf(args.asset_id, "asset_id");
    const field = String(args.field_type || "").toUpperCase();
    const [a] = await gaql(env, cid, `SELECT asset.id, asset.type, asset.text_asset.text, asset.sitelink_asset.link_text, asset.callout_asset.callout_text, asset.promotion_asset.promotion_target FROM asset WHERE asset.id = ${asset}`, login);
    if (!a) throw new Error(`Объект ${asset} не найден`);
    const text = a.asset.textAsset?.text || a.asset.sitelinkAsset?.linkText || a.asset.calloutAsset?.calloutText || a.asset.promotionAsset?.promotionTarget || null;
    if (args.asset_group_id) {
      const group = idOf(args.asset_group_id, "asset_group_id");
      if (!GROUP_TEXT_MAX[field]) throw new Error(`asset_group_id: field_type ${Object.keys(GROUP_TEXT_MAX).join(", ")}`);
      if (a.asset.type !== "TEXT") throw new Error(`Объект ${asset} — ${a.asset.type}, а нужен текст`);
      const rows = await gaql(env, cid, `SELECT asset.id FROM asset_group_asset WHERE asset_group.id = ${group} AND asset_group_asset.status = 'ENABLED' AND asset_group_asset.field_type = '${field}'`, login);
      if (rows.some((r) => String(r.asset.id) === asset)) return { customer_id: cid, applied: false, linked: [], note: `«${text}» уже в группе ${group}` };
      if (rows.length + 1 > GROUP_TEXT_MAX[field]) throw new Error(`В группе уже ${rows.length} (${field}), максимум ${GROUP_TEXT_MAX[field]} — сначала отключите лишнее`);
      const res = await mutate(env, cid, [{ assetGroupAssetOperation: { create: { asset: `customers/${cid}/assets/${asset}`, assetGroup: `customers/${cid}/assetGroups/${group}`, fieldType: field } } }], args.apply, login);
      return { customer_id: cid, ...res, linked: [{ level: "asset_group", asset_group: group, field, text }], total: rows.length + 1 };
    }
    if (!ASSET_FIELDS.includes(field)) throw new Error(`field_type: ${ASSET_FIELDS.join(", ")}`);
    if (a.asset.type !== field) throw new Error(`Объект ${asset} — ${a.asset.type}, а не ${field}`);
    if (!camps.length) throw new Error("campaign_ids — к каким кампаниям подключить");
    const names = new Map((await gaql(env, cid, `SELECT campaign.id, campaign.name FROM campaign WHERE campaign.id IN (${camps.join(",")}) AND campaign.status != 'REMOVED'`, login)).map((r) => [String(r.campaign.id), r.campaign.name]));
    const missing = camps.filter((c) => !names.has(c));
    if (missing.length) throw new Error(`Нет таких кампаний: ${missing.join(", ")}`);
    const now = (await linked()).filter((l) => l.level === "campaign" && l.asset_id === asset && l.field === field);
    const out = [];
    const ops = [];
    for (const c of camps) {
      if (now.some((l) => l.campaign_id === c)) { out.push({ campaign: names.get(c), text, result: "уже подключено" }); continue; }
      ops.push({ campaignAssetOperation: { create: { campaign: `customers/${cid}/campaigns/${c}`, asset: `customers/${cid}/assets/${asset}`, fieldType: field } } });
      out.push({ campaign: names.get(c), text, result: "подключено" });
    }
    const res = ops.length ? await mutate(env, cid, ops, args.apply, login) : { applied: false };
    return { customer_id: cid, ...res, items: out };
  }

  if (action === "add_texts") {
    // новые тексты Performance Max в группу объектов; такой же текст уже есть в аккаунте — подключаем его, копий не плодим
    if (!args.asset_group_id) throw new Error("asset_group_id — группа объектов Performance Max");
    const group = idOf(args.asset_group_id, "asset_group_id");
    const field = String(args.field_type || "").toUpperCase();
    const max = GROUP_TEXT_LEN[field];
    if (!max) throw new Error(`field_type: ${Object.keys(GROUP_TEXT_LEN).join(", ")}`);
    const texts = [...new Set((args.texts || []).map((t) => String(t).trim()))];
    if (!texts.length) throw new Error("texts — тексты для группы");
    for (const t of texts) if (!t || len(t) > max) throw new Error(`«${t}» — нужно 1–${max} знаков`);
    const rows = await gaql(env, cid, `SELECT asset.id, asset.text_asset.text FROM asset_group_asset WHERE asset_group.id = ${group} AND asset_group_asset.status = 'ENABLED' AND asset_group_asset.field_type = '${field}'`, login);
    const fresh = texts.filter((t) => !rows.some((r) => r.asset.textAsset?.text === t));
    if (rows.length + fresh.length > GROUP_TEXT_MAX[field]) throw new Error(`В группе ${rows.length} (${field}), с новыми будет ${rows.length + fresh.length}, максимум ${GROUP_TEXT_MAX[field]} — сначала отключите лишнее`);
    const quote = (t) => `'${t.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
    const twins = fresh.length ? await gaql(env, cid, `SELECT asset.id, asset.text_asset.text FROM asset WHERE asset.type = 'TEXT' AND asset.text_asset.text IN (${fresh.map(quote).join(", ")})`, login) : [];
    const ops = [];
    const out = texts.filter((t) => !fresh.includes(t)).map((t) => ({ text: t, result: "уже в группе" }));
    let tmp = 0;
    for (const t of fresh) {
      const twin = twins.find((r) => r.asset.textAsset?.text === t);
      let asset = twin ? `customers/${cid}/assets/${twin.asset.id}` : null;
      if (!asset) {
        asset = `customers/${cid}/assets/-${++tmp}`;
        ops.push({ assetOperation: { create: { resourceName: asset, textAsset: { text: t } } } });
      }
      ops.push({ assetGroupAssetOperation: { create: { asset, assetGroup: `customers/${cid}/assetGroups/${group}`, fieldType: field } } });
      out.push({ text: t, result: twin ? "подключено существующее" : "новое" });
    }
    const res = ops.length ? await mutate(env, cid, ops, args.apply, login) : { applied: false };
    return { customer_id: cid, ...res, asset_group: group, field, items: out, total: rows.length + fresh.length };
  }

  if (action !== "add_callouts" && action !== "add_sitelinks") throw new Error("action: list, unlink, link, add_texts, add_callouts, add_sitelinks");
  if (!camps.length) throw new Error("campaign_ids — к каким кампаниям подключить");
  const names = new Map((await gaql(env, cid, `SELECT campaign.id, campaign.name FROM campaign WHERE campaign.id IN (${camps.join(",")}) AND campaign.status != 'REMOVED'`, login)).map((r) => [String(r.campaign.id), r.campaign.name]));
  const missing = camps.filter((c) => !names.has(c));
  if (missing.length) throw new Error(`Нет таких кампаний: ${missing.join(", ")}`);
  const field = action === "add_callouts" ? "CALLOUT" : "SITELINK";
  const items = action === "add_callouts"
    ? (args.callouts || []).map((t) => ({ text: String(t).trim() }))
    : (args.sitelinks || []).map((s) => ({ text: String(s?.text || "").trim(), url: s?.url, d1: String(s?.description1 || "").trim(), d2: String(s?.description2 || "").trim() }));
  if (!items.length) throw new Error(action === "add_callouts" ? "callouts — тексты уточнений" : "sitelinks — [{text, url, description1?, description2?}]");
  const hosts = field === "SITELINK" ? await ownHosts(env, cid, login) : null;
  for (const it of items) {
    if (!it.text || len(it.text) > 25) throw new Error(`«${it.text}» — нужно 1–25 знаков`);
    if (field === "SITELINK") {
      it.url = await siteUrl(env, cid, login, it.url, hosts);
      if (Boolean(it.d1) !== Boolean(it.d2)) throw new Error(`«${it.text}»: описания — обе строки или ни одной`);
      for (const d of [it.d1, it.d2]) if (d && len(d) > 35) throw new Error(`«${d}» — максимум 35 знаков`);
    }
  }
  const already = await linked();
  const ops = [];
  const out = [];
  let tmp = 0;
  for (const it of items) {
    // уже есть такой же объект с тем же текстом — подключаем его, а не плодим копии
    const twin = already.find((l) => l.field === field && l.text === it.text && (field === "CALLOUT" || l.url === it.url));
    let asset = twin ? `customers/${cid}/assets/${twin.asset_id}` : null;
    if (!asset) {
      asset = `customers/${cid}/assets/-${++tmp}`;
      const create = field === "CALLOUT"
        ? { resourceName: asset, calloutAsset: { calloutText: it.text } }
        : { resourceName: asset, finalUrls: [it.url], sitelinkAsset: { linkText: it.text, ...(it.d1 ? { description1: it.d1, description2: it.d2 } : {}) } };
      ops.push({ assetOperation: { create } });
    }
    for (const c of camps) {
      const on = twin && already.some((l) => l.level === "campaign" && l.campaign_id === c && l.asset_id === twin.asset_id && l.field === field);
      if (on) { out.push({ text: it.text, campaign: names.get(c), result: "уже подключено" }); continue; }
      ops.push({ campaignAssetOperation: { create: { campaign: `customers/${cid}/campaigns/${c}`, asset, fieldType: field } } });
      out.push({ text: it.text, campaign: names.get(c), result: twin ? "подключено существующее" : "новое" });
    }
  }
  const res = await mutate(env, cid, ops, args.apply, login);
  return { customer_id: cid, ...res, items: out };
}

async function conversionCreateTool(env, args) {
  const cid = await customerOf(env, args);
  const login = loginOf(args);
  const name = String(args.name || "").trim();
  if (!name || len(name) > 100) throw new Error("name — 1–100 знаков");
  const category = String(args.category || "PURCHASE").toUpperCase();
  if (!["PURCHASE", "ADD_TO_CART", "BEGIN_CHECKOUT", "SUBMIT_LEAD_FORM", "CONTACT", "SIGNUP"].includes(category)) throw new Error("category: PURCHASE, ADD_TO_CART, BEGIN_CHECKOUT, SUBMIT_LEAD_FORM, CONTACT, SIGNUP");
  const value = args.default_value === undefined ? 0 : Number(args.default_value);
  if (!Number.isFinite(value) || value < 0 || value > 100000) throw new Error("default_value — 0…100000");
  const [acc] = await gaql(env, cid, "SELECT customer.currency_code FROM customer LIMIT 1", login);
  const quoted = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const [twin] = await gaql(env, cid, `SELECT conversion_action.id, conversion_action.status FROM conversion_action WHERE conversion_action.name = '${quoted}' AND conversion_action.status != 'REMOVED'`, login);
  if (twin) throw new Error(`Конверсия «${name}» уже есть (id ${twin.conversionAction.id})`);
  const create = {
    name, type: "WEBPAGE", category, status: "ENABLED",
    primaryForGoal: args.primary_for_goal === true,
    countingType: category === "PURCHASE" ? "MANY_PER_CLICK" : "ONE_PER_CLICK",
    valueSettings: { defaultValue: value, defaultCurrencyCode: acc?.customer?.currencyCode || "PLN", alwaysUseDefaultValue: false },
    clickThroughLookbackWindowDays: 30, viewThroughLookbackWindowDays: 1,
  };
  const res = await mutate(env, cid, [{ conversionActionOperation: { create } }], args.apply, login);
  if (!res.applied) return { customer_id: cid, ...res, will_create: create };
  const id = res.changed[0]?.split("/").pop();
  const [row] = await gaql(env, cid, `SELECT conversion_action.id, conversion_action.tag_snippets FROM conversion_action WHERE conversion_action.id = ${id}`, login);
  const snippet = (row?.conversionAction?.tagSnippets || []).map((t) => t.eventSnippet || "").join("\n");
  const sendTo = [...new Set([...snippet.matchAll(/send_to['"]?\s*:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]))];
  return { customer_id: cid, ...res, conversion_action_id: id, name, primary_for_goal: create.primaryForGoal, send_to: sendTo };
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
    name: "google_ads_ad_schedule",
    description: "Google Ads, ПРАВКА: часы показа рекламы (одинаковые на все дни). action=list — показать расписание; set — поставить start_hour…end_hour для campaign_ids, поправки ставок по дням сохраняются. Часы — в часовом поясе аккаунта. Без apply: true — только проверка.",
    inputSchema: obj({
      ...CID, ...LOGIN,
      action: { type: "string", enum: ["list", "set"] },
      campaign_ids: { type: "array", items: { type: "string" } },
      start_hour: { type: "integer", description: "С какого часа, 0…23" },
      end_hour: { type: "integer", description: "До какого часа, 1…24" },
      apply: { type: "boolean", description: "true — применить; иначе только проверка" },
    }, ["action"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "google_ads_budget_plan",
    description: "Google Ads, ПРАВКА: бюджет по дням недели — в будни один, в выходные (по умолчанию пт–вс) другой. Воркер сам ставит нужный бюджет каждый час (по часовому поясу аккаунта). action=show — план и последний запуск; set — сохранить план и сразу применить сегодняшний бюджет; run — применить сейчас; clear — убрать план (бюджеты остаются как есть). Без apply: true — только проверка.",
    inputSchema: obj({
      ...CID, ...LOGIN,
      action: { type: "string", enum: ["show", "set", "run", "clear"] },
      items: { type: "array", items: obj({ campaign_id: { type: "string" }, weekday: { type: "number" }, weekend: { type: "number" }, shared: { type: "boolean", description: "общий бюджет на несколько кампаний" } }, ["campaign_id", "weekday", "weekend"]) },
      weekend_days: { type: "array", items: { type: "string", enum: DAYS_ENUM } },
      apply: { type: "boolean", description: "true — применить; иначе только проверка" },
    }, ["action"]),
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
  {
    name: "google_ads_geo",
    description: "Google Ads, ПРАВКА мест показа кампании: action=list — показать; add — добавить место в показ (negative: false) или в исключения (negative: true), если оно было с другим знаком — переносится; remove — убрать условие. ID мест — geo_target_constant (через google_ads_search). Кампанию без единого места показа не оставляет. Без apply: true — только проверка.",
    inputSchema: obj({
      ...CID, ...LOGIN,
      campaign_id: { type: "string" },
      action: { type: "string", enum: ["list", "add", "remove"] },
      location_ids: { type: "array", items: { type: "string" }, description: "ID мест, напр. 1011475 (Гданьск)" },
      negative: { type: "boolean", description: "true — исключение; по умолчанию показ" },
      apply: { type: "boolean", description: "true — применить; иначе только проверка" },
    }, ["campaign_id", "action"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "google_ads_campaign_negatives",
    description: "Google Ads, ПРАВКА минус-слов одной кампании (в т.ч. Performance Max): action=list (contains — фильтр), add, remove. Без apply: true — только проверка.",
    inputSchema: obj({
      ...CID, ...LOGIN,
      campaign_id: { type: "string" },
      action: { type: "string", enum: ["list", "add", "remove"] },
      contains: { type: "string", description: "Для list: только слова, содержащие этот текст" },
      keywords: { type: "array", description: "Слова: строка или {text, match}. match: PHRASE (по умолчанию), EXACT, BROAD", items: { anyOf: [{ type: "string" }, obj({ text: { type: "string" }, match: { type: "string", enum: MATCH } }, ["text"])] } },
      apply: { type: "boolean", description: "true — применить; иначе только проверка" },
    }, ["campaign_id", "action"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "google_ads_ad_edit",
    description: "Google Ads, ПРАВКА текстов адаптивного поискового объявления: replace [{from, to}] — заменить заголовок или описание (закрепление сохраняется), remove — убрать тексты, add_headlines / add_descriptions — добавить. Заголовок до 30 знаков, описание до 90; заголовков 3–15, описаний 2–4. Объявление уходит на повторную проверку Google. Без apply: true — только проверка.",
    inputSchema: obj({
      ...CID, ...LOGIN,
      ad_id: { type: "string" },
      replace: { type: "array", items: obj({ from: { type: "string" }, to: { type: "string" } }, ["from", "to"]) },
      remove: { type: "array", items: { type: "string" } },
      add_headlines: { type: "array", items: { type: "string" } },
      add_descriptions: { type: "array", items: { type: "string" } },
      apply: { type: "boolean", description: "true — применить; иначе только проверка" },
    }, ["ad_id"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "google_ads_final_url",
    description: "Google Ads, ПРАВКА конечной ссылки: объявления (ad_id), группы объектов Performance Max (asset_group_id) или быстрой ссылки / промоакции (asset_id). Только https и только на сайт, куда уже ведут включённые объявления. Без apply: true — только проверка.",
    inputSchema: obj({
      ...CID, ...LOGIN,
      ad_id: { type: "string" },
      asset_group_id: { type: "string" },
      asset_id: { type: "string" },
      final_url: { type: "string" },
      apply: { type: "boolean", description: "true — применить; иначе только проверка" },
    }, ["final_url"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "google_ads_assets",
    description: "Google Ads, ПРАВКА расширений: action=list — быстрые ссылки, уточнения, промоакции, прайс-листы, структурированные описания и звонки (аккаунт и включённые кампании); unlink — отключить объект (asset_id + field_type) от кампаний campaign_ids (пусто — от всех), от аккаунта (account: true) или текст Performance Max (HEADLINE, LONG_HEADLINE, DESCRIPTION) от группы объектов asset_group_id, сам объект остаётся; link — подключить существующий объект (asset_id + field_type) обратно к кампаниям campaign_ids или текст к группе asset_group_id; add_texts — новые тексты Performance Max texts[] (field_type HEADLINE до 30, LONG_HEADLINE и DESCRIPTION до 90) в группу asset_group_id; add_callouts — уточнения (до 25 знаков) к кампаниям; add_sitelinks — быстрые ссылки [{text до 25, url, description1/2 до 35}] к кампаниям. Без apply: true — только проверка.",
    inputSchema: obj({
      ...CID, ...LOGIN,
      action: { type: "string", enum: ["list", "unlink", "link", "add_texts", "add_callouts", "add_sitelinks"] },
      asset_id: { type: "string" },
      field_type: { type: "string", enum: ["SITELINK", "CALLOUT", "PROMOTION", "PRICE", "STRUCTURED_SNIPPET", "CALL", "HEADLINE", "LONG_HEADLINE", "DESCRIPTION"] },
      asset_group_id: { type: "string", description: "unlink/link/add_texts: группа объектов Performance Max (для текстов HEADLINE, LONG_HEADLINE, DESCRIPTION)" },
      account: { type: "boolean", description: "unlink: отключить от аккаунта (а не от кампаний)" },
      campaign_ids: { type: "array", items: { type: "string" } },
      callouts: { type: "array", items: { type: "string" } },
      texts: { type: "array", items: { type: "string" }, description: "add_texts: тексты для группы Performance Max" },
      sitelinks: { type: "array", items: obj({ text: { type: "string" }, url: { type: "string" }, description1: { type: "string" }, description2: { type: "string" } }, ["text", "url"]) },
      apply: { type: "boolean", description: "true — применить; иначе только проверка" },
    }, ["action"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "google_ads_conversion_create",
    description: "Google Ads, ПРАВКА: новое действие-конверсия для тега на сайте (тип WEBPAGE), по умолчанию «Покупка», не основная (не влияет на ставки, пока не включить primary). После apply возвращает send_to (AW-…/метка). Без apply: true — только проверка.",
    inputSchema: obj({
      ...CID, ...LOGIN,
      name: { type: "string" },
      category: { type: "string", enum: ["PURCHASE", "ADD_TO_CART", "BEGIN_CHECKOUT", "SUBMIT_LEAD_FORM", "CONTACT", "SIGNUP"] },
      default_value: { type: "number", description: "Ценность, если сайт не передал сумму (по умолчанию 0)" },
      primary_for_goal: { type: "boolean", description: "По умолчанию false" },
      apply: { type: "boolean", description: "true — применить; иначе только проверка" },
    }, ["name"]),
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
    case "google_ads_ad_schedule":
      return scheduleTool(env, args);
    case "google_ads_budget_plan":
      return budgetPlanTool(env, args);
    case "google_ads_keyword_match":
      return keywordMatchTool(env, args);
    case "google_ads_geo":
      return geoTool(env, args);
    case "google_ads_campaign_negatives":
      return campaignNegativesTool(env, args);
    case "google_ads_ad_edit":
      return adEditTool(env, args);
    case "google_ads_final_url":
      return finalUrlTool(env, args);
    case "google_ads_assets":
      return assetsTool(env, args);
    case "google_ads_conversion_create":
      return conversionCreateTool(env, args);

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
