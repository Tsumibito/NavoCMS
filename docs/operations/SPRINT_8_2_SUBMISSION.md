# Sprint 8.2 submission — Настоящий preview и проверяемое подтверждение

Исполнитель: субагент Sprint 8.2. Статус: `submitted` после корректирующего цикла (первая сдача
вернула три блокера и одно замечание по коду; все закрыты) — приёмка, staging-деплой, реальное
решение владельца и обновление статуса остаются за принимающим архитектором.

## Корректирующий цикл (changes required → resubmitted)

Независимая приёмка head `eb8a904522fe7c02af2b3d965dfe7530ebc7c335` воспроизвела три блокера
(reproduction.log + acceptance-repro.spec.ts) и одно код-замечание; исправления продолжены в этой
же ветке, регрессии добавлены по воспроизведениям.

| # | Дефект | Корень | Исправление | Evidence |
| --- | --- | --- | --- | --- |
| P1-1 | Confirmation capability давала агенту право «решения человека»: обычный fetch без браузера/входа записывал confirmed | URL считался полномочием; CSRF защищает от cross-site, но не доказывает human presence | Confirmation page/endpoint требуют **авторизованную human-сессию** через существующую identity-систему: verified bearer (тот же verifier/resolveAuthorization), `kind: "human"` (агент-сессия отклонена даже с human subject), точный tenant/site, `content:publish`. Без сессии — инструкция логина вместо формы. Receipt связан с `decidedByPrincipalId` + hash-ссылкой `decidedByReference` (identity не хранится) | http.test.ts: anonymous GET/POST → 401; agent bearer → 403; foreign-site bearer → 403; authorized session → decision recorded; confirmation.spec.ts (браузер без токена видит «Human session required», ноль форм); release-workflow.test.ts (нотариально неверный токен → `CONFIRMATION_NOT_FOUND`) |
| P1-2 | Preview CSP запрещал собственные CSS/изображения: заголовок оставался чёрным, SVG naturalWidth=0 | `style-src 'unsafe-inline'` без `'self'`, `img-src data:` без `'self'` | CSP: `default-src 'none'` сохранён, добавлены `style-src 'self' 'unsafe-inline'`, `img-src 'self' data:`, `font-src 'self' data:` — скрипты и чужие origin по-прежнему запрещены. Asset-релей резолвит токен прежде всего по same-origin `Referer` (изоляция двух preview), cookie — fallback; HTML через релей не отдаётся; CSP/noindex/no-referrer на каждом asset | preview-render.spec.ts (Chromium): h1 computed color = rgb(12,34,56), image naturalWidth = 10, inline script заблокирован (ровно одно CSP-нарушение в консоли); два preview в одном браузере рендерят каждый свой CSS (rgb(1,2,3) vs rgb(4,5,6)) при общем cookie |
| P1-3 | Смена approval policy не инвалидирует решение: `changed-policy-v2` сервис успешно одобрял релиз | approveRelease/applyAndVerify сравнивали digest, но не policyVersion | `release_approve` и пред-publish гейт требуют `receipt.policyVersion === текущей approvalPolicyVersion`, иначе `RELEASE_DECISION_STALE` до provider; recovery уже checkpointed `publishing` опирается на durable validation checkpoint, а не на новое решение | release-workflow.test.ts `invalidates the recorded decision when the approval policy changes` (reject на approve+publish со счётчиком publishCount=0; оригинальный сервис завершает workflow) |
| Код | Второй экземпляр сервера считает running-job «умершим» (per-process Map) и запускает дублирующий build; SELECT→INSERT без блокировки | владение job не было durable | `build_job_leases` (в миграции 0013): атомарное приобретение lease + running workflow row в одной транзакции (FOR UPDATE, TTL 15 мин, owner_token per instance); чужой активный lease → второй экземпляр простаивает; истёкший lease → пере-домовление (безопасная recomputation, регистрация идемпотентна); публикационные helper'ы фильтруют workflow_runs по workflow_key релиза | postgres-repository.integration.test.ts: два runtime-экземпляра на одной БД — ровно один run и один lease, второй ждёт; после истечения lease пере-домовлен второму (owner_token меняется, run по-прежнему один); терминальный статус восстановлен; отдельный тест: публикация не трогает running build job |

