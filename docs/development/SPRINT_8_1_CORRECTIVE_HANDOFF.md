# Sprint 8.1 — исправления после независимой приёмки

Статус: **changes requested**. Это продолжение Sprint 8.1, не разрешение начинать Sprint 8.2.
Проверен PR [#53](https://github.com/Tsumibito/NavoCMS/pull/53), head
`58d105af3c6f7e94fbd1855b91671423d3f1f86c`. GitHub CI этого SHA: success,
[проверенный run](https://github.com/Tsumibito/NavoCMS/actions/runs/33989248153).
Merge и staging deploy отложены до исправлений и повторной приёмки.

## Рабочая область

Продолжай в `codex/sprint-8-1-editing-integrity` и существующем PR #53.
Рабочая папка CMS: `/Volumes/Crucial X8/windsurf/Navi/tmp/navocms-corrective-integration`.
Сначала прочитай `AGENTS.md`, [план](../roadmap/AGENT_WORKFLOW_SPRINTS.md),
[исходный handoff](SPRINT_8_1_HANDOFF.md), этот файл и текущий код.

Принимающий добавил локальную тестовую инфраструктуру: `scripts/test-neon.mjs`,
remote-only timeout в `vitest.config.ts`, этот handoff, operational runbook и статус roadmap.
Не удаляй эти изменения как посторонние.
Проверь и включи исходники/документы в корректирующий commit; окружение и ключи не коммить.
Соседние сайты и staging/production не нужны. Merge/deploy остаются у принимающего.

## 1. P1: повтор запроса теряет сведения о внешнем эффекте

Место: `apps/mcp/src/mcp.ts`, `PRE_EFFECT_ERROR_CODES`; `apps/mcp/src/service.ts`,
ветка pending/failed reservation в `idempotentInTransaction`.

Независимое воспроизведение на собранном head через настоящий MCP Client/InMemoryTransport:

1. Создать draft, preparePreview, human approval точного release hash.
2. Provider `publish` успешно возвращает reference/hash и увеличивает счётчик; `verify` возвращает false.
3. `release_publish` с ключом `review-publish-000001` возвращает
   `LIVE_VERIFICATION_FAILED`, `effectState: applied`, рекомендацию reconcile.
4. Повторить тот же tool/input/key. Получается `IDEMPOTENCY_INCOMPLETE`,
   `effectState: none`, текст **No content was published.** Счётчик provider publish остаётся 1.

Это нарушает критерий 7: наличие idempotency reservation не доказывает отсутствие эффекта
первого запроса. Аналогично проверить повтор при pending/unknown/crash.

Приёмка исправления:

- Повтор после applied/failed verification не утверждает, что публикации не было.
- Если durable evidence не позволяет доказать applied/none, возвращается честное unknown.
- Сохраняются понятные status/reconcile действия для того же release hash.
- Повтор и последующий reconcile не дублируют provider effect.
- Регрессии проходят через MCP transport и PostgreSQL persistence; проверить восстановление
  сервиса с тем же хранилищем, а не только один in-memory экземпляр.
- Предэффектная ошибка по-прежнему может сообщать none, когда это действительно доказано.
- Не добавлять новую миграцию автоматически: сначала проверить достаточность существующих
  failure code и release checkpoints. Если нужна миграция — только новая ordered migration.

## 2. P2: большие metadata обходят ограничение ответа

Место: `apps/mcp/src/service.ts::getContent` и `metadataWithoutBody`.
Удаление только `metadata.body` не ограничивает остальные поля.

Воспроизведение: синтетическая organization revision, Markdown `# Test`,
`metadata: { contact: { description: "x".repeat(180000) } }`.
Создание разрешено текущей схемой. JSON результата `getContent` составляет **180603 байта**,
хотя сам Markdown короткий. `content_get` передаёт эту projection без дополнительного budget.

Приёмка исправления:

- Документировать и обеспечить конечный совокупный budget ответа чтения, включая metadata,
  AST, строки/ключи, вложенность и JSON overhead. Не ограничиваться количеством AST-узлов.
- Большие допустимые поля доступны ограниченными запросами либо по документированному
  continuation/reference; не терять их молча и не менять сохранённый документ ради projection.
- Проверить много узлов, большие вложенные metadata, длинные ключи и Unicode; тестировать
  сериализованный tool result. Ограничение и единица измерения должны быть явными.
- Продолжение не расширяет tenant/site scope, привязано к immutable revision.
- Сохранить обратную совместимость или явно оформить contract/compatibility change.

## 3. Уточнить текстовый preview fallback

Виджет честно пишет, что это Markdown proof, но текстовый `review_preview_handoff`
сейчас сообщает только ready/expiry/nothing published. Добавить такое же короткое пояснение
про proof artifact в fallback, чтобы клиент без виджета не принимал его за настоящий design preview.
Проверить текст и structured result через MCP. Настоящий Astro preview остаётся Sprint 8.2.

## Тестовая БД и сдача

Используй [Neon test runbook](../operations/NEON_AGENT_TESTS.md). Отдельный локальный PostgreSQL
кластер больше не требуется. Каждый запуск создаёт чистую временную БД на выделенной ветке;
фиксированные fixture keys не конфликтуют с предыдущим прогоном.

В этом задании разрешён запуск предоставленного помощника: создание/удаление собственной
временной test DB, миграции и provision тестовых ролей на `agent-tests`. Это узкое дополнение
к прежнему запрету внешних изменений; staging/production, параметры Neon и сторонние роли
самостоятельно не менять. Дополнительное разрешение на каждый тестовый запуск не требуется.

1. Сначала добавить regression tests, которые красные на проверенном head для пунктов 1–2.
2. Исправить поведение и выполнить полный `pnpm check` с integration-переменными и 5 SQL
   isolation suites; помощник запускает всё это через одно зашифрованное окружение.
3. Выполнить два последовательных чистых запуска, без ручной пересборки локального PG-кластера.
   Если удалённая сеть требует timeout, сделать обоснованную test-only настройку; не скрывать failures/skips.
4. Обновить ADR/spec и submission по фактическим изменениям. Сохранить прежние принятые
   решения current-head CAS, keyset pagination и диапазон ключей.
5. Обновить PR #53, дождаться CI на окончательном SHA, сообщить SHA/run URL, проверки,
   состояние дерева и оставшиеся ограничения. Не писать accepted до приёмки архитектором.
6. Остановиться. Не merge, не deploy, не начинать Sprint 8.2.
