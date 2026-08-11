---
schema: 1
engine: sglang
primaryName: "--elastic-ep-initial-size"
title: "--elastic-ep-initial-size"
summary: Стартовый размер EP-группы, от которого раз и навсегда считается, сколько экспертов лежит на каждом ранге. Присоединяющаяся группа обязана указывать значение первичного развертывания, иначе раскладка весов не совпадет.
group: parallel
related:
  - --elastic-ep-backend
  - --elastic-ep-join-mode
  - --elastic-ep-join-rank-offset
  - --max-ep-size
  - --ep-size
  - --tp-size
  - --enable-eplb
  - --moe-dense-tp-size
---

# --elastic-ep-initial-size

## Кратко

Elastic EP позволяет добавить новые ранги к уже работающему развертыванию. Число экспертов **на ранг** при этом менять нельзя — оно определяет физическую раскладку весов, зафиксированную при первом запуске. `--elastic-ep-initial-size` и есть тот делитель: `num_local_physical_experts = base_num_physical_experts // initial_ep_size`. Первичное развертывание задает его равным своему `tp_size` (или не задает вовсе — подставится автоматически), а присоединяющаяся группа обязана указать **то же самое** число, которое было у первичного развертывания на старте, а не текущий размер группы.

## Оригинальная справка

```text
EP size used to define the immutable per-rank expert storage layout. Scale joiners must use the primary deployment's launch-time EP size.
```

## Паспорт аргумента

- Флаги: `--elastic-ep-initial-size`
- Группа: `parallel`
- Тип значения: int (`Optional[int]`)
- Допустимые значения: `> 0`; должно делить общее число физических экспертов (`assert base_num_physical_experts % initial_ep_size == 0`)
- Значение по умолчанию: `null`
- Эффективное значение: для первичного развертывания при активном масштабировании `null` заменяется на `tp_size`, и любое другое значение отвергается (`The primary --elastic-ep-initial-size must equal its launch-time TP size (<N>)`). Для присоединяющейся группы (`--elastic-ep-join-mode scale`) значение обязательно и должно быть `<= --elastic-ep-join-rank-offset`
- Где объявлен: `ServerArgs.elastic_ep_initial_size`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, часть экспериментального контура elastic EP
- Этап применения: `_handle_elastic_ep` (валидация и подстановка) → построение `ExpertLocationMetadata` → создание `FusedMoE`-слоев (раскладка хранения экспертов) → пересчет метаданных при scale-up

## Что меняет в движке

### Раскладка хранения

`_compute_elastic_expert_layout` (`sglang/python/sglang/srt/eplb/expert_location.py`):

```python
num_local_physical_experts = base_num_physical_experts // initial_ep_size
num_physical_experts = num_local_physical_experts * effective_ep_size
```

То есть «сколько экспертов на ранг» берется из `initial_ep_size` навсегда, а общее число физических экспертов растет вместе с эффективным размером группы. Без elastic-EP действует обычная формула `num_physical_experts // ep_size`.

В `FusedMoE` (`sglang/python/sglang/srt/layers/moe/fused_moe_triton/layer.py`) для присоединителя в режиме `scale` то же значение используется как `storage_ep_size`, а собственный индекс хранения смещается на `ep_join_rank_offset`:

```python
storage_ep_size = get_parallel().elastic_ep_initial_size
self._expert_storage_rank = get_parallel().ep_join_rank_offset + self.moe_ep_rank
```

### Пересчет при масштабировании

`ModelRunner._expand_eplb_metadata_for_scale` при подключении новой группы расширяет `physical_to_logical_map`, отсчитывая начало добавляемого участка от `old_num_physical - num_local * initial_ep_size`. Ошибка в значении здесь означает не отказ, а неверную карту экспертов — то есть тихо неправильные ответы.

`ElasticEPState._init_joiner_state` использует `elastic_ep_initial_size or ep_join_rank_offset` как `original_ep_size` присоединителя.

## Значения и формат