ADR 0026 дополнен явными пометками «Corrected after independent acceptance» по всем четырём
пунктам; спецификация mcp-editing-v0alpha1 обновлена (session requirement, policy binding, CSP,
Referer-изоляция, lease). Модель доверия зафиксирована честно: receipt доказывает, что в окне
действовала сессия с verified human identity данного сайта; физический клик не доказывается, а
делегированный MCP-доступ никогда не принимается как такая сессия. Interactive browser login
выполняется против существующего authorization server — новой identity platform нет (пункт для
приёмки: провайдер должен выдавать человеку bearer-токен с scope `content:publish`; настройка
провайдера — у архитектора).

## Идентификация изменения

| Поле | Значение |
| --- | --- |
| Репозиторий | `Tsumibito/NavoCMS` |
| База | свежий `origin/main` = `5fab3c0` (`docs: accept Sprint 8.1 and hand off real preview work (#56)`), содержит merge PR #53 (`9317092`), CI-правки PR #54 (`c10a231`) и исправление metadata continuation на границе MCP |
| Ветка / worktree | `codex/sprint-8-2-real-preview`, отдельный worktree `tmp/navocms-sprint-8-2-preview` |
| Implementation commit | `69768a2` (`feat(release): real pre-review preview, independent human confirmation, no-rebuild publication`) |
| Verification commits | `de298a3` (resolver columns + resume polling), `30d8898` (plpgsql column qualification), `352c26f` (exact release binding in test fixture), `b15a3c4`/`bda627e`/`2792d0c` (confirmation gate test ordering) |
| Submission commit | последний коммит ветки (этот файл); фактический head фиксирует принимающий |
| PR | [Tsumibito/NavoCMS#57](https://github.com/Tsumibito/NavoCMS/pull/57) (Draft → Ready по готовности) |
| Архитектурное решение | ADR [0026](../architecture/0026-real-preview-and-independent-human-confirmation.md) — оформлен **до** реализации; индекс ADR обновлён |
| Контракты | `docs/specs/mcp-editing-v0alpha1.md` (tool table, preview/approval boundary, compatibility note); `AGENTS.md` (гарантия независимой human-сессии не является MCP-only) |

Конечное поведение: агент готовит изменение и возвращает две ссылки — preview (настоящая сборка:
layout, CSS, разрешённые изображения) и confirmation. Человек подтверждает конкретную сборку в
независимой браузерной сессии; публикация продвигает именно эти сохранённые файлы без единого
вызова build runner. Разрыв соединения/restart не теряет сборку и решение и не дублирует внешние
эффекты.

Non-goals (как в плане): multi-route release, миграция пользовательских сайтов, importer,
inline editor, CRM, произвольный runtime-код, SaaS billing, production activation. Внешние
secrets/roles/WorkOS/Coolify/Pages/R2 — у принимающего.

## Критерии приёмки → проверки → результат → evidence

| # | Критерий | Проверка | Результат | Evidence |
| --- | --- | --- | --- | --- |
| 1 | До подтверждения реально отрисованы layout, CSS, responsive image; capability не раскрыта в логах; expiry, traversal, чужой site, отсутствие индексации проверены | http.test.ts `serves the built output, relays absolute assets by cookie…`; confirmation.spec.ts (Playwright, браузерный поток) | PASS | built `index.html` + `/_astro/styles.css` отдаются из immutable output; cookie `navocms_preview_token` HttpOnly/SameSite=Lax/Max-Age=expiry; без cookie и для traversal-пути — 404; `X-Robots-Tag: noindex, nofollow, noarchive`, `Cache-Control: private, no-store`, CSP без скриптов; confirmation-страница содержит `noindex` meta и проходит axe WCAG 2.1 AA; capability-токены нигде не логируются (в коде нет логирования токенов) |
| 2 | SHA-256 каждого опубликованного файла совпадает с review manifest; spy/transport evidence ноль вызовов build runner при publish, включая повтор/reconcile | release-workflow.test.ts `builds the trusted staging output before review and never builds during publish or reconcile`; http.test.ts | PASS | `outputManifestDigest` (canonical SHA-256 output map) вычисляется при регистрации и сравнивается с receipt в `release_publish`/`applyAndVerify`; provider при публикации получает files из зарегистрированного артефакта (resolver), deployment ищется по release-hash маркеру; в тестах `startCount === 1` после prepare→approve→publish→reconcile (build runner вызывается ровно один раз, при prepare) |
| 3 | Human receipt нельзя получить одним MCP bearer; forged/cross-site/replay/revoked/expired/CSRF/изменение manifest/config/policy; повторная доставка безопасна | release-workflow.test.ts `requires an independent browser confirmation…`; http.test.ts (cross-site Origin, missing CSRF, re-delivery); postgres-repository.integration.test.ts `persists release confirmations…` | PASS | approve без receipt → `HUMAN_CONFIRMATION_REQUIRED` (в т.ч. через MCP transport в http.test.ts); POST с `Origin: https://evil.example` и без CSRF-cookie → 403; re-delivery решения → `recorded: false`/`already recorded` без второго события;伪造 receipt hash → `recorded: false`, publish остаётся закрыт; expired receipt → `HUMAN_CONFIRMATION_EXPIRED`; digest-mismatch → `RELEASE_DECISION_STALE`; policy version входит в receipt и approval evidence |
| 4 | Kill/restart после durable build checkpoint возобновляет именно этот job без второго внешнего build/publish; отказ provider сообщает applied/unknown | postgres-repository.integration.test.ts `resumes a running pre-review build job after a restart…`; существующие release-workflow тесты (publish-interruption reconcile) | PASS | running build job из «мёртвого» процесса возобновляется новым экземпляром runtime: ровно один run, executor перезапускается, итог (успех/отказ с кодом) пишется durably; provider-failure paths — прежние, дополнены effectState (applied/unknown) из Sprint 8.1 |
| 5 | Meaningful tests через настоящий MCP Client/HTTP boundary и browser flow; tools/list, сериализованный output, клиент без виджета | mcp.test.ts `exposes build and confirmation tools through MCP discovery…`; http.test.ts; confirmation.spec.ts | PASS | `tools/list` содержит `preview_build_status`/`release_confirm_status` с `releaseId` в схеме; вызовы через InMemoryTransport; preview/confirmation проверяются реальными HTTP fetch-запросами и настоящим Chromium (Playwright); сериализованный structuredContent проверяется; виджет не требуется (text fallback) |
| 6 | `pnpm check`, PostgreSQL integration без skips, 5 SQL isolation; новые изменения БД — только новые ordered migrations; fresh install и upgrade | Neon helper: `dotenvx run -f .env.test -- node scripts/test-neon.mjs` (чистая временная БД на прогон: 13 миграций + provision + bootstrap) | PASS (два прогона; см. раздел проверок) | миграция `0013_release_confirmations.sql` — единственное изменение БД; существующие миграции не менялись; fresh install покрывается каждым Neon-прогоном; upgrade — последовательное применение 0001…0013 на той же схеме в том же прогоне |
| 7 | Runbook независимой приёмки (prepare → actual preview → решение владельца → publish → verify → restart/reconcile → rollback) | раздел «Staging runbook» ниже | OPEN для принимающего | см. ниже |

Дополнительные проверки из handoff:

- **«Если остаются две проверки детерминизма, обе завершаются до review»** — двойная сборка
  выполняется в `TrustedAstroBuilder.buildAndRegister` до регистрации, регистрация происходит на
  этапе build job (до approval); publish не запускает ни одной.
- **«Убери обход новой approval policy через старый release_approve»** — `release_approve`
  требует receipt; embedded/proof-only путь (без staging runtime) сохранён для разработки/тестов
  и запрещён в production пиннингом профиля (`assertPinnedProductionProfile`), что зафиксировано в
  спецификации и compatibility note.
- **Обратная совместимость** — `HUMAN_CONFIRMATION_REQUIRED` для клиентов, одобрявших напрямую,
  задокументирован в compatibility note v0alpha1; released JSON Schemas не менялись.

## Migrations, contracts, configuration

- **`0013_release_confirmations.sql`** — таблица `release_confirmations` (token_hash UNIQUE,
  decision/receipt поля с CHECK-ограничениями целостности решения, RLS site_scope, INSERT/SELECT/UPDATE
  для `navocms_app`, UPDATE/DELETE отозваны), SECURITY DEFINER функции
  `resolve_release_confirmation`, `record_release_confirmation` (append-once, идемпотентная
  re-delivery) и расширенная `resolve_release_preview` (release/tenant/site идентификаторы для
  скоуп-загрузки built-артефакта). Существующие миграции не изменялись.
- **Released JSON Schemas** — без изменений; событие `io.navocms.release.human-confirmed.v1`
  использует существующий envelope.
- **Runtime configuration** — новых секретов нет. `NAVOCMS_RUNTIME_PRINCIPAL_ID` теперь требуется
  для всех database-режимов (раньше — только production): trusted runtime строит и читает
  артефакты под service principal вне контекста запроса. Принимающему на staging: убедиться, что
  переменная задана в секретах деплоя (значения не приводятся).

## Проверки (точный head, окружение Neon agent-tests)

| Проверка | Команда / место | Результат |
| --- | --- | --- |
| Полный гейт | `dotenvx run --quiet -f .env.test -- node scripts/test-neon.mjs` — один полный чистый прогон корректирующего head (покрывает fresh install 0001→0013; upgrade-шаг 0012→0013 выполняется внутри той же последовательности) | PASS (exit 0): build, contracts, boundaries, secrets, docs, links, typecheck, build smoke, catalogue, vitest, playwright + 5 isolation suites; временная БД удаляется после запуска |
| Vitest unit+integration | входит в Neon-прогон (`NAVOCMS_NEON_TEST_RUN=true`) | **237/237 passed, 39 files, 0 skipped, 0 failed** — включая новые session/policy/lease regression-тесты (188 локально без БД + 49 PostgreSQL integration) |
| Playwright + axe | входит в `pnpm check` | **9/9 passed** (новые: реальный рендеринг preview с computed style/натуральной шириной изображения/блокировкой скриптов; изоляция двух preview; human-session guard на confirmation flow) |
| SQL isolation | 5 suites внутри помощника | 5/5 «Isolation passed» в каждом прогоне |
| CI GitHub Actions | автоматически на PR; итоговый зелёный run на финальном SHA приводится в финальном ответе исполнителя | принимающий подтверждает CI на merge/head SHA |

Итерации Neon-прогонов до зелёной пары зафиксированы честно: прогон 1 — `42P13` (CREATE OR
REPLACE не может изменить тип возврата `resolve_release_preview`; в 0013 добавлен DROP IF EXISTS
перед пересозданием), прогоны 2–8 — дефекты самих новых тестов (отсутствовавшая колонка
`receipt_expires_at` в resolver-функции, гонка асинхронного resume-executor без опроса, FK
составного биндинга синтетического артефакта, порядок записи решения относительно проверки гейта).
Каждый такой коммит перепроверялся полным прогоном; prod-код этих итераций не менялся после
`de298a3`/`30d8898` (миграция) и `69768a2` (реализация).

## Воспроизведение закрытых дефектов исходного head

1. **Approve одним bearer'ом.** До: `release_approve` с `kind: "human"` токеном одобрял сборку,
   которую человек никогда не видел. Тест `requires an independent browser confirmation…`
   фиксирует отказ `HUMAN_CONFIRMATION_REQUIRED` и разблокировку после решения в браузерной сессии.
2. **Build при публикации.** До: `ensureArtifact` собирал Astro-вывод после approval внутри
   publish. Теперь сборка — job при prepare (до review), publish не вызывает build (spy-счётчики).
3. **Preview = proof-артефакт.** До: человек видел только Markdown proof. Теперь после готовности
   сборки `/previews/:token` отдаёт настоящую страницу и ассеты из immutable output.
4. **Metadata-пропуск MCP-границы** (дефект приёмки 8.1, исправлен принимающим в main) — учтён:
   `preview_build_status`/`release_confirm_status` покрыты тестом через `tools/list` и вызовы
   MCP-клиента, чтобы не повторить класс ошибки «поле есть в сервисе, нет в tool schema».

## Оставшиеся ограничения и known risks

- Два открытых preview в одном браузерном профиле делят последний preview-cookie: ассеты
  резолвятся для последнего открытого preview (задокументировано в ADR/spec; на публикацию не
  влияет). Релит на cookie-pairing, не на Origin — `Origin: null` запросы допускаются только
  вместе с SameSite=Strict cookie, который cross-site недоступен.
- Receipt не содержит identity человека: решение атрибутируется держателю confirmation
  capability (opaque `independent-browser-session` в событии). Владелец capability = тот, кому
  агент передал ссылку; приёмка подтверждает этот модель доверия (ADR 0026).
- Rebuild-after-upgrade: релизы, зарегистрированные до Sprint 8.2, не имеют output manifest
  digest и не публикуются (fail closed) — нужно подготовить новый preview.
- Resume build job в тестах проверен на уровне детектора running-без-executor и durable
  записи результата; полный resume с реальным Astro toolchain остаётся операционной приёмкой на
  staging (runbook ниже).
- Build выполняется в фоне в том же процессе; пул одновременных сборок не ограничен очередью —
  для одной страницы pilot-масштаба это вне риска, но приёмке стоит зафиксировать ожидание.

## Staging runbook (для принимающего)

1. **Миграции:** `pnpm db:migrate` на staging применит `0013_release_confirmations.sql`;
   ожидается «Applied 1 migration(s)». Откат миграции планом не предусмотрен (добавление таблиц
   и функций; обратимо дропом вручную при аварийной необходимости — решение за принимающим).
2. **Deployment prerequisites:** задеплоить точный merge SHA; убедиться, что
   `NAVOCMS_RUNTIME_PRINCIPAL_ID` присутствует в секретах деплоя; `NAVOCMS_REVIEWED_SOURCE_COMMIT`
   и `NAVOCMS_REVIEWED_ASTRO_TOOLCHAIN` — как раньше; `/readyz` должен показать
   `builder.ready=true`.
3. **Authenticated smoke (MCP):** `draft_create` → `preview_prepare` → в ответе `previewUrl` +
   `confirmationUrl` + `build: {status}`; `preview_build_status` до готовности → `building`,
   после → `ready` c `outputManifestDigest`; `GET previewUrl` — настоящая страница с CSS;
   `GET confirmationUrl` — сводка сборки.
4. **Реальное решение владельца:** владелец входит в authorization server в своём браузере
   (interactive login; нужен провайдер, выпускающий человеку bearer со scope `content:publish` —
   настройка на стороне архитектора), открывает confirmation-ссылку, проверяет digest и нажимает
   «Confirm this build». Без входа страница показывает инструкцию логина и не содержит формы;
   ссылка, открытая агентом или обычным fetch, решение записать не может. Агент видит
   `release_confirm_status: confirmed` с `decidedByReference`.
5. **Approval + publish:** `release_approve` (human bearer) — без решения владельца падает
   `HUMAN_CONFIRMATION_REQUIRED`; после решения — approval, затем `release_publish` →
   `published`; build runner не вызывается (в логах деплоя нет новых сборок Pages до публикации —
   deployment создаётся один раз и находится по маркеру).
6. **Restart/reconcile:** перезапустить контейнер между шагами; `preview_build_status` возобновляет
   job; `release_reconcile` после interruption публикации доводит до `published` без второго
   provider-эффекта.
7. **Rollback:** `release_rollback` возвращает предыдущую верифицированную публикацию, обе истории
   сохраняются.
8. **Ожидаемые отказы:** чужой/просроченный/поддельный confirmation токен — 404/410; digest
   изменение сборки после решения — `RELEASE_DECISION_STALE`; публикация без зарегистрированного
   артефакта — `REVIEWED_ASTRO_ARTIFACT_NOT_BUILT`.

## Что требует человека

Владелец открывает confirmation capability URL, сверяет release hash и output manifest digest
(и, по желанию, preview) и нажимает «Confirm this build» — это и есть согласованный объект:
пара (releaseId, releaseHash) + output manifest digest конкретной сборки. Всё остальное —
подготовка, сборка, публикация, проверка — выполняется агентом и принимающим.
