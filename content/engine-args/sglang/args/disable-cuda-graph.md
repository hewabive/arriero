---
schema: 1
engine: sglang
primaryName: "--disable-cuda-graph"
title: "--disable-cuda-graph"
summary: Устаревший глобальный выключатель CUDA graph на обеих фазах. Заменен пофазными `--cuda-graph-backend-decode=disabled` и `--cuda-graph-backend-prefill=disabled`; имеет самый низкий приоритет и перебивается любым явным пофазным флагом.
group: null
related:
  - --cuda-graph-backend-decode
  - --cuda-graph-backend-prefill
  - --cuda-graph-config
  - --disable-decode-cuda-graph
  - --disable-prefill-cuda-graph
  - --cuda-graph-max-bs-decode
  - --cuda-graph-bs-decode
  - --mem-fraction-static
  - --disable-cuda-graph-padding
---

# --disable-cuda-graph

## Кратко

Флаг выключает захват CUDA graph и на decode, и на prefill. Он устаревший: конфигурация графов давно стала пофазной, и глобальный выключатель остался только как совместимость с чужими скриптами запуска. Актуальная замена — `--cuda-graph-backend-decode disabled` и/или `--cuda-graph-backend-prefill disabled`, а полная форма — JSON в `--cuda-graph-config`.

Практически это ручка «выключить главную оптимизацию decode». Отключение экономит несколько секунд старта и несколько сотен мегабайт VRAM, а платой становится вся экономия на накладных расходах запуска ядер: сообщение в тексте подсказки апстрима про декодный граф прямо говорит `(Not recommended. Huge performance loss)`.

## Оригинальная справка

```text
Deprecated. Use --cuda-graph-backend-{decode,prefill}=disabled instead.
```

## Паспорт аргумента

- Флаги: `--disable-cuda-graph`
- Группа: `null` — флаг объявлен литеральным `parser.add_argument` в `add_cli_args`; одноименное поле датакласса помечено `Arg(no_cli=True)` и собственного CLI не имеет
- Тип значения: bool, флаг без значения
- Допустимые значения: только присутствие флага
- Значение по умолчанию: `False` (значение по умолчанию `DeprecatedStoreTrueAction`)
- Эффективное значение: `_parse_cuda_graph_config` превращает `True` в `cuda_graph_config.decode.backend = disabled` и `cuda_graph_config.prefill.backend = disabled`. Это самая низкая ступень приоритета: и `--disable-{decode,prefill}-cuda-graph`, и `--cuda-graph-backend-*`, и JSON `--cuda-graph-config` перезаписывают результат
- Где объявлен: `ServerArgs.add_cli_args`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: устаревший (`DeprecatedStoreTrueAction`), замена — `--cuda-graph-backend-decode=disabled` / `--cuda-graph-backend-prefill=disabled`
- Этап применения: разбор CLI (предупреждение) → `__post_init__` → `_handle_cuda_graph_config` → `_handle_gpu_memory_settings` (резерв под графы) → `capture_cuda_graphs` в model runner'е

## Что меняет в движке

### Предупреждение и трансляция

При явной передаче печатается предупреждение (желтым, из `print_deprecated_warning`):

```text
'--disable-cuda-graph' is deprecated and will be removed in a future release. Use '--cuda-graph-backend-{decode,prefill}=disabled' instead.
```

Оно выводится на этапе разбора аргументов, то есть **до** вызова `logging.basicConfig` в `prepare_server_args` — поэтому строка появляется в самом начале вывода, без привычного префикса `[YYYY-MM-DD HH:MM:SS]`, которым размечены все последующие сообщения.

Дальше `_parse_cuda_graph_config` выполняет трансляцию первым же шагом:

```python
if self.disable_cuda_graph:
    _set(Phase.DECODE, "backend", Backend.DISABLED)
    _set(Phase.PREFILL, "backend", Backend.DISABLED)
```

`_set` не только присваивает, но и заносит пару `(фаза, ключ)` в `_cuda_graph_config_locked`. Блокировка означает, что каскад авто-отключения (`_apply_cuda_graph_compatibility`) для prefill не запустится — впрочем, отключать уже нечего.

### Что перестает происходить

Без графов `capture_cuda_graphs` строит только `EagerRunner`, и в логе появляется:

```text
Disable prefill CUDA graph because cuda_graph_config resolved prefill.backend='disabled' (e.g. via --cuda-graph-backend-prefill=disabled or auto-disable rules).
```

Строк `Capture target decode CUDA graph begin/end` при этом не будет вовсе. В штатном режиме они выглядят так:

```text
Capture target decode CUDA graph begin. backend=full, num_tokens_per_req=1, bs=[1, 2, 4, 8, 12, 16, ...], avail mem=12.41 GB
Capture target decode CUDA graph end. elapsed=18.62 s, mem usage=0.43 GB, avail mem=11.98 GB.
```

Именно эти две строки — авторитетный ответ на вопрос «сколько стоил захват»: `elapsed` в секундах и `mem usage` в гигабайтах, измеренные как разница свободной памяти до и после. Те же величины доступны у поднятого сервера в `GET /server_info` (`startup_time.cuda_graph.<фаза>` и `memory_usage.graph.<фаза>`) и как gauge `sglang:graph_memory_usage_gb{phase=…}` при `--enable-metrics`.

