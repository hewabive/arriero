---
schema: 1
engine: sglang
primaryName: "--cuda-graph-bs-decode"
title: "--cuda-graph-bs-decode"
summary: Явный список размеров батча, для которых записывается decode-граф; полностью заменяет сгенерированную сетку и переопределяет `--cuda-graph-max-bs-decode`. Главный инструмент, когда старт нужно сократить до нескольких секунд, а профиль нагрузки известен.
group: exec.graph
related:
  - --cuda-graph-max-bs-decode
  - --cuda-graph-bs
  - --cuda-graph-bs-prefill
  - --cuda-graph-backend-decode
  - --disable-decode-cuda-graph
  - --disable-cuda-graph-padding
  - --cuda-graph-config
  - --max-running-requests
  - --mem-fraction-static
  - --speculative-algorithm
  - --torch-compile-max-bs
---

# --cuda-graph-bs-decode

## Кратко

Вместо «максимум плюс зашитая сетка» этот флаг позволяет перечислить захватываемые размеры батча вручную. Список принимается как есть (сортировка и дедупликация выполняются позже), а `cuda_graph_config[decode].max_bs` перезаписывается его максимумом. Практическая ценность одна: на известном профиле нагрузки — скажем, один-два одновременных запроса на локальном сервере — три-четыре формы вместо двадцати четырех превращают минуту захвата в секунды и снимают лишние мегабайты с VRAM.

## Оригинальная справка

```text
Explicit list of batch sizes to capture for the decode cuda graph.
```

## Паспорт аргумента

- Флаги: `--cuda-graph-bs-decode`
- Группа: `exec.graph`
- Тип значения: список целых, `nargs="+"` — значения разделяются пробелами
- Допустимые значения: положительные целые; argparse содержимое списка не проверяет
- Значение по умолчанию: `null` — список генерируется из `cuda_graph_config[decode].max_bs`
- Эффективное значение: если список задан, `_handle_gpu_memory_settings` ставит `decode.max_bs = max(bs)`; на `--device cpu` вместо этого `torch_compile_max_bs = max(bs)`. Затем `get_batch_sizes_to_capture` фильтрует список по выравниванию и по размеру `req_to_token_pool`, добавляет туда фактический предел запросов, сортирует и дедуплицирует
- Где объявлен: `ServerArgs.cuda_graph_bs_decode`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный. Устаревший псевдоним — `--cuda-graph-bs` (`DeprecatedAliasStoreAction`, тот же `nargs="+"`)
- Этап применения: разбор CLI → `__post_init__` → `get_batch_sizes_to_capture` → захват графов

## Что меняет в движке

Заданный список подменяет собой результат `_generate_decode_cuda_graph_batch_sizes`, то есть отключает и сеточную логику, и влияние `--disable-cuda-graph-padding` на состав форм (флаг padding при этом продолжает работать на выборе графа во время исполнения).

Перед захватом `get_batch_sizes_to_capture` (`model_executor/runner/base_cuda_graph_runner.py`) приводит список к исполнимому виду:

1. `num_max_requests = req_to_token_pool.size`, выровненный вверх по `get_cuda_graph_batch_size_alignment` (двойка при two-batch overlap, `attn_tp_size` при собранном буфере, `attn_cp_size`);
2. если `max(bs) > num_max_requests`, в список **добавляется** `num_max_requests` — движок гарантирует, что максимальный реально возможный батч захвачен;
3. выбрасываются формы, у которых `bs * ширина_запроса` не кратно выравниванию, и все, что больше `num_max_requests`;
4. `sorted(set(...))`;
5. ассерт `len(capture_bs) > 0 and capture_bs[0] > 0`.

Отдельно из этого списка выводится `compile_bs` — подмножество форм не больше `--torch-compile-max-bs`, для которых при `--enable-torch-compile` включается `torch.compile`.

На `--device cpu` тот же список используется для CPU-графа (`cpu_graph_runner.get_batch_sizes_to_capture`), и там действует жесткий ассерт `max(capture_bs) <= torch_compile_max_bs`.

## Значения и формат

- Формат — пробелы, а не запятые: `--cuda-graph-bs-decode 1 2 4 8`. Запятые argparse не разберет как int.
- Порядок не важен, дубликаты допустимы: список сортируется и дедуплицируется.
- Значения больше фактического предела запросов молча отбрасываются, а сам предел добавляется в список. Итог смотрите в логе, а не в своей команде.
- Ноль или отрицательные значения приведут к падению ассерта `capture_bs=…` при старте.
- Список должен покрывать типовые батчи: непокрытый размер округляется вверх до ближайшего захваченного, а батч больше максимума уходит в eager.
- Задание списка фиксирует пару `(decode, "bs")` в `_cuda_graph_config_locked`.

