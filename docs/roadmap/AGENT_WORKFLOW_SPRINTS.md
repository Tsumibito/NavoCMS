# Ближайшие спринты: работающий агентный редактор реального сайта

Дата планирования: 2026-09-05. Статус: утверждённое направление работ; реализация и приёмка не начаты.

Основание: аудит `main` на `1b02acd29cab60bb74c9a80a401606c8540260b5` и поручение владельца
подготовить задания исполнителю. Этот документ задаёт ближайший порядок работ вместо перехода
непосредственно к прежнему Sprint 9 — Webstudio importer. Исторические результаты Sprints 0–8
сохраняются; новые номера 9.1–9.3 относятся к этому плану, а не к старому импортёру.

## Цель программы

Владелец из обычного MCP-клиента понимает устройство своего сайта, меняет текст, данные,
изображения и разрешённый дизайн, видит настоящий результат, подтверждает публикацию и может
вернуться к предыдущему состоянию. Работа не требует терминала, SQL и знания внутреннего
устройства NavoCMS. Новые функции сайта позже проходят отдельный контролируемый процесс разработки.

## Роли, границы и порядок сдачи

- **Исполнитель/субагент:** реализация назначенного спринта, миграции, meaningful tests,
  документация, commit и PR. Не объединяет свой PR, не деплоит, не меняет внешние роли,
  секреты, staging/production БД, DNS или сервисы.
- **Принимающий архитектор — основной агент этой задачи:** независимая проверка кода и
  критериев, архитектурные решения, возврат замечаний, merge проверенного изменения,
  staging migrations/deploy и операционная приёмка. Также ведёт следующие изменения архитектуры.
- **Владелец:** продуктовая оценка настоящего preview и human confirmation там, где этого
  требует release policy. Назначение принимающего агента не заменяет решение человека.

Один спринт выполняется последовательно. Исполнитель не начинает следующий, пока принимающий
не запишет `accepted`. Допускаются несколько небольших PR внутри спринта; они не закрывают
спринт по отдельности. Принимающий проверяет фактический head, а не только отчёт исполнителя.

Указанные объёмы — границы задач, не обещание фиксированных дат. Если спринт не помещается
примерно в 1–2 недели, исполнитель предлагает разбиение, сохраняя конечный gate. Нельзя
самостоятельно ослабить критерий или заменить PostgreSQL/реальную публикацию mock-проверкой.

### Рабочая область

Работать только в отдельном репозитории **Tsumibito/NavoCMS**. Он содержит собственные
`AGENTS.md`, `.git`, `package.json`, `apps/`, `packages/`, `schemas/`, `docs/` и `deploy/`.
Соседние Navi, Payload, charter и Webstudio каталоги не являются исходниками CMS.

Принимающий предоставляет обезличенный pilot bundle, когда спринт требует модель реального
сайта. Исполнитель не читает и не копирует пользовательские сайты, production exports,
секреты и персональные данные из родительских каталогов. До предоставления bundle можно
подготовить только общую часть; pilot gate остаётся открытым.

Для кода использовать отдельную ветку `codex/sprint-<номер>-<тема>` и предпочтительно отдельный
worktree. Не менять ветку или файлы другого активного исполнителя. Перед стартом сверить
рабочее дерево, исходный SHA, текущий `main` и наличие этого плана; не выполнять destructive reset.

### Общие критерии каждого спринта

1. Есть commit SHA, список затронутых контрактов, объяснение конечного поведения и явные non-goals.
2. Архитектурное изменение сопровождается ADR; schemas — спецификацией, fixtures,
   compatibility note и версионированием при несовместимом изменении.
3. Изменение БД получает новую ordered migration. Существующие применённые SQL/checksums
   неизменны; состояние после upgrade и isolation проверено. Действующий CMS migrator сам
   обнаруживает пронумерованные SQL; не переносить сюда Payload `prodMigrations`.
4. `pnpm check` проходит. Обязательные PostgreSQL integration/RLS checks проходят в test DB
   или CI того же SHA без skips. Пропуск тестов явно указан и не считается pass.
5. Для UI — desktop/mobile, доступность, состояния ошибок и реальный tool-result payload;
   для release — негативные сценарии, восстановление после прерывания и отсутствие дублей.
6. Добавления сохраняют tenant/site scope, dotenvx, редактируемые только через review контракты,
   portable Markdown, audit trail и независимость content deploy от Coolify runtime deploy.
