---
schema: 1
engine: sglang
primaryName: "--piecewise-cuda-graph-compiler"
title: "--piecewise-cuda-graph-compiler"
summary: Устаревший алиас `--cuda-graph-tc-compiler` — выбор компилятора для prefill-backend'а `tc_piecewise`: `eager` (только разрез на куски) или `inductor` (полноценная компиляция со слияниями). При других backend'ах значение не используется.
group: null
related:
  - --cuda-graph-tc-compiler
  - --cuda-graph-backend-prefill
  - --cuda-graph-config
  - --cuda-graph-bs-prefill
  - --enable-torch-compile
  - --enable-torch-compile-debug-mode
  - --moe-a2a-backend
---

# --piecewise-cuda-graph-compiler

## Кратко

`tc_piecewise` пропускает модель через torch.compile и режет получившийся граф на куски вокруг внимания. Этот аргумент задает, какой backend компиляции использовать: `eager` — dynamo только трассирует и режет, генерация кода не выполняется; `inductor` — включается кодогенерация со слияниями ядер. Флаг устарел и переименован в `--cuda-graph-tc-compiler`.

Значение записывается в обе фазы конфигурации, но сегодня его читает только prefill: в комментарии `_parse_cuda_graph_config` это оговорено прямо — decode получает значение «на будущее» и игнорирует его.

## Оригинальная справка

```text
Deprecated alias for --cuda-graph-tc-compiler.
```

## Паспорт аргумента

- Флаги: `--piecewise-cuda-graph-compiler`
- Группа: `null` — устаревший алиас объявлен литеральным `parser.add_argument` в `add_cli_args`, вне пофазной группы `exec.graph`
- Тип значения: str
- Допустимые значения: `eager`, `inductor` (argparse проверяет `choices`, и у алиаса они те же, что у актуального флага)
- Значение по умолчанию: у алиаса значения по умолчанию нет; `dest` (`cuda_graph_tc_compiler`) инициализируется значением `None` от актуального флага, а незаданное значение оборачивается значением по умолчанию `PhaseConfig.tc_compiler = "eager"`
- Эффективное значение: `_parse_cuda_graph_config` при непустом значении пишет его сразу в `cuda_graph_config.decode.tc_compiler` и `cuda_graph_config.prefill.tc_compiler`; фактически читается только prefill-версия и только при `backend == tc_piecewise`
- Где объявлен: `ServerArgs.add_cli_args`, файл — `sglang/python/sglang/srt/server_args.py`; `dest` — `cuda_graph_tc_compiler`
- Статус: устаревший (`DeprecatedAliasStoreAction`), замена — `--cuda-graph-tc-compiler`
- Этап применения: разбор CLI (предупреждение) → `_handle_cuda_graph_config` → `TcPiecewiseCudaGraphBackend.build_compilation_config` → прогон компиляции перед захватом prefill-графов

## Что меняет в движке

### Предупреждение и трансляция

```text
'--piecewise-cuda-graph-compiler' is deprecated and will be removed in a future release. Use '--cuda-graph-tc-compiler' instead.
```

Печатается на разборе аргументов, до `logging.basicConfig`, поэтому строка стоит в начале вывода без временного префикса.

### Как значение используется

`build_compilation_config` (`sglang/python/sglang/srt/model_executor/runner_backend/tc_piecewise_cuda_graph_backend.py`) собирает `CompilationConfig` из трех вещей: списка форм `cuda_graph_config.prefill.bs`, значения `tc_compiler` и флага `--enable-torch-compile-debug-mode`. Значение проверяется утверждением:

```text
By now, only ('eager', 'inductor') are supported for the tc_piecewise prefill compiler.
```

Дальше `_run_compile_pass` при значении, отличном от `eager`, дополнительно переключает часть модулей модели в «слитый» режим (`_toggle_fused_ops`), после чего прогоняет по одному forward на каждую форму, чтобы прогнать FX и inductor через все размеры до собственно захвата графов.

Значение `inductor` еще и меняет поведение отдельных путей квантизации: например, в `fp8_utils.py` и `models/utils.py` есть ветки, активные только при `cuda_graph_config.prefill.tc_compiler == "inductor"`.

## Значения и формат

