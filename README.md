# ads-mcp

MCP-сервер рекламы на Cloudflare Workers: **Яндекс Директ (API v5)** + **VK Реклама (ads.vk.com)** +
**Google Ads (v17, плумбинг/заглушка)**. Протокол — JSON-RPC 2.0 поверх HTTP POST. Аутентификация — секрет в пути.

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

### Google Ads (секреты `GOOGLE_ADS_*`) — ⚠️ требует модерации

| Инструмент | Назначение |
|------------|------------|
| `google_ads_status()` | Проверка готовности (какие секреты заданы). Ключей не требует |
| `google_ads_search(customer_id, query)` | GAQL-запрос (searchStream) |
| `google_ads_request(path, body?)` | Универсальный POST к API v17 |

## Секреты — что нужно и где взять

- `MCP_SECRET` — секрет пути коннектора (генерируется при деплое).
- `YANDEX_DIRECT_TOKEN` — OAuth-токен Яндекс Директ: [oauth.yandex.ru](https://oauth.yandex.ru) →
  приложение с доступом к **API Директа** → получить токен. `YANDEX_DIRECT_LOGIN` — логин клиента
  (заголовок `Client-Login`), нужен для агентского/представительского доступа.
- `VK_ADS_TOKEN` — токен API [ads.vk.com](https://ads.vk.com) (Настройки → Доступ к API).
- **Google Ads** (⚠️ **developer token проходит модерацию Google — это долго**; до одобрения инструменты
  вернут понятную ошибку):
  - `GOOGLE_ADS_DEVELOPER_TOKEN` — из Google Ads API Center.
  - `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET` — OAuth-клиент в Google Cloud Console.
  - `GOOGLE_ADS_REFRESH_TOKEN` — refresh-токен с доступом к Google Ads.
  - `GOOGLE_ADS_LOGIN_CUSTOMER_ID` — ID управляющего аккаунта (MCC), опционально.

Пока реальные ключи не заданы, в GitHub Actions подставляется заглушка `'x'` — деплой зелёный,
а инструмент вернёт понятную ошибку «Не задан секрет …». Инструмент `google_ads_status` работает
без ключей и показывает, чего не хватает.

## Деплой

Пуш в `main` → GitHub Actions (`cloudflare/wrangler-action@v3`) → `wrangler deploy`.
Секреты Cloudflare в GitHub Actions Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