7. Секреты, unrestricted PII и полный пользовательский контент не попадают в logs/evidence.
8. Документация описывает текущую реализацию, отдельно от намерений. Никакого автоматического
   закрытия исторических/новых gates по одному merge или зелёным unit tests.

### Статусы

`planned → implementing → submitted → code-accepted → staging-verified → accepted`.
`changes-requested` возвращает работу исполнителю. `blocked` сопровождается конкретной
внешней зависимостью и незакрытыми критериями. `code-accepted` не означает `accepted`.

После code acceptance принимающий сравнивает кандидат с актуальным main, проверяет CI,
объединяет PR, повторно проверяет итоговый merge SHA, применяет необходимые staging migrations,
деплоит точный SHA и выполняет authenticated smoke + сценарии спринта. Ошибка deployment
возвращает операционный gate в открытое состояние. Production cutover не входит в эти спринты.

## Sprint 8.1 — Надёжное повседневное редактирование

**Цель:** обычные изменения не теряются, агент может полностью обследовать контент,
а ошибки сообщают фактическое состояние операции.

**Объём:**

- expected-current-revision/head и атомарная защита от изменения устаревшей основы;
- cursor pagination в search/drafts; чтение длинного контента по частям/узлам;
- проекция metadata без дублирования полного body, ограничение суммарного ответа/AST;
- согласованные ограничения idempotency keys на MCP/service/events/persistence;
- исправление preview widget: реальные статусы, доступная ссылка и честные ограничения;
- ошибки с effect state, retryability и безопасным следующим действием; убрать безусловное
  «No content was published» для ошибок после внешнего эффекта;
- актуализация затронутых MCP specs/README и executable regressions.

**Критерии приёмки:**

1. Два разных изменения от r1: первое создаёт r2; второе не делает основанную на r1 ревизию
   текущей молча. Возвращает conflict + current revision; повторное осмысленное применение
   сохраняет обе правки. Проверить in-memory и конкурентные PostgreSQL транзакции.
2. Replay одного ключа возвращает тот же результат даже после продвижения head; другой input
   с тем же ключом отклоняется. Явная работа от исторической версии не обходит current-head gate.
3. 45 документов перечисляются через cursor без пропусков/дублей на неизменном наборе;
   определён порядок и поведение при параллельных изменениях. Cursor не расширяет site scope.
4. Документ более 25 000 символов читается полностью через ограниченные запросы; body не
   дублируется в metadata. Многотысячный AST не обходит budget. Contract указывает пределы.
5. Граничные длины ключей покрыты тестами; разрешённый input не падает только на event schema.
6. Валидный `previewed` payload не отображается как Blocked. Текстовый fallback сообщает
   тот же результат; виджет не выдаёт proof page за будущий настоящий design preview.
7. После simulated provider success и verification failure клиент получает «applied, verification
   pending/failed» либо «outcome unknown» согласно evidence, но не ложное обещание отсутствия
   публикации. Предложен status/reconcile; повторного внешнего эффекта нет.
8. Принимающий повторяет через staging MCP: read → patch → conflict → compare → status.

**Не входит:** новый renderer, новый upload, multi-route build, новый confirmation receipt,
изменения дизайна, импортёр, CRM, SaaS. Следующий спринт не начинать.

**Стартовое задание:** [SPRINT_8_1_HANDOFF.md](../development/SPRINT_8_1_HANDOFF.md).

## Sprint 8.2 — Настоящий preview и проверяемое подтверждение

**Зависимость:** 8.1 accepted. **Цель:** человек видит именно ту сборку, которая будет опубликована.

**Объём:**

- перенести trusted Astro build до review/approval, хранить immutable output и manifest;
- защищённый preview настоящего HTML/CSS/media с корректными CSP, expiry и noindex;
- отделить подготовку preview provider от production publication;
- publication продвигает сохранённый output, без новой сборки после approval;
- отдельное подтверждение человеком, привязанное к site/environment/release/output/policy/expiry;
- durable build status и восстановление долгой операции после разрыва MCP-соединения.

До кода — ADR об identity versus approval. Принятый по умолчанию путь: защищённая
страница подтверждения с независимой browser session, human action и защитой от CSRF/replay;
MCP может запросить/прочитать решение, но его bearer не может сам выпустить receipt.
Host-attested confirmation возможен позднее при доказанной поддержке клиента. Web-ссылка
с текстовым handoff должна работать и без MCP Apps. Обновить старое абсолютное требование
«все core workflows только MCP», если оно конфликтует с этой явно заявленной гарантией.