## Когда использовать

- Локальный однопользовательский сервер: `--cuda-graph-bs-decode 1 2 4` покрывает реальную нагрузку и сокращает захват до трех форм.
- Известный SLA по конкурентности: захватывать имеет смысл только те размеры, которые планировщик реально соберет.
- Спекулятивное декодирование с фиксированным числом слотов: сетка по умолчанию плотная (39 форм при `max_bs 160`), а вам может хватить пяти.
- Не используйте список, если нагрузка непредсказуема: непокрытые размеры дают либо лишний padding, либо полный откат в eager, и то и другое хуже, чем чуть более долгий старт.
- Не дублируйте `--cuda-graph-max-bs-decode` вместе со списком: максимум все равно возьмется из списка.

## Влияние на производительность и память

- **Время старта** пропорционально длине итогового списка. Для сравнения: автосписок при `max_bs 24` — 7 форм, при `160` — 24, при `512` — 52.
- **VRAM.** Априорный резерв в автоподборе `--mem-fraction-static` считается не от длины списка, а от `decode.max_bs * 2` МиБ — то есть от **максимума** вашего списка. Список `1 2 4 512` зарезервирует столько же, сколько полная сетка до 512, хотя захватит четыре формы. Фактический расход — в строке `Capture target decode CUDA graph end. … mem usage=… GB`.
- **Latency.** Батч, попавший точно в захваченную форму, исполняется быстрее всего; батч между формами дополняется до верхней; батч выше максимума теряет весь выигрыш графа.
- Захват идет от большего к меньшему, поэтому крупные формы задают размер общего mempool, а мелкие переиспользуют его.

## Взаимодействие с другими аргументами

- `--cuda-graph-max-bs-decode`: перекрывается этим списком.
- `--cuda-graph-config`: ключ `decode.bs` перекрывает флаг.
- `--cuda-graph-bs` (устаревший): то же поле под старым именем.
- `--max-running-requests`: определяет фактический предел, по которому список обрезается и дополняется.
- `--disable-cuda-graph-padding`: при заданном списке не меняет его состав, но во время исполнения запрещает подбор формы «снизу вверх» — батч исполняется графом, только если его размер захвачен точно.
- `--speculative-algorithm`: списком вы отключаете более плотную спекулятивную сетку; убедитесь, что нужные размеры перечислены.
- `--torch-compile-max-bs` / `--enable-torch-compile`: из списка выделяется подмножество для `torch.compile`.
- `--device cpu`: список становится набором форм CPU-графа, и его максимум обязан не превышать `--torch-compile-max-bs`.

## Типовые проблемы и диагностика

- **Симптом:** `AssertionError: capture_bs=[]` или `capture_bs[0] > 0` при старте. **Причина:** все формы отфильтрованы выравниванием или пределом запросов, либо в списке ноль/отрицательное число.
- **Симптом:** в логе `bs=[…]` содержит числа, которых вы не писали. **Причина:** движок добавил фактический предел запросов, чтобы максимальный батч был захвачен.
- **Симптом:** `AssertionError: capture_bs=…, server_args.torch_compile_max_bs=…` на `--device cpu`. **Решение:** поднять `--torch-compile-max-bs` до максимума списка.
- **Симптом:** старт быстрый, но декодирование медленное. **Причина:** реальные батчи больше максимума списка и идут в eager. **Проверка:** сопоставьте `bs=[…]` из лога с `Decode batch, #running-req: …`.
- **Что смотреть:** `Capture target decode CUDA graph begin. backend=…, num_tokens_per_req=…, bs=[…]` — итоговый список после всех фильтров.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --cuda-graph-bs-decode 1 2 4
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --cuda-graph-bs-decode 1 2 4 8 16 --max-running-requests 16 --mem-fraction-static 0.85
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/arg_utils.py`
- `sglang/python/sglang/srt/model_executor/runner/base_cuda_graph_runner.py`
- `sglang/python/sglang/srt/model_executor/runner/decode_cuda_graph_runner.py`
- `sglang/python/sglang/srt/model_executor/cpu_graph_runner.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/cuda_graph_setup.py`