- Целое `> 0`.
- Для первичного развертывания — только `tp_size` (или не задавать).
- Для присоединителя в режиме `scale` — обязательный аргумент, равный `tp_size` первичного развертывания **на момент его запуска**, и не больше текущего `--elastic-ep-join-rank-offset`.
- Аргумент имеет смысл только при активном масштабировании: `--elastic-ep-backend` задан и `--max-ep-size` больше локального `tp_size`. Иначе — `AssertionError: --elastic-ep-initial-size is only valid for an Elastic EP deployment with --max-ep-size larger than its local TP size.`
- Значение обязано делить общее число физических экспертов модели (с учетом `--ep-num-redundant-experts`).

## Когда использовать

- Запуск присоединяющейся группы к работающему elastic-EP-развертыванию: аргумент обязателен, и его значение берется из истории — это `tp_size`, с которым стартовало первичное развертывание.
- Явно указывать на первичном развертывании имеет смысл только как документирующую запись: движок все равно подставит `tp_size` и отвергнет любое другое значение.
- Не подставлять сюда текущий размер группы после нескольких масштабирований — для этого есть `--elastic-ep-join-rank-offset`. Путаница между «начальный» и «текущий» — главная ошибка в этом контуре.
- Не использовать без `--elastic-ep-backend mooncake` и `--max-ep-size`: весь контур масштабирования требует их.

## Влияние на производительность и память

- Определяет, сколько экспертных весов физически лежит на каждом ранге: `num_local_physical_experts` — прямой множитель к VRAM под MoE-веса. Значение меньше фактического `tp_size` первичного развертывания даст больше экспертов на ранг и, скорее всего, OOM.
- На арифметику forward не влияет: это параметр раскладки.
- Время старта: не меняет.

## Взаимодействие с другими аргументами

- `--elastic-ep-backend`: обязателен (для масштабирования — только `mooncake`).
- `--max-ep-size`: масштабирование считается активным, только если `max_ep_size > tp_size`.
- `--elastic-ep-join-mode scale` + `--elastic-ep-join-rank-offset`: пара для присоединителя; требуется `initial_size <= join_rank_offset`.
- `--ep-size` / `--tp-size`: у масштабируемого развертывания требуется `ep_size == tp_size` и `dp_size == tp_size`.
- `--enable-eplb`: с elastic EP допускаются только алгоритмы `elasticity_aware` / `elasticity_aware_hierarchical` (при `auto` подставляется первый).
- `--moe-dense-tp-size`: присоединяющаяся группа из одного ранга требует значения `1`.

## Типовые проблемы и диагностика

- `AssertionError: --elastic-ep-initial-size is only valid for an Elastic EP deployment with --max-ep-size larger than its local TP size.`
- `AssertionError: Elastic EP scale joiners require --elastic-ep-initial-size set to the primary deployment's launch-time EP size.`
- `AssertionError: --elastic-ep-initial-size cannot exceed the current EP size (initial=…, current=…).`
- `AssertionError: The primary --elastic-ep-initial-size must equal its launch-time TP size (N).`
- `AssertionError` внутри `_compute_elastic_expert_layout` (`base_num_physical_experts % initial_ep_size`) — значение не делит число физических экспертов.
- Модель отвечает бессмыслицей после scale-up при формально успешном старте — почти наверняка неверный `initial_size`: карта `physical_to_logical` расширилась не от той границы. Сверяйте значение с журналом запуска первичного развертывания.
- Что смотреть в логе: `elastic_ep_initial_size=`, `ep_size=`, `max_ep_size=` в дампе `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tensor-parallel-size 8 --dp-size 8 --enable-dp-attention --enable-dp-lm-head --ep-size 8 --moe-a2a-backend nixl --elastic-ep-backend mooncake --max-ep-size 16 --elastic-ep-initial-size 8 --load-balance-method round_robin --disable-cuda-graph
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tensor-parallel-size 8 --dp-size 8 --enable-dp-attention --enable-dp-lm-head --ep-size 8 --moe-a2a-backend nixl --elastic-ep-backend mooncake --max-ep-size 16 --elastic-ep-join-mode scale --node-rank 1 --elastic-ep-initial-size 8 --elastic-ep-join-rank-offset 8 --load-balance-method round_robin --disable-cuda-graph --dist-init-addr 192.168.0.2:25000
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/eplb/expert_location.py`
- `sglang/python/sglang/srt/elastic_ep/elastic_ep.py`
- `sglang/python/sglang/srt/layers/moe/fused_moe_triton/layer.py`
- `sglang/python/sglang/srt/model_executor/model_runner.py`