**Критерии приёмки:**

1. До согласования видны настоящий layout, CSS, responsive image и нужные ссылки. Preview
   не требует публично индексируемого deployment; capability/token не попадает в журналы.
2. Manifest output файлов до approval совпадает с опубликованным; build runner не вызывается
   при publish. Если два deterministic builds сохраняются, оба завершены до review.
3. Изменение кода/design/content/media/config или истечение подтверждения требует нового
   корректного кандидата/решения согласно контракту; старое approval не подходит.
4. OAuth агента от имени human не позволяет выполнить self-approval. Cross-site, replay,
   forged, revoked и expired receipts отклоняются. Повторная доставка принятого решения безопасна.
5. Долгий build возвращает job/status и переживает disconnect/restart; нельзя запустить
   дублирующий build/publish обходом idempotency. Минимальный persistent worker допустим;
   новый универсальный workflow framework без необходимости не добавлять.
6. Принимающий проигрывает staging prepare → real preview → human decision → publish →
   verify → restart/reconcile → rollback. Evidence содержит hashes и внешние deployment IDs.

**Не входит:** autonomous publication policy, универсальный identity provider, код от LLM
в production, полноценный importer или business modules. Одной проверенной страницы достаточно
для этого gate; полный сайт следует в 8.3.

## Sprint 8.3 — Целостный релиз сайта и законченный путь фотографии

**Зависимость:** 8.2 accepted. **Цель:** правка страницы сохраняет остальные страницы и изображения.

**Объём:**

- site release snapshot с текущими published revisions остальных страниц и явно включёнными drafts;
- routes/locales/navigation/shared sections/redirects/assets как часть manifest;
- scoped upload session с expiry, size/type/hash checks, без bytes/base64 в LLM context;
- автоматическая подготовка разрешённых responsive variants и сохранение media bindings при patch;
- immutable media delivery URLs/files вместо масштабирования staging data-URI workaround;
- проверка route delta относительно предыдущего site release и минимальные regression fixtures.

**Критерии приёмки:**

1. Fixture: минимум 5 страниц, 2 локали, shared navigation/footer, redirect и 2 изображения.
   Публикация изменения одной страницы сохраняет остальные маршруты и опубликованный контент;
   unrelated drafts не выходят в live. Удаление маршрута требует явного изменения и policy.
2. Параллельные site releases проверяют expected published release: устаревший snapshot
   не отменяет чужую уже опубликованную страницу. Повторное построение кандидата явно.
3. Пользователь загружает JPEG/PNG по защищённой ссылке или поддерживаемому attachment bridge;
   подготовка вариантов и связывание выполняются штатно без оператора с доступом к bucket.
4. Текстовая правка сохраняет media selection, alt/purpose и воспроизводимость предыдущей версии;
   заменённое изображение не портит старый release/rollback. Проверяется в PostgreSQL.
5. Cross-site upload/finalize/reference, просроченные сессии, неверный hash/type/size отклоняются;
   interrupted upload/finalize не создаёт дубли; cleanup ограничен своими объектами.
6. Gate сравнивает полный route inventory, локали, redirects и обязательный shell. Для реального
   Navi pilot consent/analytics проверяются поведением браузера, не наличием `meta`-маркеров.
7. Принимающий проверяет staging site-wide publish и rollback, live media/cache и сохранность
   всех unaffected routes. Фактические size limits и baseline времени записаны в отчёте.

**Не входит:** Webstudio/Webflow import, universal CDN, arbitrary external URL ingest, каталог
любого размера. Limits корректировать по размеру предоставленного pilot bundle с проверками.

## Sprint 9.1 — Паспорт сайта и работа с его реальной моделью данных

**Зависимость:** 8.3 accepted. **Цель:** новый агент понимает сайт через MCP, без изучения репозитория.

**Объём:**

- bounded site context: назначение, permissions, capabilities, routes, schemas, components,
  dependencies, integrations, source-of-truth и версии;
- поиск/чтение схем и отношений, component catalogue/examples, impact/dependency queries;
- schema-aware creation и metadata/field mutations для зарегистрированных типов вместо enum;
- минимум один реальный тип из обезличенного pilot bundle и его связь с другой сущностью;
- invalid field/relationship errors с адресом поля и безопасной подсказкой.

**Критерии приёмки:**

