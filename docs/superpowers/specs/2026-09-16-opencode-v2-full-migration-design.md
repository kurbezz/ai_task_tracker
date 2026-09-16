# Полная миграция OpenCode на V2

## Цель и объём

Перевести активную глобальную и общую рабочую конфигурацию OpenCode на V2, сохранив доступные MCP-серверы, агенты, навыки и команду `/tt`. Конфигурации и секреты не удаляются: перед изменением создаются резервные копии с сохранением симлинков. Работа охватывает:

- `~/.config/opencode/opencode.json`;
- `~/.agents-configs/opencode/work/opencode.json` и `home/opencode.json`;
- локальный плагин `opencode-plugin/ai-task-tracker-nudge.ts` и его тесты;
- зависимую команду `~/.config/opencode/command/tt.md`.

`~/.config/opencode/cli.json` уже использует V2-формат и сохраняется без изменений. Legacy `tui.json(c)`, credentials, keychain, SQLite и service configuration не изменяются.

## Архитектура миграции

1. Установить официальный V2 CLI после записи текущей версии и путей. V1 и V2 не должны оставаться двумя конкурирующими установками.
2. Перевести конфигурации в нативные V2-поля: `plugins`, `agents`, `permissions`, `mcp.servers`, `providers`, `commands`, `references` и единый массив `skills`. Сохранить URL, заголовки и включённые MCP-интеграции.
3. Временно исключить неэквивалентные quota и Claude-auth регистрации из активной конфигурации, оставив их только в резервной копии. Не менять учётные данные.
4. Переписать `ai-task-tracker-nudge` с V1 Plugin API на V2: entrypoint, hooks, tool creation, события и session data. Поведение уведомлений и инструмент, нужный `/tt`, должны быть сохранены.
5. Обновить зависимость SDK до совместимой V2 версии и привести тесты плагина к V2 контракту.

## Надёжность и проверка

Проверки выполняются после согласования плана и перед объявлением миграции завершённой:

- JSON/JSONC parsing и проверка путей конфигурации;
- unit-тесты и typecheck плагина;
- `opencode service status`, `opencode api get /api/health`, `opencode debug paths`;
- `opencode plugin list`, `opencode plugin check`, `opencode mcp list`;
- запуск `/tt` и одной неплатной команды `opencode run` в репозитории.

Если V2 не загружает поддерживаемую V1-конфигурацию, конфигурация восстанавливается из backup, а проблема фиксируется как compatibility issue. Перезапуск общего сервиса выполняется только когда это требуется проверкой.

## Источники

- https://opencode.ai/v2/docs/migrate-v1
- https://opencode.ai/v2/docs/config
- https://opencode.ai/v2/docs/build/plugins
- https://opencode.ai/v2/docs/cli
