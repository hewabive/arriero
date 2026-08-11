---
schema: 1
engine: sglang
primaryName: "--sm-group-num"
title: "--sm-group-num"
summary: Сколько копий decode-backend'а внимания создать под PD-Multiplexing — по одной на группу потоков. Читается только при `--enable-pdmux` и должен быть не меньше числа групп из `--pdmux-config-path`, иначе переключение упадет по индексу.
group: disagg
related:
  - --enable-pdmux
  - --pdmux-config-path
  - --attention-backend
  - --cuda-graph-bs
  - --cuda-graph-max-bs
  - --disable-overlap-schedule
  - --chunked-prefill-size
---

# --sm-group-num

## Кратко

Название обманчиво: аргумент не делит SM. Деление SM целиком описывается конфигом `--pdmux-config-path` (ключ `sm_group_num` внутри YAML). CLI-флаг `--sm-group-num` делает ровно одно — задает длину массива `decode_attn_backend_group`, то есть сколько отдельных экземпляров decode-backend'а внимания создать, чтобы каждая группа потоков имела свой набор метаданных и своё cuda-graph-состояние. Значение по умолчанию `8` совпадает с умолчанием `sm_group_num` в конфиге, поэтому без файла ничего настраивать не нужно.

## Оригинальная справка

```text
Number of sm partition groups.
```

## Паспорт аргумента

- Флаги: `--sm-group-num`
- Группа: `disagg`
- Тип значения: int
- Допустимые значения: `choices` нет; должно быть ≥ фактического числа групп потоков
- Значение по умолчанию: `8`
- Эффективное значение: совпадает с заданным — ни один `_handle_*` его не переписывает. Но **фактическое** число групп потоков берется не отсюда, а из `sm_group_num` в YAML `--pdmux-config-path` (и может оказаться меньше него, если `divide_sm` не набрал делений)
- Где объявлен: `ServerArgs.sm_group_num`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `attention_backend_setup` при инициализации model runner'а, только при `--enable-pdmux`; дальше массив индексируется на каждой смене группы потоков

## Что меняет в движке

В `model_executor/model_runner_components/attention_backend_setup.py` при `enable_pdmux`:

```python
attn_backend = _build_resolved_backend(..., init_new_workspace=True)
decode_attn_backend_group = [
    _build_resolved_backend(..., init_new_workspace=False)
    for _ in range(server_args.sm_group_num)
]
decode_attn_backend = decode_attn_backend_group[0]
```

То есть создается `sm_group_num` экземпляров одного и того же backend'а внимания. Рабочее пространство (workspace) выделяется только для первого, остальные его переиспользуют (`init_new_workspace=False`), но собственные буферы метаданных и cuda-graph-состояние у каждого свои: `maybe_init_pdmux` в `decode_cuda_graph_runner.py` проходит по всему массиву и вызывает `init_cuda_graph_state(max_bs, max_num_token)` на каждом.

Дальше `Scheduler.adjust_stream_groups` на каждой смене группы вызывает `model_runner.update_decode_attn_backend(stream_idx)`, который просто делает `self.decode_attn_backend = self.decode_attn_backend_group[stream_idx]`. Индекс приходит из логики pdmux и лежит в диапазоне `0 … real_sm_group_num - 1`, где `real_sm_group_num = len(STREAM_GROUPS)`.

Отсюда единственное реальное требование к значению: **`--sm-group-num` ≥ `real_sm_group_num`**. Меньшее значение — `IndexError: list index out of range` в момент, когда планировщик впервые переключится на группу с большим индексом (то есть под нагрузкой, а не на старте). Большее — просто неиспользуемые экземпляры backend'а, за которые вы заплатили памятью cuda-graph-состояния.

## Значения и формат

