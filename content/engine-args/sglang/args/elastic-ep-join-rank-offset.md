---
schema: 1
engine: sglang
primaryName: "--elastic-ep-join-rank-offset"
title: "--elastic-ep-join-rank-offset"
summary: Глобальное смещение рангов присоединяющейся elastic-EP-группы — текущий эффективный размер EP на момент подключения. Сдвигает и world size, и индексы хранения экспертов, и нумерацию в логах.
group: parallel
related:
  - --elastic-ep-join-mode
  - --elastic-ep-initial-size
  - --elastic-ep-backend
  - --max-ep-size
  - --node-rank
  - --tp-size
  - --ep-size
  - --dist-init-addr
---

# --elastic-ep-join-rank-offset

## Кратко

Когда к работающему elastic-EP-развертыванию подключается новая TP-группа, ее ранги обязаны продолжить нумерацию, а не начать с нуля. `--elastic-ep-join-rank-offset` задает это смещение: значение равно **текущему эффективному размеру EP** — сколько рангов уже работает. Отсюда `rank = offset + tp_size * pp_rank + tp_rank` и `world_size = offset + tp_size * pp_size`. Смещение участвует не только в distributed-инициализации: от него зависят индекс хранения экспертов, ранг в DP-attention, ранг EPLB и номера в префиксах строк лога.

## Оригинальная справка

```text
Global rank offset of an elastic EP joining group. Scale joiners must set this to the current effective EP size.
```

## Паспорт аргумента

- Флаги: `--elastic-ep-join-rank-offset`
- Группа: `parallel`
- Тип значения: int
- Допустимые значения: `>= 0`; при значении `!= 0` обязателен `--elastic-ep-join-mode scale`, а при `scale` требуется строго `> 0`
- Значение по умолчанию: `0`
- Эффективное значение: совпадает с заданным; автоподбора нет. Обратите внимание на расхождение имен: CLI-флаг `--elastic-ep-join-rank-offset`, а поле датакласса — `ep_join_rank_offset`
- Где объявлен: `ServerArgs.ep_join_rank_offset`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, часть экспериментального контура elastic EP
- Этап применения: `_handle_elastic_ep` (валидация) → `init_torch_distributed` (`world_size`/`rank`) → `initialize_model_parallel` (`rank_offset`) → DP-attention, EPLB, раскладка экспертов, префиксы лога

## Что меняет в движке

### Distributed-инициализация

`_init_parallel_groups` (`sglang/python/sglang/srt/distributed/bootstrap.py`):

```python
rank_offset = server_args.ep_join_rank_offset if is_scale_joiner else 0
world_size = rank_offset + tp_size * pp_size if is_scale_joiner else tp_size * pp_size
rank = rank_offset + tp_size * pp_rank + tp_rank
```

Смещение уходит и в `initialize_model_parallel(rank_offset=…)`, где на него сдвигаются списки рангов всех групп.

### Раскладка экспертов

- `FusedMoE`: в режиме `scale` индекс хранения — `ep_join_rank_offset + moe_ep_rank`, а делителем остается `--elastic-ep-initial-size`.
- `ExpertLocationMetadata.init_new`: эффективный `ep_size` берется как `max(ep_size, ep_join_rank_offset + tp_size)`.
- `ModelRunner._elastic_global_rank()` = `tp_rank + ep_join_rank_offset`; та же формула в `eplb_manager` и в диспетчере nixl.
- `ElasticEPState._init_joiner_state`: `effective_ep_size = ep_join_rank_offset + tp_size`, а `original_ep_size` — `elastic_ep_initial_size` или, если он не задан, сам offset.

### DP-attention и логи

`layers/dp_attention.py` сдвигает `_ATTN_DP_RANK = tp_rank + server_args.ep_join_rank_offset`. Data-parallel-контроллер использует то же смещение для «отображаемых» рангов: `display_tp_rank = tp_rank + offset`, `display_moe_ep_rank`, `display_dp_rank`. Внутренние структуры при этом продолжают работать с локальными рангами — расхождение между локальной и глобальной нумерацией сделано осознанно, и в логах видны именно глобальные номера.

### Порты

При `is_ep_scale_joiner` присоединитель не проверяет доступность `dist_init_port` (рандеву принадлежит первичному развертыванию) и выводит собственную базу портов от своего `--port`, а выходы возвращает через tokenizer первичного развертывания (`PortArgs.init_new`).

## Значения и формат

