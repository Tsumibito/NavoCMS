# Задание исполнителю: Sprint 8.1 NavoCMS

Реализуй **только Sprint 8.1 — надёжное повседневное редактирование** из
[активного плана](../roadmap/AGENT_WORKFLOW_SPRINTS.md). Его объём и восемь критериев приёмки
обязательны. После сдачи остановись и передай результат принимающему архитектору.

## Контекст, доступный без остальных сайтов

Это репозиторий `Tsumibito/NavoCMS`. Аудированная основа:
`1b02acd29cab60bb74c9a80a401606c8540260b5`. План добавлен отдельным documentation commit;
используй актуальную основу, содержащую этот файл. Не возвращай репозиторий на старый SHA.

Прочитай `AGENTS.md`, активный план, `docs/specs/mcp-editing-v0alpha1.md`, текущие tests и
исполняемый код. Более широкий `docs/roadmap/SPRINTS.md` содержит историческую программу;
он не разрешает переход к импортёру или соседним спринтам.

Никакие файлы соседних Navi/Payload/charter сайтов для Sprint 8.1 не нужны. Не читай их,
не меняй родительскую структуру и не ищи production data или secrets за пределами CMS.
Для проверок используй синтетические fixtures и отдельную test DB/CI.

## Подтверждённые исходные проблемы

1. `packages/content/src/engine.ts::patchRevision` и
   `apps/mcp/src/postgres-repository.ts::patchDraft` проверяют source hash выбранной ревизии,
   но не её актуальность. Сценарий r1 → r2 и отдельная правка от r1 → r3 теряет r2 в текущем
   тексте. Advisory lock для revision number не решает lost update.
2. `apps/mcp/src/mcp.ts` search/drafts schemas не имеют cursor; `service.ts` возвращает только
   первые 20. Нельзя перечислить 45 документов с пустым поиском штатным способом.
3. `service.ts::getContent` обрезает Markdown до 20 000, но возвращает `metadata.body`
   целиком и весь список AST nodes. Fixture 25 009 символов дал ответ около 46 тысяч символов.
   Нет штатного чтения продолжения/узла с полным текстом.
4. MCP допускает idempotency keys длиной 8–128, event schema требует минимум 16.
   Разрешённый короткий ключ доходит до event validation и падает.
5. `review_preview_handoff` возвращает `previewed`; `widget.ts::renderWorkflow` ожидает
   `ready-for-workflow`, поэтому новый валидный результат показывает как Blocked.
6. `mcp.ts::safeTool` при любой ошибке пишет «No content was published», в том числе после
   реально применённого provider effect с ошибкой последующей live verification.

Перед исправлением проверь эти утверждения на текущем head. Если код уже изменён, покажи
конкретное evidence и не возвращай старую реализацию ради совпадения с описанием.

## Порядок работы

1. Зафиксируй git status, base SHA, актуальность main и baseline checks. Сохрани чужие изменения.
   Создай ветку `codex/sprint-8-1-editing-integrity`; при параллельной работе — свой worktree.
2. Сначала воспроизведи проблемные случаи meaningful regression tests. Изменения head semantics
   и публичных контрактов опиши в ADR/compatibility note, согласовав связанные спецификации.
3. Реализуй минимальные изменения по scope. Не создавай generic PluginHost, отдельный graph
   runtime или новый framework ради этих задач. Не меняй настоящую publication architecture
   раньше Sprint 8.2.
4. Запусти `pnpm check` и PostgreSQL integration/isolation suite в test DB или CI того же head.
   Не используй staging/production для тестовой фикстуры. Недоступность БД — явный незакрытый
   критерий, не причина заявить полный pass.
5. Подготовь commit и PR, если доступен GitHub. В PR укажи конечное поведение, проверки и
   ограничения. Не merge, не deploy и не изменяй внешние данные/configuration.
6. Создай `docs/operations/SPRINT_8_1_SUBMISSION.md` по формату активного плана. В финальном
   ответе дай branch, SHA, PR, ссылку на submission, выполненные/невыполненные gates.
7. Остановись. Следующий спринт начинается только после приёмки основной задачей.

## Что делает принимающий

Независимо проверяет implementation и acceptance scenarios, возвращает исправления,
проверяет CI точного SHA, выполняет merge и staging deployment, authenticated MCP smoke,
операционную приёмку и обновляет статус. Тебе не нужно запрашивать у владельца право на эти
внешние действия: они не входят в твоё задание.
