---
schema: 1
engine: sglang
primaryName: "--cuda-graph-tc-compiler"
title: "--cuda-graph-tc-compiler"
summary: Компилятор для prefill-backend'а `tc_piecewise`: `eager` (по умолчанию, только разрезание графа) или `inductor` (кодогенерация Triton с горизонтальным слиянием ядер). На decode не влияет — там `tc_piecewise` пока не реализован.
group: exec.graph
related:
  - --cuda-graph-backend-prefill
  - --piecewise-cuda-graph-compiler
  - --cuda-graph-config
  - --cuda-graph-bs-prefill
  - --cuda-graph-max-bs-prefill
  - --enable-torch-compile
  - --enable-torch-compile-debug-mode
  - --disable-prefill-cuda-graph
  - --device
---

# --cuda-graph-tc-compiler

## Кратко

Backend `tc_piecewise` разрезает forward модели по attention-слоям через `torch.compile` и захватывает получившиеся куски. Этот флаг задает, что делает `torch.compile` с каждым куском: `eager` — только трассировка и разрезание, без кодогенерации; `inductor` — полноценная компиляция в Triton-ядра с дополнительными оптимизациями. Разница в основном в стоимости старта и в шансе получить ускорение prefill на конкретной модели.

## Оригинальная справка

```text
Compiler used by the tc_piecewise backend (currently only the prefill phase consumes it).
```

## Паспорт аргумента

- Флаги: `--cuda-graph-tc-compiler`
- Группа: `exec.graph`
- Тип значения: строка с фиксированным списком
- Допустимые значения (из `choices`): `eager`, `inductor`
- Значение по умолчанию: `null` — флаг не задан; `PhaseConfig.tc_compiler` в обеих фазах равен `"eager"`
- Эффективное значение: при заданном флаге записывается **в обе** фазы (`decode` и `prefill`) — decode-значение зарезервировано на будущее и сегодня не читается. На `--device npu` любое значение, кроме `eager`, отвергается с предупреждением «At this moment Ascend platform only support prefill graph compilation with cuda_graph_config[prefill].tc_compiler='eager'.» и заменяется на `eager`
- Где объявлен: `ServerArgs.cuda_graph_tc_compiler`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный. Устаревший псевдоним — `--piecewise-cuda-graph-compiler`
- Этап применения: разбор CLI → `__post_init__` (`_handle_cuda_graph_config`, `_handle_npu_backends`) → `TcPiecewiseCudaGraphBackend.build_compilation_config` при инициализации prefill-runner'а

## Что меняет в движке

`TcPiecewiseCudaGraphBackend.build_compilation_config` читает `cuda_graph_config[prefill].tc_compiler`, проверяет его ассертом против `("eager", "inductor")` и кладет в `CompilationConfig`. Дальше:

- **`eager`** — `_run_compile_pass` не переводит `BaseFusedOp`-модули в режим torch.compile (`_toggle_fused_ops` вызывается только при не-`eager` компиляторе), а `CompilationConfig.configure_inductor()` ничего не делает. FX-граф трассируется и разрезается, куски захватываются в CUDA graph, но кодогенерации inductor нет.
- **`inductor`** — дополнительно включаются `torch._inductor.config.combo_kernels = True` и `benchmark_combo_kernel = True`: горизонтальное слияние соседних операций с разными формами (например `q_norm` + `k_norm` в одно Triton-ядро). Fused-op модули переводятся в compile-режим.

В обоих случаях на старте выполняется проход по всем формам из `cuda_graph_config[prefill].bs` с прогресс-строками `Compiling num tokens (num_tokens=…)`, а результат компиляции кешируется под `SGLANG_CACHE_DIR/torch_compile_cache/<hash>/rank_<r>_<dp>/…` (внутри — подкаталоги `inductor_cache` и `triton_cache`, на которые перенаправляются `TORCHINDUCTOR_CACHE_DIR` и `TRITON_CACHE_DIR`).

Флаг не имеет никакого эффекта, если prefill-backend не `tc_piecewise`.

## Значения и формат