- Целое `>= 0`. `0` — «обычный запуск, не присоединитель».
- Ненулевое значение без `--elastic-ep-join-mode scale`: `AssertionError: --elastic-ep-join-rank-offset is only valid with --elastic-ep-join-mode scale.`
- В режиме `scale` требуется `> 0`: `AssertionError: Elastic EP scale joiners require --elastic-ep-join-rank-offset set to the current effective EP size.`
- Сумма `offset + tp_size` не должна превышать `--max-ep-size`: `AssertionError: Elastic EP joining group exceeds --max-ep-size (join_target=…, max_ep_size=…).`
- Значение не может быть меньше `--elastic-ep-initial-size`.
- Режим `scale` дополнительно требует `--node-rank 1`.

## Когда использовать

- Только при запуске присоединяющейся группы (`--elastic-ep-join-mode scale`). Значение — количество рангов, уже работающих в развертывании на момент подключения: после первого масштабирования 8→16 следующий присоединитель ставит `16`, а не `8`.
- Не путать с `--elastic-ep-initial-size`: тот фиксирует раскладку хранения и **не меняется** между масштабированиями, этот растет с каждым подключением.
- Не задавать на первичном развертывании и на обычном (не-elastic) сервере.

## Влияние на производительность и память

- Прямого влияния на скорость и память нет: это адресная арифметика.
- Косвенно определяет, какие эксперты окажутся на присоединившихся рангах, а значит и распределение нагрузки MoE. Неверное смещение дает перекос или дублирование экспертов.

## Взаимодействие с другими аргументами

- `--elastic-ep-join-mode scale`: обязательная пара; при других значениях режима смещение запрещено.
- `--elastic-ep-initial-size`: должен быть `<= offset`; вместе они определяют раскладку экспертов присоединителя.
- `--max-ep-size`: ограничивает `offset + tp_size`.
- `--node-rank`: режим `scale` требует `1`.
- `--tp-size` / `--ep-size` / `--dp-size`: для масштабируемого развертывания требуется `ep_size == tp_size == dp_size`.
- `--dist-init-addr`: присоединитель подключается к рандеву первичного развертывания.
- `--elastic-ep-backend`: только `mooncake` для scale-up.

## Типовые проблемы и диагностика

- `AssertionError: --elastic-ep-join-rank-offset is only valid with --elastic-ep-join-mode scale.`
- `AssertionError: Elastic EP scale joiners require --elastic-ep-join-rank-offset set to the current effective EP size.`
- `AssertionError: Elastic EP scale-up requires one joining TP group at --node-rank 1 (got N).`
- `AssertionError: Elastic EP joining group exceeds --max-ep-size (join_target=…, max_ep_size=…).`
- Присоединитель «повис» на инициализации distributed — почти всегда смещение не совпало с реальным числом работающих рангов, и world size у сторон разный. Сверяйте с текущим эффективным размером группы у первичного развертывания.
- Номера в логах присоединителя начинаются не с нуля — так и задумано: печатаются глобальные ранги (`display_tp_rank = tp_rank + offset`).
- Что смотреть в логе: `ep_join_rank_offset=` в дампе `server_args=`, префиксы ` TP<n>` / ` EP<n>` в строках лога присоединителя.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tensor-parallel-size 8 --dp-size 8 --enable-dp-attention --enable-dp-lm-head --ep-size 8 --moe-a2a-backend nixl --elastic-ep-backend mooncake --max-ep-size 16 --elastic-ep-join-mode scale --node-rank 1 --elastic-ep-initial-size 8 --elastic-ep-join-rank-offset 8 --load-balance-method round_robin --disable-cuda-graph --dist-init-addr 192.168.0.2:25000
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tensor-parallel-size 8 --dp-size 8 --enable-dp-attention --enable-dp-lm-head --ep-size 8 --moe-a2a-backend nixl --elastic-ep-backend mooncake --max-ep-size 24 --elastic-ep-join-mode scale --node-rank 1 --elastic-ep-initial-size 8 --elastic-ep-join-rank-offset 16 --load-balance-method round_robin --disable-cuda-graph --dist-init-addr 192.168.0.2:25000
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/distributed/bootstrap.py`
- `sglang/python/sglang/srt/elastic_ep/elastic_ep.py`
- `sglang/python/sglang/srt/eplb/expert_location.py`
- `sglang/python/sglang/srt/eplb/eplb_manager.py`
- `sglang/python/sglang/srt/layers/moe/fused_moe_triton/layer.py`
- `sglang/python/sglang/srt/layers/dp_attention.py`
- `sglang/python/sglang/srt/managers/data_parallel_controller.py`
- `sglang/python/sglang/srt/model_executor/model_runner.py`