1. В чистой сессии агент объясняет page → section → component → field/data source,
   определяет локали, ограничения и владельца данных с ссылками на canonical IDs.
2. Регистрация проверенного нового типа/pack не требует правки enum MCP; агент читает schema,
   создаёт и изменяет валидную запись, получает actionable error для invalid input.
3. Обновляются title/metadata и связанные поля, а не только Markdown. Сохраняются head checks,
   validation, immutable revisions, scope и audit. Изменение schema не является обычным field patch.
4. Dependency query на общий компонент/сущность показывает все затронутые страницы fixture,
   с pagination и без данных другого сайта. Свежесть паспорта связана с версиями contracts.
5. Текст контента/комментариев не может изменить tool permissions, policy или trusted site rules.
6. Принимающий проводит три незнакомые исполнителю задачи через штатный staging MCP;
   агент не получает доступ к filesystem, SQL или неописанным полям production.

**Не входит:** graph database, marketplace/plugin host, runtime schema editing без migration,
CRM write, импорт реальных персональных данных. Pilot gate требует bundle от принимающего.

## Sprint 9.2 — Управление готовым дизайном и точечное редактирование

**Зависимость:** 9.1 accepted. **Цель:** пользователь меняет страницу и её разрешённый дизайн
через разговор или небольшую защищённую форму с одним общим механизмом revisions.

**Объём:**

- page composition: stable section/component/field IDs, slots, props, content references;
- выбор существующих recipes/variants и bounded design tokens без произвольного runtime code;
- минимальная страница прямого редактирования текста и комментариев к конкретному элементу;
- общий change-set: affected objects, before/after, base versions, preview, validation, status;
- изменение из UI сразу проходит тот же application service; агент узнаёт durable результат.

**Критерии приёмки:**

1. Команда «сделай этот блок компактнее» выбирает разрешённый variant, сохраняет дизайн-систему
   и даёт настоящий preview. Перестановка секций не теряет поля/ссылки/устойчивые IDs.
2. Неподдерживаемый дизайн не внедряет CSS/JS тайком: выдаёт запрос на development change
   с конкретным недостающим capability, пока без реализации общего coding executor.
3. Комментарий хранит site/revision/page/element/field и при необходимости viewport;
   после удаления элемента становится явно unresolved/orphaned, не привязывается к соседнему.
4. Одновременная правка из UI и агента даёт conflict/rebase по 8.1, без потери изменений;
   сохранение не требует вызова модели, но создаёт ревизию и событие.
5. Все ссылки требуют правильного scope; session expiry, revocation и read-only role работают.
   UI не получает произвольный доступ к БД/секретам.
6. Desktop/mobile/accessibility и real payload tests проходят. Клиент без embedded UI получает
   рабочие web links и текстовые summaries, пригодные для продолжения в новом разговоре.
7. Принимающий проверяет text edit, variant change, section move, anchored comment и конфликт
   на pilot staging; никакой новой схемы consent/analytics shell вместо существующего контракта.

**Не входит:** полноценный визуальный builder, произвольные новые компоненты, сложные админки,
realtime collaboration, генерация всего frontend с нуля.

## Sprint 9.3 — Пилот, воспроизводимая установка и восстановление

**Зависимость:** 9.2 accepted. **Цель:** обычная эксплуатация работает без автора CMS.

**Объём:**

- один поддерживаемый self-hosting профиль, bootstrap/site identity setup, doctor и connection guide;
- минимальный экспорт и восстановление согласованного site bundle с DB/object storage versions;
- upgrade от принятого предыдущего релиза и проверка совместимости runtime/migrations;
- browser/MCP operating guide, owner, release alerts, backup schedule, измеренные RPO/RTO;
- реальные agent task evaluations в двух явно названных MCP-клиентах, включая ChatGPT,
  если он входит в обещание первого поддерживаемого продукта;
- rehearsal подключения и явного выбора двух отдельно авторизованных сайтов. Если единого
  entrypoint ещё нет, это ограничение честно документируется; gateway — отдельный последующий gate.

**Критерии приёмки:**

1. Чистая установка из documented release на независимом окружении до первого preview
   выполняется по инструкции без ручного SQL автора и undocumented private files.
   Пользователь сам вводит/подключает нужные аккаунты и encrypted secrets; значения не логируются.
2. Явно указано, какие внешние сервисы обязательны в поддерживаемом профиле и какие заменяемы;
   не заявлять полностью offline/self-contained установку без соответствующего испытания.