- Одно из двух: `eager` или `inductor`. Иное отвергается argparse'ом.
- Не задавать — значит `eager` (значение по умолчанию структуры `PhaseConfig`).
- Значение имеет смысл только при `--cuda-graph-backend-prefill tc_piecewise`. При `breakable`, `full` и `disabled` оно записывается в конфигурацию, но не читается.
- В YAML через `--config` ключ `cuda-graph-tc-compiler` задать нельзя — он отвергается из-за этого устаревшего алиаса на том же `dest`. Обходной путь — `cuda-graph-config` с ключом `tc_compiler` внутри фазы.

## Когда использовать

- Не использовать: пишите `--cuda-graph-tc-compiler`.
- `inductor` (под новым именем) пробуют, когда prefill упирается в число мелких ядер и есть возможность заплатить временем старта. Выигрыш модельно-специфичен, его надо измерять, а не предполагать.
- `eager` — разумное значение по умолчанию: разрез на куски и захват уже дают основной выигрыш, а компиляция не удлиняет старт.
- Не трогать, если prefill-backend не `tc_piecewise`; на CUDA он по умолчанию `breakable`, и аргумент там бесполезен.

## Влияние на производительность и память

- Время старта: главный расход. `inductor` компилирует модель под каждую форму из списка prefill; на большой модели с несколькими десятками форм это минуты. `eager` добавляет только трассировку.
- VRAM: сам выбор компилятора резерв под графы не меняет; влияет косвенно — через размер скомпилированных ядер и кеш inductor в памяти процесса.
- RAM хоста и диск: `inductor` пишет кеш скомпилированных ядер, при повторных запусках старт короче.
- Latency prefill: `inductor` может выиграть за счет слияний; величина зависит от модели и квантизации.

## Взаимодействие с другими аргументами

- `--cuda-graph-tc-compiler`: актуальное имя того же поля.
- `--cuda-graph-backend-prefill tc_piecewise`: единственный режим, в котором значение читается.
- `--cuda-graph-bs-prefill` / `--cuda-graph-max-bs-prefill`: определяют число форм, а значит и стоимость компиляции — с `inductor` эта связь становится главным фактором времени старта.
- `--enable-torch-compile-debug-mode`: попадает в тот же `CompilationConfig`.
- `--enable-torch-compile`: полная компиляция модели; несовместима с `tc_piecewise` по правилу каскада авто-отключения.
- `--moe-a2a-backend deepep` / `mooncake`: добавляет точку разреза `sglang.moe_forward_piecewise_cuda_graph_impl` в конфигурацию компиляции.

## Типовые проблемы и диагностика

- `'--piecewise-cuda-graph-compiler' is deprecated …` — замените на `--cuda-graph-tc-compiler`.
- Значение задано, а поведение не изменилось — prefill-backend не `tc_piecewise`. Проверьте `cuda_graph_config=` в дампе `server_args=`.
- `AssertionError: By now, only ('eager', 'inductor') are supported for the tc_piecewise prefill compiler.` — значение пришло не из CLI, а из JSON `--cuda-graph-config`, где argparse `choices` не проверяет.
- Старт вырос до минут — работает inductor; сократите число форм через `--cuda-graph-max-bs-prefill` или вернитесь на `eager`.
- Ошибки dynamo/inductor во время старта — модель не поддерживает piecewise-компиляцию; смените prefill-backend на `breakable`.
- Что смотреть: `cuda_graph_config=` в дампе `server_args=` и `startup_time.cuda_graph.prefill` в `GET /server_info`.

## Примеры

Актуальная форма вместо этого флага:

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --cuda-graph-backend-prefill tc_piecewise --cuda-graph-tc-compiler inductor
```

То же самое одним JSON-аргументом:

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --cuda-graph-config '{"prefill": {"backend": "tc_piecewise", "tc_compiler": "inductor"}}'
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/argparse_actions.py`
- `sglang/python/sglang/srt/model_executor/cuda_graph_config.py`
- `sglang/python/sglang/srt/model_executor/runner_backend/tc_piecewise_cuda_graph_backend.py`
- `sglang/python/sglang/srt/models/utils.py`
- `sglang/python/sglang/srt/layers/quantization/fp8_utils.py`
