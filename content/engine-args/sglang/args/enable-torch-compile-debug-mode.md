---
schema: 1
engine: sglang
primaryName: "--enable-torch-compile-debug-mode"
title: "--enable-torch-compile-debug-mode"
summary: Включает проверку стабильности адресов входных тензоров в piecewise-графах `torch.compile`: адреса запоминаются при захвате и сверяются на каждом реплее. Читается только backend'ом `tc_piecewise`; к `--enable-torch-compile` отношения не имеет, несмотря на имя.
group: exec.graph
related:
  - --cuda-graph-backend-prefill
  - --cuda-graph-tc-compiler
  - --enable-torch-compile
  - --debug-cuda-graph
  - --cuda-graph-config
  - --cuda-graph-bs-prefill
  - --disable-prefill-cuda-graph
---

# --enable-torch-compile-debug-mode

## Кратко

Имя вводит в заблуждение: флаг не относится к `--enable-torch-compile`. Единственный его потребитель — `TcPiecewiseCudaGraphBackend`, то есть prefill-граф в режиме `tc_piecewise`. Он кладет `enable_debug_mode` в `CompilationConfig`, а piecewise-backend'ы (`cuda_piecewise_backend.py` и его NPU/XPU-аналоги) на его основе включают одну конкретную проверку: адреса входных тензоров, записанные при захвате подграфа, должны совпадать с адресами на реплее. Это ловит класс ошибок «граф читает не тот буфер», который иначе проявляется молчаливой порчей вывода.

## Оригинальная справка

```text
Enable debug mode for torch compile
```

## Паспорт аргумента

- Флаги: `--enable-torch-compile-debug-mode`
- Группа: `exec.graph`
- Тип значения: bool, `action="store_true"` — значение не принимает
- Допустимые значения: флаг либо есть, либо его нет
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется в `__post_init__`; читается один раз при построении `CompilationConfig`
- Где объявлен: `ServerArgs.enable_torch_compile_debug_mode`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, отладочный
- Этап применения: инициализация prefill-runner'а при `cuda_graph_config[prefill].backend == tc_piecewise` → захват подграфов → каждый реплей

## Что меняет в движке

`TcPiecewiseCudaGraphBackend.build_compilation_config` передает значение третьим аргументом в `CompilationConfig(num_tokens, compiler, server_args.enable_torch_compile_debug_mode)`. В `compilation/cuda_piecewise_backend.py` оно читается через `compile_config.get_enable_debug_mode()` в двух местах:

- при захвате подграфа сохраняется список `data_ptr()` всех входных тензоров (`entry.input_addresses`);
- при каждом последующем реплее список пересчитывается и сверяется:

```python
assert new_input_addresses == entry.input_addresses, (
    "Input addresses for cudagraphs are different during replay."
    f" Expected {entry.input_addresses}, got {new_input_addresses}"
)
```

Аналогичный код есть в `npu_piecewise_backend.py` и `xpu_piecewise_backend.py`. Никакого дополнительного логирования, дампов графов или отчетов флаг не включает.

Если prefill-backend не `tc_piecewise` (а по умолчанию на CUDA это `breakable`), флаг не читается вообще.

## Значения и формат

- Значения не принимает.
- Отдельного ключа в схеме `--cuda-graph-config` у него нет: это самостоятельное поле `ServerArgs`.
- Проверка выполняется на каждом реплее и работает как жесткий ассерт: несовпадение адресов роняет forward, а не деградирует его.

## Когда использовать

- Диагностика неверного вывода при включенном prefill-графе `tc_piecewise`: если ассерт срабатывает, значит статические буферы подменяются между реплеями, и проблема в инфраструктуре, а не в модели.
- Разработка или обновление кода, который трогает статические буферы prefill (`_PREFILL_STATIC_FIELDS`, реестр буферов, dedup графов).
- Не оставляйте флаг включенным в эксплуатации: проверка выполняется на каждом реплее и превращает потенциально безобидное расхождение в аварийную остановку запроса.
- Не рассчитывайте, что он даст отладочную информацию по `--enable-torch-compile`: тот путь (`torch_compile_decoration.patch_model`) этот флаг не читает.

## Влияние на производительность и память

- **Latency:** небольшой, но постоянный оверхед на каждом реплее prefill-графа — обход входных тензоров и вызов `data_ptr()`.
- **VRAM:** не меняет; хранится только список целых чисел на подграф.
- **Время старта:** не меняет.
- **Стабильность:** ухудшает по построению — раньше «странный» реплей мог отработать, теперь он падает ассертом. Это и есть цель флага.

## Взаимодействие с другими аргументами

- `--cuda-graph-backend-prefill`: значение читается только при `tc_piecewise`.
- `--cuda-graph-tc-compiler`: попадает в тот же `CompilationConfig`; вместе они полностью описывают режим piecewise-компиляции.
- `--cuda-graph-bs-prefill` / `--cuda-graph-max-bs-prefill`: определяют, сколько подграфов будет проверяться.
- `--enable-torch-compile`: другой механизм; более того, он отключает `tc_piecewise` в каскаде совместимости, после чего этот флаг становится мертвым.
- `--debug-cuda-graph`: отладка другого backend'а (`breakable`) и другого типа — там forward переводится в eager, а не проверяются адреса. Кроме того, `--debug-cuda-graph` сам выключает `tc_piecewise` через каскад, так что вместе они несовместимы по смыслу.
- `--disable-prefill-cuda-graph`: обесценивает флаг.

## Типовые проблемы и диагностика

- **Симптом:** `AssertionError: Input addresses for cudagraphs are different during replay. Expected […], got […]`. **Причина:** между захватом и реплеем подменился входной буфер. **Что делать:** зафиксировать конфигурацию (модель, backend, список форм) и сообщить апстриму; как обходной путь — `--cuda-graph-backend-prefill disabled` или `breakable`.
- **Симптом:** флаг задан, ничего не изменилось. **Причина:** prefill-backend не `tc_piecewise`. **Проверка:** `cuda_graph_config=` в дампе `server_args=` — там виден разрешенный backend.
- **Симптом:** ожидали подробный лог компиляции. Флаг его не дает; для этого есть переменные окружения самого torch (`TORCH_LOGS`, `TORCH_COMPILE_DEBUG`).
- **Чем подтвердить:** `enable_torch_compile_debug_mode=True` в дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --cuda-graph-backend-prefill tc_piecewise --enable-torch-compile-debug-mode
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --cuda-graph-backend-prefill tc_piecewise --cuda-graph-tc-compiler inductor --enable-torch-compile-debug-mode --cuda-graph-bs-prefill 512 1024
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_executor/runner_backend/tc_piecewise_cuda_graph_backend.py`
- `sglang/python/sglang/srt/compilation/compilation_config.py`
- `sglang/python/sglang/srt/compilation/cuda_piecewise_backend.py`
- `sglang/python/sglang/srt/model_executor/runner/prefill_cuda_graph_runner.py`
