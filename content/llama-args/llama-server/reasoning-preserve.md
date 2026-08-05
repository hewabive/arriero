---
schema: 1
primaryName: "--reasoning-preserve"
title: "--reasoning-preserve"
summary: "Управляет сохранением reasoning trace во всей chat history для совместимых Jinja templates. Без флага действует поведение самого шаблона."
category: "Параметры llama-server"
valueType: "boolean"
estimation: "normal"
valueHint: null
aliases:
  - "--reasoning-preserve"
  - "--no-reasoning-preserve"
allowedValues: []
env:
  - "LLAMA_ARG_REASONING_PRESERVE"
related:
  - "--reasoning"
  - "--reasoning-format"
  - "--chat-template"
  - "--jinja"
---

# --reasoning-preserve

## Кратко

`--reasoning-preserve` просит совместимый chat template сохранять reasoning/thinking content не только в последнем assistant message, но и глубже в истории диалога. `--no-reasoning-preserve` явно включает очищающее поведение.

Если ни одна форма не передана, llama.cpp не задаёт override и оставляет template default.

## Оригинальная справка llama.cpp

```text
preserve reasoning trace in the full history, not just the last assistant message (default: template default)
compatible with certain templates having 'supports_preserve_reasoning' capability
```

## Паспорт аргумента

- Основное имя: `--reasoning-preserve`
- Отрицательная форма: `--no-reasoning-preserve`
- Переменная окружения: `LLAMA_ARG_REASONING_PRESERVE`
- Хранилище: `common_params::default_template_kwargs["preserve_reasoning"]`
- Значение по умолчанию: поведение chat template
- Условие эффекта: template capability `supports_preserve_reasoning`

## Что меняет в llama-server

Положительная форма записывает template kwarg `preserve_reasoning=true`, отрицательная — `false`. Jinja runtime сопоставляет его с распространёнными переменными `preserve_thinking`, `clear_thinking`, `truncate_history_thinking` и `drop_thinking`.

При загрузке server анализирует template capabilities:

- если template умеет сохранять reasoning, но override не включён, лог предлагает `--reasoning-preserve`;
- если override задан, но capability отсутствует, лог предупреждает, что флаг не имеет эффекта.

## Когда использовать

Включайте только для моделей и шаблонов, которым действительно нужен preserved thinking между ходами. Это может быть частью протокола модели, но увеличивает повторно передаваемую историю и раскрывает reasoning content следующему ходу.

Для большинства обычных chat templates оставляйте default. Не используйте флаг как способ «включить reasoning»: генерацией thinking управляют `--reasoning`, модель и template.

## Влияние на контекст и приватность

Сохранённый reasoning занимает context tokens на последующих ходах, повышает prompt processing cost и может быстрее заполнить контекст. Он также остаётся в полной истории, поэтому учитывайте требования к логированию и приватности.

## Взаимодействие с другими аргументами

- `--reasoning` включает/выключает генерацию thinking; этот флаг управляет историей.
- `--reasoning-format` влияет на представление reasoning в API response.
- `--chat-template` и `--jinja` определяют наличие capability.
- `--reasoning-budget` ограничивает новые thinking tokens, но не очищает сохранённую историю.

## INI-пресеты и router-режим

В INI:

```ini
reasoning-preserve = true
```

Задавайте per model: поддержка зависит от конкретного chat template.

## Типовые проблемы и диагностика

- Warning `chat template does NOT support preserving reasoning`: флаг не действует; уберите его или смените template.
- В истории reasoning всё равно очищается: проверьте template capability и фактически выбранный template.
- Контекст стал заметно длиннее: preserved reasoning повторно входит в prompt каждого следующего хода.

## Примеры

```bash
llama-server --model /models/reasoning.gguf --jinja --reasoning-preserve
llama-server --model /models/reasoning.gguf --no-reasoning-preserve
```

## Источники

- `llama.cpp/common/arg.cpp`
- `llama.cpp/common/chat.cpp`
- `llama.cpp/common/jinja/caps.cpp`
- `llama.cpp/tools/server/server-context.cpp`
- https://github.com/ggml-org/llama.cpp/pull/25105
