# Sprint 8.1 submission — Надёжное повседневное редактирование

Последующее решение принимающего: **accepted**, см. [независимую приёмку](SPRINT_8_1_ACCEPTANCE.md)
и дополнительное исправление границы MCP. Ниже сохранён отчёт исполнителя на момент сдачи.

Исполнитель: субагент Sprint 8.1. Статус: `submitted` — приёмка, архитектурная проверка,
staging-деплой и обновление статуса остаются за принимающим архитектором.

## Идентификация изменения

| Поле | Значение |
| --- | --- |
| Репозиторий | `Tsumibito/NavoCMS` |
| Базовый коммит (основа с планом) | `c8ead118988029d7c26d8653466554425a6d76e1` (`docs: plan agent workflow sprints and implementation handoff`) |
| Аудированная основа плана | `1b02acd29cab60bb74c9a80a401606c8540260b5` (`main`, предок базового коммита) |
| Ветка | `codex/sprint-8-1-editing-integrity` (создана от базового коммита, не от старого `main`) |
| Implementation commit | `06ab6b8` (`feat(editing): reliable everyday edits with current-head patches and bounded reads`) |
| Корректирующий commit | `5a17b90` (`fix(editing): preserve effect evidence on retries and bound metadata reads`) |
| Submission commit | этот документ и принятие тестовой инфраструктуры идут последними коммитами ветки; принимающий фиксирует фактический HEAD (`git rev-parse HEAD`) |
| PR | [Tsumibito/NavoCMS#53](https://github.com/Tsumibito/NavoCMS/pull/53) |
| Изменённые контракты | `docs/specs/mcp-editing-v0alpha1.md` (bounds, mutation semantics, compatibility note); ADR `docs/architecture/0025-current-head-patch-gate-and-bounded-reads.md`; индекс ADR |

Конечное изменение поведения: правка текста больше не может молча потерять параллельную правку —
patch от не-текущей ревизии возвращает конфликт с координатами текущей головы; перечисление любого
числа документов и чтение любого объёма контента выполняются штатными ограниченными запросами;
ошибки публикации сообщают фактическое состояние внешнего эффекта (applied/unknown/none) вместо
безусловного «No content was published»; валидный preview-handoff отображается как готовый.

Non-goals (без изменений, как в плане 8.1): новый renderer, upload, multi-route build, новый
confirmation receipt, изменения дизайна, импортёр, CRM, SaaS. Publication architecture не тронута —
это scope Sprint 8.2.

## Критерии приёмки → проверки → результат → evidence

| # | Критерий | Проверка | Результат | Evidence |
| --- | --- | --- | --- | --- |
| 1 | Два изменения от r1: первое создаёт r2; второе не делает r1-основанную ревизию текущей молча; conflict + current revision; повторное осмысленное применение сохраняет обе правки; in-memory и конкурентные PostgreSQL транзакции | `pnpm vitest run packages/content/src/engine.test.ts apps/mcp/src/mcp.test.ts apps/mcp/src/postgres-repository.integration.test.ts` | PASS | engine.test.ts `fails closed when a patch is based on a revision that is no longer the variant head`; mcp.test.ts `fails closed with the current head when two edits start from the same base revision` (in-memory service); postgres-repository.integration.test.ts `rejects a concurrent patch from a stale base with the current head and preserves both edits after rebase` (два параллельных `Promise.allSettled` patch-транзакций: 1 fulfilled r2, 1 rejected `REVISION_NOT_CURRENT` с `currentRevisionId` победителя, rebase создаёт r3 с обеими правками) |
| 2 | Replay одного ключа возвращает тот же результат после продвижения head; другой input с тем же ключом отклоняется; явная работа от исторической версии не обходит gate | те же файлы | PASS | mcp.test.ts (см. строку 1: replay `two-edits-patch-0001` → тот же `revisionId`; drift → `IDEMPOTENCY_KEY_REUSED`; поздний patch от r1 → `REVISION_NOT_CURRENT`); postgres integration `replays a completed patch by idempotency key after the head advanced and rejects key reuse with different input` (replay из персистентного `idempotency_records`) |
| 3 | 45 документов через cursor без пропусков/дублей на неизменном наборе; порядок и поведение при параллельных изменениях определены; cursor не расширяет site scope | mcp.test.ts `enumerates 45 documents through cursors without gaps or duplicates`; postgres integration `enumerates 45 documents through search and draft cursors without gaps or duplicates` | PASS | 45/45 уникальных hits и drafts по страницам (in-memory и PostgreSQL keyset); порядок: search `(slug, locale, variant_id)`, drafts `(created_at, variant_id) DESC`; чужой uuid-курсор → пустая страница, не-uuid → `PAGE_CURSOR_INVALID`; поведение при конкурентных изменениях зафиксировано в спецификации и doc-комментариях репозиториев |
| 4 | Документ >25 000 символов читается полностью ограниченными запросами; body не дублируется в metadata; многотысячный AST не обходит budget; контракт указывает пределы | mcp.test.ts `reads a 25k-character document fully through bounded windows without duplicating body`; спецификация `Bounds and redaction` | PASS | `content_get`: окно 20 000, `truncated`, `totalCharacters`, `metadata` без `body`, 100 узлов с `truncatedNodes`/`totalNodes` (fixture из 130+ абзацев); два окна `content_read` собирают источник байт-в-байт; полный текст узла ограничен 20 000; суммарный ответ < 60k символов |
| 5 | Граничные длины ключей покрыты тестами; разрешённый input не падает только на event schema | mcp.test.ts `aligns idempotency key bounds across tools, service, and the event ledger` | PASS | 15 символов: отклонено на tool schema и `IDEMPOTENCY_KEY_INVALID` на сервисе до reservation/policy; 16 символов: сквозной успех, событие с `navoidempotencykey` в ledger. Существующий postgres integration `enforces 16..128 idempotency keys before records are created` (media) подтверждает тот же диапазон в persistence |
| 6 | Валидный `previewed` payload не отображается как Blocked; текстовый fallback сообщает тот же результат; виджет не выдаёт proof page за будущий design preview | mcp.test.ts `reports a valid previewed handoff as ready in text and structured results`; widget-view.test.ts (5 тестов); widget.spec.ts `preview handoff reports a previewed payload as ready…` | PASS | structuredContent `status: "previewed"`, текст содержит "ready" и не содержит "Blocked"; виджет: `Revision is bound`, ссылка capability URL с `rel="noopener noreferrer nofollow"`, срок, явная формулировка «Markdown proof artifact, not the final site design preview»; axe WCAG 2.1 AA без нарушений |
| 7 | После provider success + verification failure клиент получает «applied, verification pending/failed» либо «outcome unknown», не ложное отсутствие публикации; предложен status/reconcile; повторного внешнего эффекта нет | mcp.test.ts `reports provider effect state instead of claiming nothing was published`; обновлённый `exposes only the statically validated Cloudflare recovery code` | PASS | `LIVE_VERIFICATION_FAILED` → текст содержит «applied», `release_reconcile`, без «No content was published»; произвольный provider crash на `release_publish` → outcome unknown + reconcile-подсказка (release hash — idempotency ключ провайдера); `STALE_RELEASE_APPROVAL` до эффекта → прежнее честное «No content was published»; effectState в structuredContent. Отсутствие повторного эффекта подтверждено существующими release-workflow тестами (`publishCalls` счётчики) и `release_reconcile` семантикой |
| 8 | Принимающий повторяет через staging MCP: read → patch → conflict → compare → status | runbook ниже | OPEN для принимающего | раздел «Staging runbook» |

## Migrations, contracts, compatibility

- **Новая миграция не требуется.** Схема БД не менялась: курсоры, head-gate и бюджет чтения
  используют существующие таблицы/индексы (`content_revisions`, `content_variants`). Применённые
  SQL/checksums не изменялись; каталог `packages/persistence-postgres/migrations/` не тронут.
- **Released JSON Schemas не изменялись.** `event-envelope.schema.json` (minLength 16) остался
  якорем; выровнена к нему MCP-граница (16–128) и сервисная валидация.
- **Совместимость (v0alpha1, до стабильного релиза):** ключи 8–15 символов больше не принимаются;
  `content_get` возвращает первое окно и проекцию metadata без `body` (полное чтение — `content_read`);
  `content_search`/`drafts_list` принимают `cursor` и возвращают `nextCursor`; `revision_patch`
  отклоняет не-текущую базу с `REVISION_NOT_CURRENT` + координатами головы. Все пункты описаны в
  compatibility note спецификации. Версия review-ресурса не менялась: projection остался
  совместимым (`previewed` обрабатывается виджетом, легаси-статус сохранён).
- **Runtime configuration:** новые переменные окружения не добавлены; используются существующие
  `NAVOCMS_MCP_*`, `NAVOCMS_OIDC_*`, `NAVOCMS_DATABASE_URL`/`NAVOCMS_MIGRATION_DATABASE_URL`
  (значения не приводятся в соответствии с политикой секретов).

## Локальные проверки и CI

Окружение (корректирующий цикл): выделенная Neon-ветка `agent-tests` (PostgreSQL 18, 0.25 CU,
auto-suspend) через предоставленный помощник `scripts/test-neon.mjs` — чистая временная БД на
запуск, миграции + provision + синтетический bootstrap внутри запуска, удаление базы в finally;
staging/production и соседние проекты не использовались. Node 22, pnpm 10.26.0. Исходный спринт
проверялся на локальном PostgreSQL 17.9-кластере (изолированном, вне репозитория).

| Проверка | Команда | Результат |
| --- | --- | --- |
| Полный гейт | `dotenvx run -f .env.test -- node scripts/test-neon.mjs` — два последовательных чистых запуска + контрольный на финальном SHA ветки | PASS ×3 (exit 0): build, `pnpm check` (contracts, boundaries, secrets, docs, links, typecheck, build smoke, catalogue, vitest, playwright) + 5 isolation suites; временная БД удалялась после каждого запуска |
| Unit + integration vitest | входит в Neon-прогоны (`NAVOCMS_NEON_TEST_RUN=true`, test-only timeout 180 с для удалённых round trips) | **226/226 passed, 39 files, 0 skipped, 0 failed** в контрольном прогоне на финальном SHA (те же счётчики в первом прогоне; второй — exit 0 без сбоев) |
| Visual/a11y (playwright + axe) | входит в `pnpm check` | **6/6 passed** в контрольном прогоне (и в первом) |
| Tenant isolation | 5 SQL suites внутри помощника | 5/5 «Isolation passed» во всех прогонах |
| CI GitHub Actions | [run 33992480249](https://github.com/Tsumibito/NavoCMS/actions/runs/33992480249) на `e42628dfce182b87dda326d6399d3af482074075`: **success** | PASS; промежуточный упавший run 33992299882 — недетерминизм самого конкурентного теста (зафиксирован и исправлен отдельным test-only коммитом), повтор прогнал success; принимающий подтверждает CI на merge/head SHA |

Повторные прогоны не конфликтуют: помощник создаёт чистую временную БД на каждый запуск, поэтому
фиксированные fixture-ключи не встречают записей предыдущего прогона (два последовательных чистых
запуска выполнены без пересборки локального кластера).

## Воспроизведение исправленных ошибок (до/после)

1. **Lost update.** До: `engine.patchRevision` от r1 после создания r2 молча выпускал r3
   (head-независимая нумерация), r2 выпадал из текущего текста. Тест фиксирует
   `REVISION_NOT_CURRENT` + `details.currentRevisionId/Number/SourceHash`.
2. **Перечисление.** До: `content_search` жёстко отдавал первые ≤20 строк без курсора; 45
   документов перечислить было нечем. Тест требует 45/45 за страницы без дублей.
3. **Дублирование body.** До: `getContent` возвращал `metadata.body` целиком + все AST-узлы
   (fixture 25 009 символов давал ~46k символов ответа) без продолжения чтения. Тест фиксирует
   отсутствие `body`, окно 20k, сборку полного текста двумя окнами.
4. **Короткий ключ.** До: 13–15-символьный ключ проходил tool schema и падал на
   `ContractValidationError: Invalid event envelope` после подготовки мутации. Теперь —
   `IDEMPOTENCY_KEY_INVALID` до reservation/policy charge, диапазон 16–128 везде.
5. **Blocked-виджет.** До: `renderWorkflow` ожидал `ready-for-workflow`, валидный `previewed`
   показывался как Blocked, ссылка не отображалась. Теперь — Ready + capability URL + честная
   формулировка про proof-артефакт.
6. **Ложное «No content was published».** До: `safeTool` приписывал этот текст любой ошибке,
   включая `LIVE_VERIFICATION_FAILED` после реально применённого артефакта. Теперь —
   effectState `applied`/`unknown`/`none` с reconcile-подсказкой.

## Оставшиеся ограничения и known risks

- Клиенты с ключами 8–15 символов получат ошибку валидации — осознанный breaking change внутри
  v0alpha1, задокументирован в спецификации.
- Курсорное перечисление черновиков при параллельных правках может сдвигать строки между
  страницами (позиция черновика движется вперёд); гарантируется отсутствие дублей на неизменном
  наборе и корректность каждого полного прохода. Снимок на момент первого запроса не
  гарантируется — это задокументированное поведение, не дефект.
- Rebase после `REVISION_NOT_CURRENT` требует новый idempotency key (прежний — failed reservation);
  это fail-closed дизайн идемпотентности.
- In-memory репозиторий пересчитывает страницу из полного набора (O(n) на страницу) — это
  development-адаптер; production путь — PostgreSQL keyset-запросы.
- Capability URL рендерит Markdown proof-артефакт; настоящий design preview — Sprint 8.2. Виджет
  формулирует это явно.
- CI на PR: принимающий должен убедиться, что зелёный прогон принадлежит точному merge/head SHA.

## Корректирующий цикл (changes requested → resubmitted)

Приёмка PR #53 (head `58d105af3c6f7e94fbd1855b91671423d3f1f86c`) вернула два дефекта и одно
уточнение; исправления продолжены в этой же ветке (корректирующие коммиты после implementation
и submission коммитов), регрессии сначала добавлены красными на проверенном head.

| # | Дефект приёмки | Корень | Исправление | Evidence |
| --- | --- | --- | --- | --- |
| P1 | Повтор `release_publish` тем же ключом после applied + verification failure возвращал `IDEMPOTENCY_INCOMPLETE` с `effectState: none` и текстом «No content was published» — ложное обещание при возможном внешнем эффекте первой попытки | Ветка `pending/failed` в `idempotentInTransaction` не различала transactional и provider-crossing операции | Сообщение incomplete reservation теперь строится из типа операции: для transactional — доказанный `none`; для provider-crossing (`release_publish/reconcile/rollback`) — `effectState: unknown`, recorded error code, указание `release_status`/`release_reconcile` (без повторного provider-эффекта) и запрет переиспользовать ключ. `safeTool` отдаёт это сообщение и `nextAction` в structuredContent | mcp.test.ts `keeps applied-effect evidence when a retry meets an incomplete reservation` (MCP transport: retry → `IDEMPOTENCY_INCOMPLETE`/`unknown`, без «No content was published», `publishCalls === 1`; reconcile → `published`, `publishCalls === 1`), `reports an unknown effect state while a non-transactional reservation is pending` (pending-ветка); postgres integration `preserves applied-effect evidence across service restart after verification failure` (перезапуск сервиса на том же durable store, reconcile после восстановления верификации) |
| P2 | `metadata: { contact: { description: "x".repeat(180000) } }` на organization проходил схему, и `content_get` отдавал ~180 КБ при коротком Markdown | Проекция удаляла только `metadata.body` и не имела собственного бюджета | Бюджет метаданных 4 000 сериализованных JSON-символов на ответ (UTF-16 code units, ключи отсортированы): поля включаются целиком, негабаритные — исключаются целиком и перечисляются в `metadataTruncated`/`metadataTotalCharacters`/`metadataOmittedKeys` (без разрезания значения и без изменения сохранённого документа). Новый режим `content_read { metadataKey }` отдаёт omitted значение ограниченными окнами в рамках immutable revision и site scope | mcp.test.ts `bounds the read response budget across metadata and offers a bounded metadata continuation` (180 КБ fixture: ответ < 60 КБ, без гигантской строки; полная сборка значения из окон; unicode-значение с 500 эмодзи и ключ 300+ символов через выровненное окно; `METADATA_KEY_NOT_FOUND` для отсутствующего ключа) |
| P3 | Текстовый fallback `review_preview_handoff` не пояснял, что capability URL рендерит proof-артефакт, а не настоящий design preview | Fallback дублировал только ready/expiry | Fallback дополнен той же формулировкой, что и виджет: «It renders a Markdown proof artifact, not the final site design.» | mcp.test.ts `reports a valid previewed handoff as ready…` проверяет текст через MCP client |

Дополнительно обновлены: спецификация `mcp-editing-v0alpha1.md` (metadata budget, `metadataKey`
continuation, retry-семантика incomplete reservation, proof-формулировка fallback, compatibility
note) и ADR 0025 (два новых пункта Decision + Consequences). Принятые ранее решения — current-head
CAS, keyset pagination, диапазон ключей 16–128 — не менялись. Новая миграция не потребовалась:
для исправления P1 достаточно существующих `idempotency_records.status/error_code` и release
checkpoints.

Инфраструктура принимающего (Neon test-помощник `scripts/test-neon.mjs`, remote-timeout в
`vitest.config.ts`, corrective handoff, Neon runbook, статус roadmap) включена в корректирующий
PR без изменений; `.env.test`/`.env.keys` остаются локальными и в Git не попадают. Финальные
прогоны выполнены на Neon `agent-tests` (чистая временная БД на запуск): результаты — в разделе
«Локальные проверки и CI» ниже.

## Staging runbook (для принимающего)

1. **Миграции:** новых нет. После деплоя выполнить штатную проверку `pnpm db:migrate` — ожидается
   «NavoCMS schema is current.» (все 12 миграций уже в реестре staging).
2. **Deployment prerequisites:** существующие staging секреты/конфигурация без изменений
   (dotenvx-файлы не трогались); деплой точного SHA ветки после merge.
3. **Authenticated smoke (MCP-клиент под `content:read`+`content:draft`+`content:publish`):**
   - `sites_list` → 1 авторизованный сайт;
   - `content_search {query:"", limit:3}` → 3 результата + `nextCursor`;
     `content_search {limit:3, cursor}` → следующие 3, без дублей;
   - `draft_create` (ключ ровно 16 символов) → r1; повтор того же вызова → тот же результат;
   - `content_get` → `metadata` без `body`, `markdown` ≤20k, `truncatedNodes`/`totalNodes`;
   - `revision_patch` replaceText по узлу r1 → r2;
   - `revision_patch` от r1 ещё раз → ошибка `REVISION_NOT_CURRENT`, structuredContent содержит
     `currentRevisionId`/`currentRevisionNumber`/`currentSourceHash` (координаты r2);
   - `content_read {revisionId:r2, nodeId}` → полный текст узла; `content_read {markdownOffset}`
     → окно;
   - `revision_compare r1→r2` → ограниченный diff с точными хэшами;
   - `review_preview_handoff` → текст «ready», structuredContent `status:"previewed"`, expiring
     capability URL;
   - `release_status` до/после шагов публикации.
4. **Ошибочные сценарии:** не-uuid `cursor` → `PAGE_CURSOR_INVALID`; ключ 15 символов →
   отклонение tool-валидации; patch со случайным хэшем → `REVISION_CONFLICT`; patch от старой
   базы → `REVISION_NOT_CURRENT`; `release_publish` с неверным hash → `STALE_RELEASE_APPROVAL` +
   «No content was published»; после verification failure повтор `release_publish` тем же ключом →
   `IDEMPOTENCY_INCOMPLETE` с `effectState: "unknown"`, записанным кодом ошибки и подсказкой
   `release_status`/`release_reconcile` (текст НЕ утверждает «No content was published»);
   `content_get` черновика с крупными метаданными → ответ в бюджете,
   `metadataOmittedKeys` перечисляет негабаритные поля; `content_read { metadataKey }` дочитывает
   их окнами; текст `review_preview_handoff` содержит «Markdown proof artifact, not the final
   site design».
5. **Restart/reconcile/rollback:** перезапустить MCP-контейнер между approve и publish →
   `release_reconcile {releaseId, releaseHash}` доводит до `published` без второго вызова
   провайдера (провайдер идемпотентен по release hash); для verification-failed сценария
   `release_reconcile` только перепроверяет; `release_rollback` возвращает предыдущую
   верифицированную публикацию, обе истории сохраняются.
6. **Ожидаемые результаты:** ни один сценарий не теряет правку молча; ни одна ошибка после
   внешнего эффекта не формулируется как «No content was published»; курсоры не возвращают
   контент чужого сайта.

## Что требует человека

Human approval публикации: принимающий/владелец под human-принципалом выполняет
`release_approve` для **конкретного объекта** — пары `releaseId` + `releaseHash` (и связанного
`artifactHash`) из предшествующего `preview_prepare`, после просмотра capability URL. Автоматический
self-approval агент-принципалом по-прежнему запрещён; смена любого байта контента или истечение
срока одобрения делают approval недействительным.