- Целое ≥ 1. Проверки нет ни на положительность, ни на согласованность с конфигом.
- Практическое правило: держите значение **равным** `sm_group_num` из `--pdmux-config-path`. Умолчания обоих равны `8`, поэтому без файла менять нечего.
- Если `--pdmux-config-path` не задан, конфиг берет `sm_group_num = 8`, и фактическое число групп будет `min(8, 2 + число найденных делений SM)`.
- Вне `--enable-pdmux` значение не читается вообще.
- `0` создаст пустой массив и упадет на `decode_attn_backend_group[0]` сразу при инициализации.

## Когда использовать

- Вы задали `--pdmux-config-path` с `sm_group_num`, отличным от 8: приведите `--sm-group-num` к тому же числу.
- Вы уменьшили число групп в конфиге ради экономии VRAM под графы: уменьшите и этот аргумент, иначе лишние экземпляры backend'а продолжат занимать cuda-graph-состояние.
- Не поднимайте «с запасом»: запас стоит памяти и ничего не дает — индексы больше `real_sm_group_num - 1` никогда не запрашиваются.
- Не трогайте без `--enable-pdmux`.

## Влияние на производительность и память

- **VRAM.** `--sm-group-num` экземпляров backend'а получают cuda-graph-состояние, рассчитанное на `max_bs` и `max_num_token`. Рабочее пространство общее, но метаданные и графовые буферы — нет. Это единственный расход, за который отвечает именно этот аргумент.
- **Время старта.** `init_cuda_graph_state` вызывается на каждом экземпляре; сам захват графов идет по числу **групп потоков**, а не по этому значению.
- **Latency/throughput.** Прямого влияния нет: переключение — это присваивание ссылки. Влияет конфиг делений, а не размер массива.
- **RAM хоста.** Пренебрежимо.

## Взаимодействие с другими аргументами

- `--enable-pdmux`: без него значение не читается.
- `--pdmux-config-path`: его `sm_group_num` задает фактическое число групп; этот CLI-аргумент обязан быть не меньше.
- `--attention-backend`: определяет, экземпляры какого именно backend'а размножаются; тяжелые backend'ы с большими метаданными делают цену группы заметнее.
- `--cuda-graph-max-bs` / `--cuda-graph-bs`: размер cuda-graph-состояния каждого экземпляра.

## Типовые проблемы и диагностика

- `IndexError: list index out of range` в `update_decode_attn_backend` под нагрузкой — `--sm-group-num` меньше фактического числа групп потоков. Сверьте его со строкой `PD-Multiplexing enabled with N stream groups, ...` в логе старта: значение должно быть ≥ `N`.
- OOM вскоре после инициализации model runner'а при включенном pdmux — уменьшайте `--sm-group-num` вместе с `sm_group_num` в конфиге либо `--cuda-graph-max-bs`.
- Значение задано без `--enable-pdmux` и «ничего не делает» — так и есть, оно читается только в ветке pdmux.
- Принятое значение — в дампе `server_args=` при старте; фактическое число групп — только в строке `PD-Multiplexing enabled with N stream groups, sm_counts (prefill_sm, decode_sm): [...]`. Эти два числа надо сверять вручную, движок их не сверяет.

## Примеры

```bash
python -m sglang.launch_server --model-path Qwen/Qwen3-32B --enable-pdmux --sm-group-num 8 --chunked-prefill-size -1 --disable-overlap-schedule
```

```bash
python -m sglang.launch_server --model-path meta-llama/Llama-3.1-8B-Instruct --enable-pdmux --pdmux-config-path /etc/sglang/pdmux.yaml --sm-group-num 5 --chunked-prefill-size -1 --disable-overlap-schedule --cuda-graph-max-bs 16
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/attention_backend_setup.py`
- `sglang/python/sglang/srt/model_executor/model_runner.py`
- `sglang/python/sglang/srt/model_executor/runner/decode_cuda_graph_runner.py`
- `sglang/python/sglang/srt/multiplex/pdmux_context.py`
- `sglang/python/sglang/srt/multiplex/multiplexing_mixin.py`
