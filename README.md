# ads-mcp

MCP-сервер рекламы на Cloudflare Workers: **Яндекс Директ (API v5)** + **VK Реклама (ads.vk.com)** +
**Google Ads (API v26: отчёты + узкий набор правок)**. Протокол — JSON-RPC 2.0 поверх HTTP POST. Аутентификация — секрет в пути.

## URL коннектора

```
https://ads-mcp.<аккаунт>.workers.dev/<MCP_SECRET>/mcp
```

Любой другой путь → `404`.

## Инструменты

### Яндекс Директ (секрет `YANDEX_DIRECT_TOKEN`, опц. `YANDEX_DIRECT_LOGIN`)

| Инструмент | Назначение |
|------------|------------|
| `direct_campaigns(states?)` | Кампании: Id, имя, состояние, статус, тип, бюджет |
| `direct_keywords(campaign_ids?, limit?)` | Ключевые фразы: статус, ставка |
| `direct_report(report_type?, fields?, date_range?, date_from?, date_to?)` | Отчёт статистики (Reports API, TSV) |
| `direct_request(service, body)` | Универсальный вызов API v5 |

### VK Реклама (секрет `VK_ADS_TOKEN`)

| Инструмент | Назначение |
|------------|------------|
| `vk_ads_stats(metric?, ids?, date_from?, date_to?)` | Дневная статистика: показы, клики, расход |
| `vk_ads_request(method, path, params?, body?)` | Универсальный вызов API |

### Google Ads

| Инструмент | Назначение |
|------------|------------|
| `google_ads_status()` | Подключён ли: OAuth-клиент, вход в Google, аккаунт по умолчанию |
| `google_ads_accounts()` | Доступные аккаунты (у MCC — подчинённые) |
| `google_ads_campaigns(period?, date_from?, date_to?)` | Кампании: бюджет, показы, клики, расход, CTR, CPC, конверсии, ценность, CPA |
| `google_ads_daily(period?, campaign_id?)` | По дням |
| `google_ads_search_terms(period?, campaign_id?, limit?)` | Поисковые запросы |
| `google_ads_keywords(period?, campaign_id?, limit?)` | Ключевые слова с показателем качества |
| `google_ads_conversions()` | Действия-конверсии и `send_to` (AW-…/метка) для тега на сайте |
| `google_ads_search(query)` | Произвольный GAQL |
| `google_ads_request(method, path, body?)` | GET или POST к `…:search`/`…:searchStream`; mutate запрещён |

Правки — только эти четыре; без `apply: true` Google лишь проверяет запрос (validateOnly) и ничего не меняет:

| Инструмент | Что меняет |
|---|---|
| `google_ads_negative_keywords(action, keywords?, apply?)` | Минус-слова всего аккаунта (поиск и Performance Max): `list` / `add` / `remove` |
| `google_ads_conversion_update(conversion_action_id, phone_call_duration_seconds?, primary_for_goal?, apply?)` | С какой длительности звонок — конверсия; «основная» ли |
| `google_ads_campaign_goal(campaign_id, category, origin, biddable, apply?)` | Участвует ли цель в ставках кампании |
| `google_ads_pin_headlines(ad_id, texts, position, apply?)` | Закрепление существующих заголовков объявления (тексты не меняются) |
| `google_ads_campaign_budget(campaign_id, daily_budget, shared?, apply?)` | Дневной бюджет кампании; общий бюджет — только с `shared: true` |
| `google_ads_keyword_match(campaign_id, keywords?, to_match?, apply?)` | Широкие слова → фразовые/точные: копия с новым типом, старое на паузу |
| `google_ads_geo(campaign_id, action, location_ids?, negative?, apply?)` | Места показа и исключения кампании; без единого места показа кампанию не оставляет |
| `google_ads_campaign_negatives(campaign_id, action, keywords?, contains?, apply?)` | Минус-слова одной кампании (и Performance Max) |
| `google_ads_ad_edit(ad_id, replace?, remove?, add_headlines?, add_descriptions?, apply?)` | Тексты адаптивного поискового объявления; закрепление сохраняется |
| `google_ads_final_url(ad_id \| asset_group_id \| asset_id, final_url, apply?)` | Конечная ссылка объявления, группы объектов PMax, быстрой ссылки или промоакции — только на свой сайт |
| `google_ads_assets(action, …, apply?)` | Расширения: `list`, `unlink` (объект остаётся; с `asset_group_id` — текст Performance Max), `link` (подключить существующий обратно), `add_callouts`, `add_sitelinks` |
| `google_ads_conversion_create(name, category?, default_value?, primary_for_goal?, apply?)` | Новая конверсия для тега на сайте, по умолчанию не основная; возвращает `send_to` |

Везде можно передать `customer_id` (иначе — аккаунт по умолчанию) и `login_customer_id` (доступ через MCC).

## Секреты — что нужно и где взять

- `MCP_SECRET` — секрет пути коннектора (генерируется при деплое).
- `YANDEX_DIRECT_TOKEN` — OAuth-токен Яндекс Директ: [oauth.yandex.ru](https://oauth.yandex.ru) →
  приложение с доступом к **API Директа** → получить токен. `YANDEX_DIRECT_LOGIN` — логин клиента
  (заголовок `Client-Login`), нужен для агентского/представительского доступа.
- `VK_ADS_TOKEN` — токен API [ads.vk.com](https://ads.vk.com) (Настройки → Доступ к API).
- **Google Ads** — developer token с 9 сентября 2026 не нужен: доступ выдаётся Google Cloud проекту.
  1. [Включить Google Ads API](https://console.cloud.google.com/flows/enableapi?apiid=googleads.googleapis.com) в проекте,
     затем [Google Ads API → Overview](https://console.cloud.google.com/google/ads-apis/overview) → **Apply for access** (уровень Explorer).
  2. OAuth consent screen → External → **Publish app** (в статусе Testing вход живёт 7 дней).
  3. Credentials → OAuth client ID → **Web application**, Authorized redirect URI:
     `https://ads-mcp.igorsuhockii.workers.dev/oauth/google/callback`.
  4. Открыть `https://ads-mcp.igorsuhockii.workers.dev/<MCP_SECRET>/google`, вписать client ID/secret, «Войти через Google»
     (аккаунтом с доступом к Google Ads). Refresh-токен воркер сохраняет в KV `ads-mcp-state` сам.

  Секреты `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN`, `GOOGLE_ADS_LOGIN_CUSTOMER_ID`
  по-прежнему работают и важнее записей в KV.

Пока ключей Директа/VK нет, в GitHub Actions подставляется заглушка `'x'` — деплой зелёный,
а инструмент вернёт понятную ошибку «Не задан секрет …».

## Деплой

Пуш в `main` → GitHub Actions (`cloudflare/wrangler-action@v3`) → `wrangler deploy`.
Секреты Cloudflare в GitHub Actions Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
