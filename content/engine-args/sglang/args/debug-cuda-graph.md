---
schema: 1
engine: sglang
primaryName: "--debug-cuda-graph"
title: "--debug-cuda-graph"
summary: Отладочный режим: весь forward превращается в одну eager-«точку разрыва» внутри breakable-графа, поэтому операции выполняются построчно, но проходят через тот же путь захвата и реплея. Требует `--cuda-graph-backend-decode breakable` — сам он этот backend не включает.
group: exec.graph
related:
  - --cuda-graph-backend-decode
  - --cuda-graph-backend-prefill
  - --enable-breakable-cuda-graph
  - --disable-decode-cuda-graph
  - --cuda-graph-config
  - --enable-profile-cuda-graph
  - --enable-torch-compile-debug-mode
  - --device
---

# --debug-cuda-graph

## Кратко

Когда захват или реплей графа портит вычисления, нужно понять, дело в самом графе или в модели. `--debug-cuda-graph` дает промежуточный режим: инфраструктура графов работает целиком (захват, mempool, реплей), но тело forward'а исполняется eager. Если проблема исчезает — виноват захват; если остается — виноват код модели. **Важная практическая деталь: флаг не переключает backend сам.** Без явного `--cuda-graph-backend-decode breakable` захват падает ассертом.

## Оригинальная справка

```text
Enable debug/eager mode for CUDA graph using breakable CUDA graph. When enabled, graph breaks are inserted so every operation runs eagerly while still going through the CUDA graph capture / replay path. Useful for debugging CUDA graph capture / replay issues.
```

## Паспорт аргумента

- Флаги: `--debug-cuda-graph`
- Группа: `exec.graph`
- Тип значения: bool, `action="store_true"` — значение не принимает
- Допустимые значения: флаг либо есть, либо его нет
- Значение по умолчанию: `false`
- Эффективное значение: в `_handle_environment_variables` на не-CUDA и не-HIP устройствах принудительно сбрасывается в `false` с предупреждением «--debug-cuda-graph is not supported on non CUDA/HIP devices. Disabling breakable CUDA graph.»; на CUDA/HIP выставляет переменную окружения `SGLANG_USE_BREAKABLE_CUDA_GRAPH=1` и печатает предупреждение «Debug mode for CUDA graph is enabled via breakable CUDA graph. All operations will run eagerly through the graph capture/replay path.»
- Где объявлен: `ServerArgs.debug_cuda_graph`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, отладочный
- Этап применения: `__post_init__` (правило каскада prefill, установка env) → создание backend'ов (`debug_eager` в `resolve_decode_backend`/`resolve_prefill_backend`) → захват и реплей

## Что меняет в движке

`resolve_decode_backend` и `resolve_prefill_backend` передают значение флага в `BreakableCudaGraphBackend(..., debug_eager=...)`. При взведенном флаге весь forward оборачивается в `eager_on_graph(True)`: захват заканчивает текущий сегмент графа, выполняет тело eager, регистрирует его как `replay_fn` и начинает новый сегмент. Поскольку обертка накрывает **весь** forward, реально захваченных операций не остается — `BreakableCUDAGraph.replay()` прокручивает пустые сегменты и вызывает eager-функцию. Инфраструктура (mempool, статические буферы, порядок барьеров, выбор формы) при этом задействована полностью.

В `DecodeCudaGraphRunner.capture_one_shape` стоит проверка:

```python
if self.model_runner.server_args.debug_cuda_graph:
    assert isinstance(self.backend, BreakableCudaGraphBackend), \
        "Breakable CUDA graph is required for --debug-cuda-graph"
```

Дефолтный decode-backend — `full`, поэтому один только `--debug-cuda-graph` уронит старт на этом ассерте. Нужен `--cuda-graph-backend-decode breakable`.

Переменная `SGLANG_USE_BREAKABLE_CUDA_GRAPH`, которую флаг выставляет, в checkout'е (commit `b20c375c`) больше нигде не читается — она не заменяет явный выбор backend'а.

Побочный эффект на prefill: `--debug-cuda-graph` входит в список правил `_disable_tc_piecewise_cudagraph_if_incompatible` («CUDA graph debug mode»), то есть при незаданном `--cuda-graph-backend-prefill` и backend'е `tc_piecewise` prefill-граф выключается.

