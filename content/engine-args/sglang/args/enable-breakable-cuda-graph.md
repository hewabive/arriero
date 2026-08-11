---
schema: 1
engine: sglang
primaryName: "--enable-breakable-cuda-graph"
title: "--enable-breakable-cuda-graph"
summary: Устаревший алиас `--cuda-graph-backend-prefill=breakable`. Breakable — сегментированный захват prefill без torch.compile и с недавних пор значение по умолчанию на CUDA, поэтому флаг чаще всего ничего не меняет, кроме предупреждения и блокировки каскада авто-отключения.
group: null
related:
  - --cuda-graph-backend-prefill
  - --cuda-graph-backend-decode
  - --cuda-graph-config
  - --cuda-graph-max-bs-prefill
  - --cuda-graph-bs-prefill
  - --disable-prefill-cuda-graph
  - --enable-two-batch-overlap
  - --moe-a2a-backend
  - --dcp-size
  - --mem-fraction-static
---

# --enable-breakable-cuda-graph

## Кратко

У фазы prefill в SGLang четыре возможных backend'а захвата: `full`, `breakable`, `tc_piecewise` и `disabled`. `breakable` (BCG) — сегментированный захват: граф записывается кусками с разрывами там, где форма данных зависит от батча, torch.compile при этом не участвует. Этот флаг — устаревшая форма записи `--cuda-graph-backend-prefill breakable`.

На CUDA `breakable` и так является значением по умолчанию (`default_prefill_backend()` возвращает `BREAKABLE` при `is_cuda()`, иначе `TC_PIECEWISE`). Поэтому реальный эффект флага сегодня почти всегда сводится к побочному: явно заданный backend prefill **блокирует каскад авто-отключения**, и prefill-граф не будет выключен автоматически даже там, где движок счел бы конфигурацию несовместимой.

## Оригинальная справка

```text
Deprecated alias for --cuda-graph-backend-prefill=breakable.
```

## Паспорт аргумента

- Флаги: `--enable-breakable-cuda-graph`
- Группа: `null` — устаревший алиас объявлен литеральным `parser.add_argument` в `add_cli_args`, вне пофазной группы `exec.graph`
- Тип значения: флаг без значения
- Допустимые значения: только присутствие флага
- Значение по умолчанию: `None` (`DeprecatedStoreConstAction` с `default=None`), то есть `cuda_graph_backend_prefill` остается незаданным
- Эффективное значение: при передаче кладет константу `breakable` в `cuda_graph_backend_prefill`, что `_parse_cuda_graph_config` переносит в `cuda_graph_config.prefill.backend` и одновременно заносит пару `(prefill, backend)` в `_cuda_graph_config_locked`
- Где объявлен: `ServerArgs.add_cli_args`, файл — `sglang/python/sglang/srt/server_args.py`; `dest` — `cuda_graph_backend_prefill`
- Статус: устаревший (`DeprecatedStoreConstAction`), замена — `--cuda-graph-backend-prefill breakable`
- Этап применения: разбор CLI (предупреждение) → `_handle_cuda_graph_config` (`_parse_cuda_graph_config` → пропуск каскада совместимости → `_apply_deepep_adjustments` → роли PD → валидация) → захват prefill-графа

## Что меняет в движке

### Предупреждение и трансляция

```text
'--enable-breakable-cuda-graph' is deprecated and will be removed in a future release. Use '--cuda-graph-backend-prefill=breakable' instead.
```

Печатается на разборе аргументов, до `logging.basicConfig`, поэтому строка стоит в начале вывода без временного префикса.

### Что делает breakable

BCG захватывает prefill-forward сегментами и не пропускает модель через torch.compile — в отличие от `tc_piecewise`, где граф собирается компилятором и разрезается на куски вокруг внимания. Отсюда основные различия:

