# Задание исполнителю: Sprint 8.2 — настоящий preview и human approval

Начинай только после `accepted` в [приёмке Sprint 8.1](../operations/SPRINT_8_1_ACCEPTANCE.md).
Реализуй Sprint 8.2 из [активного плана](../roadmap/AGENT_WORKFLOW_SPRINTS.md).
После сдачи остановись; merge, staging deployment и операционную приёмку выполняет архитектор.

## Рабочая область и основание

Только репозиторий `Tsumibito/NavoCMS`; родительские Navi/Payload/charter не нужны.
Возьми свежий `origin/main`, содержащий PR #53 и исправление metadata continuation на границе MCP.
Не начинай со старого feature head и не откатывай изменения CI из PR #54.
Используй ветку `codex/sprint-8-2-real-preview` и отдельный worktree, сохранив чужую работу.
Прочитай `AGENTS.md`, активный план, последнюю приёмку, текущий release workflow,
`staging-operational-runtime`, trusted builder и существующие replay/isolation tests.

## Пользовательский результат

Агент готовит изменение страницы и возвращает защищённую ссылку. Человек видит настоящий
результат с layout, CSS и изображением, подтверждает конкретную сборку. Публикация использует
именно эти готовые файлы. Разрыв соединения или restart не теряет сборку/решение и не дублирует
внешние эффекты. Для доказательства достаточно одной страницы и синтетических данных.

## Сначала архитектурное решение

До реализации оформи ADR: состояния build/review/approval/publish, immutable manifest,
срок действия preview/decision и модель доверия независимой human session.
Зафиксируй ключевой инвариант: OAuth bearer агента с human subject не является доказательством
конкретного человеческого подтверждения и не может сам выпустить approval receipt.
Используй отдельную browser session, явное действие человека и CSRF/replay protection.
Не подменяй гарантию текстом «пользователь согласился» в MCP arguments или произвольным
`kind: human`. Уточни `AGENTS.md`/spec, если абсолютное MCP-only правило конфликтует с этим.
Ссылка из чата должна работать без MCP Apps. Не вводи новую identity platform.

## Объём

1. Перенеси существующий trusted Astro build перед review/approval. Используй имеющиеся
   object storage и manifest bindings; не пиши второй renderer/storage framework.
2. Сделай приватный preview готового output: HTML/CSS, разрешённые assets, expiry, корректные
   относительные ссылки, MIME/CSP и noindex. Preview не становится production publication.
3. Approval привяжи к tenant/site/environment, release hash, output manifest digest,
   policy version и expiry; изменение связанных входов делает прежнее решение неприменимым.
4. Publish продвигает сохранённый immutable output. Сборка после human approval запрещена.
   Если остаются две проверки детерминизма, обе завершаются до review.
5. Долгий build возвращает job/status и переживает disconnect/restart. Используй существующие
   persistent jobs/checkpoints. Не добавляй generic workflow engine ради одного сценария.
6. Убери обход новой approval policy через старый `release_approve` путь. Сохрани явную
   совместимость и версионируй несовместимые публичные contracts; released schemas не менять.

## Критерии сдачи исполнителем

- До подтверждения реально отрисованы layout, CSS и responsive image; capability не раскрыта
  в логах. Проверены expiry, traversal, чужой site и отсутствие публичной индексации.
- SHA-256 каждого опубликованного файла совпадает с review manifest. Spy/transport evidence
  доказывает ноль вызовов build runner при publish, включая повтор/reconcile.
- Human receipt нельзя получить одним MCP bearer. Проверены forged, cross-site, replay,
  revoked и expired receipts, CSRF, изменение manifest/config/policy. Повтор доставки уже
  принятого решения безопасен.
- Kill/restart после durable build checkpoint возобновляет именно этот job, без второго
  внешнего build/publish. Отказ provider сообщает applied/unknown и корректный recovery action.
- Meaningful tests идут через настоящий MCP Client/HTTP boundary для инструментов и через
  browser flow для approval. Прямой вызов сервиса не доказывает наличие поля в tool schema.
  Проверяй также `tools/list`, сериализованный output и клиента без виджета.
- `pnpm check`, PostgreSQL integration без skips и 5 SQL isolation проходят. Новые изменения
  БД получают только новые ordered migrations; проверены fresh install и upgrade.
- Submission содержит точный implementation SHA, PR, CI run, изменённые contracts/migrations,
  результаты и runbook независимой приёмки. Не заменяй evidence фразой «финальный head», если
  после проверки был ещё commit: отдельно назови проверенный код и документационный SHA.

## Проверка архитектором после сдачи

Staging: prepare → actual preview → реальное решение владельца → publish → verify →
restart/reconcile → rollback. Владелец подтверждает конкретный output/release; исполнитель
не выполняет эту траекторию на внешней инфраструктуре самостоятельно. Не писать `accepted`
до завершения проверки. Ограниченная функциональность старых task catalogs фиксируется явно.

## Тестовая среда и CI

Используй [Neon agent-tests](../operations/NEON_AGENT_TESTS.md) и предоставленный helper.
В рамках helper разрешены временные test DB, миграции и provision тестовых ролей строго на
`agent-tests`; не меняй endpoint, права вне test branch или staging/production.
В новом worktree локально подключи существующее зашифрованное `.env.test` и локальный ключ
из рабочей папки CMS через приватную передачу файлов, без вывода и без Git. Если test branch
занята, дождись освобождения lock. Не создавай очередной локальный PG-кластер.

PR держи Draft во время реализации, после локальных проверок и окончательной документации
переведи в Ready. Дождись одного зелёного CI на окончательном head; не делай отдельный push
на каждую строку submission. Если найден дефект, исправь и перепроверь затронутый gate.

## Не входит

Multi-route release, миграция пользовательских сайтов, importer, inline editor, CRM,
произвольный генерируемый runtime-код, SaaS billing и production activation. Эти работы
остаются в последующих спринтах. Внешние secrets/roles/WorkOS/Coolify/Pages/R2 изменения
выполняет принимающий; исполнитель сдаёт код и конкретный runbook.