## Значения и формат

- Значения не принимает.
- На `--device cpu`, `npu`, `xpu`, `mps` флаг молча выключается предупреждением.
- Backend `breakable` на NVIDIA требует пакет `cuda-python` и несовместим с `--enable-memory-saver`.
- Для prefill-фазы ассерт не дублируется, но осмысленно включать флаг вместе с `--cuda-graph-backend-prefill breakable`, иначе prefill останется на другом пути.

## Когда использовать

- Подозрение на порчу данных при реплее: неверные токены появляются только при включенных графах и исчезают при `--disable-decode-cuda-graph`. Флаг разделяет две гипотезы — «граф записал не то» и «модель считает не то».
- Диагностика падений в момент захвата: с eager-исполнением traceback указывает на реальную строку в модели, а не на непрозрачный сбой записи графа.
- Разработка нового backend'а внимания или ядра, где нужно убедиться, что путь захвата/реплея вообще проходим.
- Не используйте для измерений производительности: eager-режим внутри графа медленнее и обычного eager, и настоящего графа.
- Не оставляйте в продовом профиле: скорости графа вы не получаете, а сложность инфраструктуры платите.

## Влияние на производительность и память

- **Latency:** самый медленный из режимов — python-обход модели плюс накладные расходы breakable-инфраструктуры на каждом реплее.
- **Время старта:** захват все равно выполняется по всем формам, поэтому дешевле не становится.
- **VRAM:** сегменты графа пустые, но статические буферы и mempool выделяются как обычно; экономии ждать не надо.
- **Логи:** предупреждение о включении режима печатается один раз при старте.

## Взаимодействие с другими аргументами

- `--cuda-graph-backend-decode`: обязателен со значением `breakable`, иначе ассерт при захвате.
- `--cuda-graph-backend-prefill`: для полноты картины тоже `breakable`; при незаданном значении и `tc_piecewise` флаг выключает prefill-граф через каскад.
- `--enable-breakable-cuda-graph` (устаревший): включает `breakable` только для prefill, decode он не покрывает.
- `--enable-memory-saver`: несовместим с `breakable`.
- `--disable-decode-cuda-graph`: альтернативная гипотеза-проверка — совсем без графов; вместе с `--debug-cuda-graph` бессмысленно.
- `--enable-profile-cuda-graph`: можно включить вместе, но таблицы покажут стоимость eager-исполнения.
- `--enable-torch-compile-debug-mode`: похожее по названию, но другое: тот флаг проверяет стабильность адресов входов в piecewise-графах `torch.compile`.
- `--device`: вне CUDA/HIP флаг отключается.

## Типовые проблемы и диагностика

- **Симптом:** `AssertionError: Breakable CUDA graph is required for --debug-cuda-graph` при старте. **Причина:** decode-backend остался `full`. **Решение:** добавить `--cuda-graph-backend-decode breakable`.
- **Симптом:** предупреждение «--debug-cuda-graph is not supported on non CUDA/HIP devices». **Причина:** `--device` не CUDA/HIP; флаг сброшен.
- **Симптом:** `ImportError: Breakable CUDA graph on NVIDIA requires the 'cuda-python' package.` **Решение:** установить `cuda-python` в окружение движка.
- **Симптом:** ошибка исчезла с флагом. **Вывод:** проблема в записи или реплее графа, а не в вычислениях модели; дальше сужайте по формам через `--cuda-graph-bs-decode`.
- **Что смотреть:** предупреждение «Debug mode for CUDA graph is enabled via breakable CUDA graph…» при старте и `debug_cuda_graph=True` в дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --debug-cuda-graph --cuda-graph-backend-decode breakable
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --debug-cuda-graph --cuda-graph-backend-decode breakable --cuda-graph-bs-decode 1 2
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_executor/runner_backend/utils.py`
- `sglang/python/sglang/srt/model_executor/runner_backend/breakable_cuda_graph_backend.py`
- `sglang/python/sglang/srt/model_executor/runner_backend_utils/breakable_cuda_graph/breakable_cuda_graph.py`
- `sglang/python/sglang/srt/model_executor/runner/decode_cuda_graph_runner.py`
- `sglang/python/sglang/srt/environ.py`