### Косвенный эффект на память

`reserve_for_graph_mb()` при отключенных графах возвращает 0 для соответствующей фазы. Если `--mem-fraction-static` не задан явно, автоподбор из-за этого выдаст **большее** значение, то есть KV-пул вырастет. Величина заметная: для decode-графа резерв составляет `cuda_graph_config.decode.max_bs * 2` МиБ, для MLA-моделей prefill-граф резервирует фиксированные 1.5 ГиБ.

## Значения и формат

- Булев флаг без значения; «не задан» — графы работают в режиме по умолчанию (decode `full`, prefill `breakable` на CUDA и `tc_piecewise` на прочих платформах).
- Выключает **обе** фазы. Выключить только одну этим флагом нельзя — для этого есть `--disable-decode-cuda-graph` / `--disable-prefill-cuda-graph` или пофазные `--cuda-graph-backend-*`.
- Комбинация `--disable-cuda-graph --cuda-graph-backend-decode full` осмысленна и работает: prefill останется выключенным, decode вернется к полному графу. Порядок флагов в командной строке значения не имеет — приоритет задан кодом, а не позицией.
- В YAML-конфиге через `--config` этот ключ задать нельзя: он отвергается как аргумент с нестандартным argparse-действием.

## Когда использовать

- Не использовать. В новых конфигурациях пишите `--cuda-graph-backend-decode disabled` и/или `--cuda-graph-backend-prefill disabled`.
- Сценарии, ради которых графы вообще отключают: отладка численного расхождения (граф скрывает часть трассировки), нехватка VRAM ровно на этапе захвата, работа с моделью или backend'ом, где захват падает. В первых двух случаях сначала пробуют уменьшить `--cuda-graph-max-bs-decode`, а не выключать граф целиком.
- Не отключать графы «ради экономии VRAM» на рабочем сервере: выигрыш в сотни мегабайт против кратного роста накладных расходов decode на маленьких батчах.

## Влияние на производительность и память

- VRAM: освобождается то, что показывает `mem usage` в строке `Capture … end` — обычно сотни мегабайт для decode-графа и до полутора гигабайт для prefill-графа MLA-модели.
- Время старта: пропадает фаза захвата, а это самая длинная часть инициализации после загрузки весов (десятки секунд при большом `max_bs`).
- Latency decode: главный проигрыш. Без графа каждый шаг decode заново запускает сотни ядер из Python; на малых батчах это доминирующая стоимость.
- Prefill: влияние меньше, потому что prefill и так считает большие матрицы; выключение prefill-графа обычно стоит единицы процентов.
- Диагностический признак в рабочем логе: в строках `Decode batch, …` поле `cuda graph: False`.

## Взаимодействие с другими аргументами

- `--cuda-graph-backend-decode` / `--cuda-graph-backend-prefill`: прямая замена; их значение перезаписывает результат этого флага.
- `--disable-decode-cuda-graph` / `--disable-prefill-cuda-graph`: пофазные булевы выключатели, тоже приоритетнее.
- `--cuda-graph-config`: JSON с наивысшим приоритетом, побеждает всех.
- `--cuda-graph-max-bs-decode` / `--cuda-graph-bs-decode`: при выключенном decode-графе бессмысленны, но конфликтом не считаются и молча игнорируются на этапе захвата.
- `--mem-fraction-static`: при незаданном значении автоподбор вырастет, потому что резерв под графы обнулится.
- `--disable-cuda-graph-padding`: относится к форме списка захватываемых размеров и при выключенных графах не действует.
- `--enable-torch-compile`: отдельный механизм; отключение CUDA graph не отключает torch.compile.

## Типовые проблемы и диагностика

- Предупреждение `'--disable-cuda-graph' is deprecated …` в самом начале лога — единственный признак того, что флаг вообще был передан. Замените его пофазным.
- Флаг задан, а decode-граф все равно захватывается — значит рядом стоит `--cuda-graph-backend-decode` или `--cuda-graph-config` с явным backend'ом. Проверьте `cuda_graph_config=` в дампе `server_args=`.
- Пропускная способность упала в разы после добавления флага — ожидаемое поведение, см. выше.
- KV-пул неожиданно вырос — следствие обнуленного резерва под графы при незаданном `--mem-fraction-static`.
- Что смотреть в логе: `cuda_graph_config=` в дампе `server_args=`, отсутствие строк `Capture … CUDA graph begin/end`, `cuda graph: False` в строках decode-батчей.

## Примеры

Актуальная форма вместо этого флага:

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --cuda-graph-backend-decode disabled --cuda-graph-backend-prefill disabled
```

Выключить только prefill-граф, оставив decode:

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --cuda-graph-backend-prefill disabled
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/argparse_actions.py`
- `sglang/python/sglang/srt/model_executor/cuda_graph_config.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/cuda_graph_setup.py`
- `sglang/python/sglang/srt/model_executor/runner_backend_utils/__init__.py`
- `sglang/python/sglang/srt/managers/scheduler_components/metrics_reporter.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