3. Из backup восстановлены content, contracts, site release, assets/references и нужная история;
   hashes/route inventory совпадают. Ключи и PII имеют отдельную разрешённую процедуру.
4. Повторный bootstrap/upgrade безопасен; миграционная ошибка останавливает activation;
   runtime rollback не обещает автоматически обратить необратимую миграцию данных.
5. Десять задач на клиент, минимум два чистых прогона на поддерживаемый клиент: текст, фото,
   создание страницы, metadata, связанная запись, design variant, direct edit conflict,
   anchored comment, resume после disconnect, rollback. Это вызовы реальной модели через MCP,
   а не запрограммированный маршрут из заранее известных tool calls.
6. Не менее 90% задач завершаются без shell/SQL автора; ноль потерянных правок, cross-site
   доступа и незаявленных публикаций. Отдельно записаны tool calls, tokens/cost при доступности,
   elapsed time и human interventions. Для text-to-preview цель median ≤3 минут; при провале
   измерить причину и вернуть gate, не исключать медленные попытки.
7. Пользователь работает с пилотом не менее 7 дней; все блокирующие ошибки закрыты. Production
   cutover имеет отдельную приёмку URL/SEO/locale/consent/forms и владельца, он не подразумевается
   просто успешным staging. Импорт реального сайта делается только по отдельному заданию.

**Не входит:** billing, marketplace, массовая миграция всех сайтов, universal importer,
enterprise multi-tenant operations. Полный pilot bundle выбирается принимающим до старта.

## После ближайших спринтов: архитектурная очередь

Эти работы пока не разрешены исполнителю и будут детализированы принимающим по результатам пилота.

1. **Development change workflow:** один новый компонент через изолированный исполнитель,
   reviewed repository change, tests/build/preview, привязанный source commit и явное принятие.
   Агент пользователя продолжает работу из исходного клиента; новые capabilities возвращаются
   в discovery. Runtime установка unreviewed packages запрещена. Никакого универсального
   auto-coding SaaS до первого ограниченного успешного задания.
2. **Один business module:** schema + migration + scoped domain operations + таблица/форма +
   permissions + health/export, затем один нужный CRM adapter. Content releases и транзакционные
   данные имеют разные жизненные циклы; rollback страницы не отменяет полученные заявки.
3. **Третий сайт и единый выбор сайтов:** проверенная membership routing, разные profiles,
   отсутствие site forks, clean export/restore. Затем OSS release и отдельные SaaS gates.
4. **Голосовые/текстовые агенты на сайте:** версионированная конфигурация отдельного runtime,
   ограниченные инструменты, provider credentials, budget и отключение. Visitor auth отделён
   от operator OAuth. Добавлять по конкретному пилотному сценарию.

Старый roadmap остаётся источником задач SEO/localization/import/forms/operations, но их порядок
теперь определяется выбранным пилотом. SEO, URL parity, consent и restore обязательны до cutover;
необязательные integrations не должны задерживать проверку основного интерфейса.

## Формат сдачи

Исполнитель создаёт `docs/operations/SPRINT_<номер>_SUBMISSION.md` со следующим содержимым:

- source/base/head SHA, branch, PR URL при наличии и конечное изменение поведения;
- таблица «критерий → конкретный тест/команда → результат → artifact/evidence»;
- migrations/contracts/compatibility и необходимые runtime configuration names без значений;
- локальные и CI результаты с skipped/failed checks и причиной;
- reproduction исправленных ошибок, оставшиеся ограничения и known risks;
- точный staging runbook: миграция, deployment prerequisites, authenticated smoke,
  сценарии ошибок, restart/reconcile/rollback и ожидаемые результаты;
- что требует человека и какой точный объект будет согласовываться.

Принимающий отдельно создаёт acceptance record с reviewed SHA, замечаниями, merge SHA,
CI/deployment IDs, выполненными сценариями и решением. Исполнитель не редактирует это решение.

## Текущее состояние

| Спринт | Состояние | Условие старта |
| --- | --- | --- |
| 8.1 | Planned, ready to assign | Прочитать handoff и подтвердить baseline |
| 8.2 | Planned | 8.1 accepted |
| 8.3 | Planned | 8.2 accepted |
| 9.1 | Planned | 8.3 accepted + pilot bundle |
| 9.2 | Planned | 9.1 accepted |
| 9.3 | Planned | 9.2 accepted + окружения/клиенты для acceptance |