- Значение вне списка отвергает argparse (`invalid choice`).
- Не задавать флаг — то же самое, что `eager` (это дефолт `PhaseConfig.tc_compiler`), но с одним отличием: явное значение фиксирует пары `(decode, "tc_compiler")` и `(prefill, "tc_compiler")` в `_cuda_graph_config_locked`. На автологику backend'ов эти замки сегодня не влияют.
- То же значение можно задать через `--cuda-graph-config '{"prefill":{"tc_compiler":"inductor"}}'` — тогда оно запишется только в prefill.
- На `--device npu` `inductor` молча заменяется на `eager` (с предупреждением в логе).

## Когда использовать

- `inductor` — когда prefill-backend `tc_piecewise` уже выбран и вы хотите проверить, дает ли кодогенерация выигрыш на вашей модели. Проверять надо измерением TTFT: слияние ядер помогает не всем архитектурам.
- `eager` — когда старт с `inductor` слишком долгий или когда компиляция падает; это безопасный дефолт.
- Не задавайте флаг, если prefill-граф работает на `breakable` (дефолт на CUDA) — значение просто не будет прочитано.
- Не путайте с `--enable-torch-compile`: это другой механизм, применяющий `torch.compile` к decode-forward целиком. Он, наоборот, **отключает** `tc_piecewise` в каскаде совместимости, так что вместе они не работают.

## Влияние на производительность и память

- **Время старта.** `inductor` заметно дороже `eager`: к трассировке добавляется генерация и автотюнинг Triton-ядер по каждой форме. При 58 формах (типичный список для `chunked_prefill_size 8192`) разница измеряется минутами. Второй запуск с прогретым кешем дешевле.
- **Диск.** Кеш компиляции лежит под `SGLANG_CACHE_DIR` (по умолчанию `~/.cache/sglang`) и растет с числом форм и вариантов конфигурации.
- **VRAM.** Заметной разницы между компиляторами нет: память занимают сами захваченные графы, а не способ их получения.
- **TTFT.** Потенциальный выигрыш `inductor` — на моделях с большим числом мелких поэлементных операций; на моделях, где prefill упирается в GEMM и attention, разницы почти нет.

## Взаимодействие с другими аргументами

- `--cuda-graph-backend-prefill`: значение читается только при `tc_piecewise`.
- `--cuda-graph-config`: ключ `prefill.tc_compiler` перекрывает флаг и не трогает decode.
- `--piecewise-cuda-graph-compiler` (устаревший): то же поле под старым именем.
- `--cuda-graph-bs-prefill` / `--cuda-graph-max-bs-prefill`: определяют, сколько форм придется скомпилировать.
- `--enable-torch-compile`: несовместим по смыслу — включает авто-отключение `tc_piecewise` (правило «full torch.compile mode»), после чего флаг не читается.
- `--enable-torch-compile-debug-mode`: попадает в тот же `CompilationConfig` и включает проверку адресов входов при реплее.
- `--device npu`: принудительно `eager`.

## Типовые проблемы и диагностика

- **Симптом:** флаг задан, а в логе нет ни одной строки `Compiling num tokens (num_tokens=…)`. **Причина:** prefill-backend не `tc_piecewise` (по умолчанию на CUDA это `breakable`) или prefill-граф отключен каскадом. **Проверка:** `cuda_graph_config=` в дампе `server_args=`.
- **Симптом:** `AssertionError: By now, only ('eager', 'inductor') are supported for the tc_piecewise prefill compiler.` **Причина:** значение подставлено через `--cuda-graph-config` в обход `choices`.
- **Симптом:** предупреждение про Ascend и `tc_compiler='eager'`. **Причина:** `inductor` на NPU не поддерживается.
- **Симптом:** старт занял десятки минут на первом запуске и минуты на втором. Это ожидаемо для `inductor`: второй запуск читает кеш.
- **Что смотреть:** прогресс-строки `Compiling num tokens (num_tokens=…)`, затем `Capture target prefill CUDA graph begin. backend=tc_piecewise, num_tokens=[…]`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --cuda-graph-backend-prefill tc_piecewise --cuda-graph-tc-compiler inductor
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --cuda-graph-backend-prefill tc_piecewise --cuda-graph-tc-compiler eager --cuda-graph-bs-prefill 512 1024 2048
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_executor/runner_backend/tc_piecewise_cuda_graph_backend.py`
- `sglang/python/sglang/srt/compilation/compilation_config.py`
- `sglang/python/sglang/srt/compilation/backend.py`
- `sglang/python/sglang/srt/compilation/compiler_interface.py`
- `sglang/python/sglang/srt/environ.py`