- BCG не требует dynamo и поэтому работает там, где torch.compile ломается (LoRA, DP attention, MoE a2a-backend'ы, мультимодальные модели из allowlist);
- BCG не дает выигрыша от слияния ядер, который дает `inductor` в `tc_piecewise`;
- BCG сам отвергает memory-saver в своем конструкторе.

Собственный список несовместимостей у BCG короткий (`_disable_breakable_cudagraph_if_incompatible`): NemotronH с гибридным Mamba2-prefill, DeepSeek-V4 (слишком тяжелый scratch индексатора в пуле захвата), context parallel с `attn_cp_size > 1`, не прошедший `supports_prefill_cp_bcg`, decode context parallel (`--dcp-size > 1`), two-batch overlap, непроверенные a2a-backend'ы (все, кроме `none`, `deepep`, `megamoe`, `flashinfer`) и мультимодальные модели вне allowlist. Каждое срабатывание пишет в лог:

```text
Breakable CUDA graph is incompatible with <причина>; disabling prefill CUDA graph.
```

**Но этот список проверяется только при неявно выбранном backend'е.** Если backend задан явно — в том числе через этот флаг — `_apply_cuda_graph_compatibility` выходит первой же строкой, и захват пойдет вопреки известной несовместимости.

### Отдельная поправка под DeepEP

`_apply_deepep_adjustments` при `moe_a2a_backend == "deepep"` и backend'е `breakable` выравнивает список prefill-форм вверх до кратности восьми, потому что некратные размеры способны подвесить захват a2a:

```text
Breakable prefill CUDA graph with DeepEP requires bucket sizes divisible by 8; aligning [...] -> [...].
```

## Значения и формат

- Булев флаг без значения; «не задан» означает «backend prefill выбирается по умолчанию и может быть автоматически отключен».
- Взаимно исключающие соседи по тому же полю: `--disable-piecewise-cuda-graph` (константа `disabled`) и `--enforce-piecewise-cuda-graph` (константа `tc_piecewise`). При одновременной передаче побеждает та, что разобрана последней; порядок в командной строке в этом случае действительно значим, поэтому так делать не нужно.
- Явный `--cuda-graph-backend-prefill` перекрывает любой из этих алиасов (в `_parse_cuda_graph_config` он присваивается позже), а JSON `--cuda-graph-config` перекрывает всё.
- В YAML через `--config` ключ `cuda-graph-backend-prefill` задать нельзя — он отвергается ровно из-за этих трех алиасов, сидящих на общем `dest`.

## Когда использовать

- Не использовать: пишите `--cuda-graph-backend-prefill breakable`.
- Сам backend (под новым именем) задают явно ради одной цели — заставить движок захватывать prefill-граф там, где он сам его отключил бы. Это осознанное решение: каскад отключений собран из реальных дефектов, а не из перестраховки.
- Не задавать явно «чтобы наверняка» на CUDA: значение и так по умолчанию `breakable`, а явная форма лишает вас автоматической защиты.
- На не-CUDA платформах (ROCm, NPU) значение по умолчанию — `tc_piecewise`; переключение на `breakable` там не проверено апстримом.

## Влияние на производительность и память

- VRAM: prefill-граф резервируется отдельно от decode. Оценка `reserve_for_graph_mb()`: для не-MLA моделей `len(prefill.bs) * 8` МиБ, для MLA — фиксированные 1.5 ГиБ; при связке `breakable` + DeepEP добавляется еще 1 ГиБ. Фактический расход — в `mem usage` строки `Capture target prefill CUDA graph end`.
- Время старта: захват prefill идет до захвата decode, по одному проходу на каждую форму из `cuda_graph_config.prefill.bs` (для потолка 2048 это 42 формы, для 8192 — 58). Точная величина — `elapsed` в той же строке и `startup_time.cuda_graph.prefill` из `GET /server_info`.
- Latency prefill: граф убирает накладные расходы запуска ядер; выигрыш заметнее на коротких chunk'ах, а не на длинных.
- Компиляции нет, поэтому в отличие от `tc_piecewise` старт не удлиняется прогоном inductor.

## Взаимодействие с другими аргументами

- `--cuda-graph-backend-prefill`: актуальная форма; принимает `full`, `breakable`, `tc_piecewise`, `disabled`.
- `--cuda-graph-max-bs-prefill` / `--cuda-graph-bs-prefill`: определяют, сколько форм будет захвачено и до какого числа токенов.
- `--moe-a2a-backend deepep`: включает выравнивание форм по 8 и добавляет 1 ГиБ к резерву.
- `--enable-two-batch-overlap`, `--dcp-size > 1`: несовместимы с BCG, но при явно заданном backend'е авто-отключение не сработает.
- `--cuda-graph-backend-decode`: независимая фаза; decode по умолчанию использует `full`.
- `--mem-fraction-static`: при незаданном значении резерв под prefill-граф уменьшает KV-пул; при заданном — переносит риск на этап захвата.
- `--disable-prefill-cuda-graph`: булев выключатель той же фазы, приоритетом ниже пофазного `--cuda-graph-backend-prefill`, но выше legacy `--disable-cuda-graph`.

## Типовые проблемы и диагностика

- `'--enable-breakable-cuda-graph' is deprecated …` — замените на `--cuda-graph-backend-prefill breakable`.
- Захват prefill падает на конфигурации, которую движок в норме отключил бы сам, — это прямое следствие явного backend'а: каскад совместимости пропущен. Уберите явное значение и посмотрите, что решит движок.
- `Breakable CUDA graph is incompatible with <причина>; disabling prefill CUDA graph.` — сработало авто-отключение (значит, backend задан **не** явно).
- Захват висит на DeepEP-конфигурации — некратные восьми формы; проверьте строку `aligning [...] -> [...]`.
- OOM во время `Capturing num tokens (num_tokens=…)` — не хватило резерва под prefill-граф; уменьшайте `--cuda-graph-max-bs-prefill` либо `--mem-fraction-static`.
- Что смотреть: `cuda_graph_config=` в дампе `server_args=`, строки `Capture target prefill CUDA graph begin/end`, `memory_usage.graph.prefill` и `startup_time.cuda_graph.prefill` в `GET /server_info`.

## Примеры

Актуальная форма вместо этого флага:

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --cuda-graph-backend-prefill breakable
```

Явный backend вместе с ограничением форм prefill:

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --cuda-graph-backend-prefill breakable --cuda-graph-max-bs-prefill 2048
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/argparse_actions.py`
- `sglang/python/sglang/srt/model_executor/cuda_graph_config.py`
- `sglang/python/sglang/srt/model_executor/runner_backend/breakable_cuda_graph_backend.py`
- `sglang/python/sglang/srt/model_executor/runner/prefill_cuda_graph_runner.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/cuda_graph_setup.py`
- `sglang/python/sglang/srt/layers/cp/bcg.py`
- `sglang/docs/docs/advanced_features/breakable_cuda_graph.mdx`
