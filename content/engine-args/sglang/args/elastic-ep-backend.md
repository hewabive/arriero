---
schema: 1
engine: sglang
primaryName: "--elastic-ep-backend"
title: "--elastic-ep-backend"
summary: Главный выключатель elastic EP — режима, в котором EP-группа переживает падение ранга и умеет расширяться в рантайме. Значение задает коллективный бэкенд (`mooncake` или `nixl`); строка `none` включает elastic EP без транспорта и не равнозначна отсутствию аргумента.
group: exec.moe
related:
  - --elastic-ep-join-mode
  - --elastic-ep-join-rank-offset
  - --elastic-ep-initial-size
  - --elastic-ep-scale-timeout
  - --elastic-ep-rejoin
  - --enable-elastic-expert-backup
  - --mooncake-ib-device
  - --max-ep-size
  - --eplb-algorithm
  - --enable-eplb
  - --moe-a2a-backend
  - --pp-size
  - --load-balance-method
---

# --elastic-ep-backend

## Кратко

Elastic EP решает две разные задачи одним механизмом: пережить падение отдельных рангов EP-группы без перезапуска сервера и добавить новые ранги к работающему серверу. Обе опираются на process-group бэкенд, который умеет помечать пиров живыми/мертвыми и восстанавливать группу, — отсюда требование к транспорту. Аргумент включает механизм целиком; остальные `--elastic-ep-*` флаги настраивают частности. Требования жесткие и проверяются ассертами на старте: `--pp-size 1`, определенный набор алгоритмов EPLB, а для рантайм-расширения — еще полтора десятка условий.

## Оригинальная справка

```text
Specify the collective communication backend for elastic EP. Supports 'mooncake' and 'nixl'.
```

## Паспорт аргумента

- Флаги: `--elastic-ep-backend`
- Группа: `exec.moe`
- Тип значения: перечисление (строка)
- Допустимые значения: `none`, `mooncake`, `nixl`. Внимание: поле объявлено как `Literal[None, "mooncake", "nixl"]`, а `choices` заданы явно строками, поэтому argparse сохраняет именно строку `"none"` — это не то же самое, что не передать аргумент
- Значение по умолчанию: `null` (аргумент не задан — elastic EP выключен)
- Эффективное значение: не переопределяется; сам переопределяет `--eplb-algorithm` (`auto` → `elasticity_aware` при включенном `--enable-eplb`) и нормализует `--mooncake-ib-device` при значении `mooncake`
- Где объявлен: `ServerArgs.elastic_ep_backend`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, но подсистема молодая — набор проверок в `_handle_elastic_ep` меняется от релиза к релизу
- Этап применения: `__post_init__` (`_handle_elastic_ep`) → выбор backend'а `init_process_group` → инициализация `ElasticEPStateManager` в model runner → конец каждого forward-прохода → HTTP `/scale_elastic_ep`

## Что меняет в движке

**Транспорт.** При `mooncake` и устройстве `cuda` `_resolve_backend` подменяет backend `torch.distributed` на `"mooncake"`, и группы создаются с `MooncakeBackendOptions(active_ranks, recovered_rank[, max_world_size])`. Именно этот backend ведет вектор живых рангов: когда пир падает, соответствующая позиция обнуляется. При `nixl` WORLD остается на штатном backend'е, а маску живых рангов поставляет NIXL-диспетчер MoE.

**Состояние.** `ElasticEPStateManager.init` создается в model runner только при заданном аргументе. Он держит `active_ranks`, `effective_ep_size`, фазу масштабирования и признак «уже расширялись». Емкость вектора — `--max-ep-size` или текущий world size.

**Реакция на падение ранга.** В конце каждого forward-прохода при включенном elastic EP вызывается `maybe_join_ep_ranks`. Если масштабирование не идет, отрабатывает `maybe_recover_ep_ranks`: неактивные ранги опрашиваются через `mooncake.pg.get_peer_state`, и, если пир снова готов, выполняется `recover_ranks` для WORLD и всех живых параллельных групп, метаданные раскладки экспертов рассылаются заново, состояние сбрасывается, в лог уходит `recover ranks [...] done`. Отдельно `maybe_rebalance_after_rank_fault` запускает полную перебалансировку EPLB, как только маска живых рангов изменилась (`EPLB due to rank faults`). Обратите внимание: путь восстановления импортирует `mooncake.pg` независимо от выбранного значения аргумента.

**Расширение в рантайме.** `POST /scale_elastic_ep {"new_ep_size": N}` переводит состояние в `waiting_for_cohort`; присоединяющаяся группа стартует отдельным процессом с `--elastic-ep-join-mode scale`. Расширение считается активным только когда задан `--max-ep-size` больше локального `--tp-size`; в этом случае `_handle_elastic_ep` добавляет длинный список проверок, среди которых: `--elastic-ep-backend mooncake` (nixl как транспорт WORLD для расширения не годится), `--moe-a2a-backend nixl`, `--load-balance-method round_robin`, `--tokenizer-worker-num 1`, запрет `--use-ray`, запрет `--enable-elastic-expert-backup`, отключенные CUDA graph для prefill и decode, включенные `--enable-dp-attention` и `--enable-dp-lm-head`, равенства `ep_size == tp_size == dp_size`, `--attn-cp-size 1`, `--moe-dp-size 1`, `--pp-size 1`. Дополнительно принудительно включается `--enable-dp-attention-local-control-broadcast`.

## Значения и формат

- Аргумент не задан — elastic EP выключен, ни одна проверка не выполняется, `ElasticEPStateManager` не создается. Это штатный режим.
- `mooncake` — полноценный вариант: свой process-group backend, восстановление рангов и единственный поддерживаемый транспорт для рантайм-расширения. Требует установленного `mooncake-transfer-engine`; для расширения нужна версия 0.3.11 или выше, иначе на старте `ImportError: Failed to import 'set_transfer_engine' from 'mooncake.pg'`. Пакет тянется по импорту, поэтому его отсутствие всплывает при инициализации, а не при разборе аргументов.
- `nixl` — WORLD остается на обычном backend'е, живые ранги отслеживает NIXL-диспетчер MoE. Требует пакета `nixl_ep`; его отсутствие дает ошибку при создании диспетчера, а не на разборе аргументов.
- `none` — не используйте. Строка проходит `choices`, но во всех проверках стоит `is not None`, поэтому elastic EP включится: запретится `--pp-size` больше единицы, EPLB потребует `elasticity_aware`, `ElasticEPStateManager` поднимется, — а транспорта, умеющего восстанавливать ранги, не будет.

## Когда использовать

- Многоузловая EP-развертка, где падение одного узла не должно означать перезапуск всего сервера: `mooncake` плюс `--enable-eplb`, чтобы после потери ранга раскладка экспертов пересобралась по живым.
- Планируется эластичное масштабирование под пиковую нагрузку: `mooncake` + `--moe-a2a-backend nixl` + `--max-ep-size` больше стартового размера, и весь список условий выше.
- Одна машина, один процесс, обычный inference: не включайте. Elastic EP запрещает pipeline parallelism, навязывает алгоритм EPLB и добавляет опрос состояния пиров в конец каждого forward-прохода.
- Не включайте ради «страховки», если в кластере нет InfiniBand/RDMA и установленного mooncake: механизм не деградирует мягко.

## Влияние на производительность и память

- **Latency.** В конце каждого forward-прохода при включенном elastic EP выполняется проверка `active_ranks.all()` на CUDA-тензоре — это host-device синхронизация. В коде она помечена как известный компромисс, ограниченный именно этим режимом.
- **VRAM.** При заданном `--max-ep-size` буферы диспетчера и состояние активных рангов выделяются сразу под максимальный размер, а не под текущий. Это плата за возможность расшириться без перезапуска.
- **Пропускная способность.** Режим расширения требует отключенных CUDA graph для prefill и decode — на decode это самая дорогая из его цен.
- **Восстановление.** Полная перебалансировка EPLB после смены маски рангов идет без дробления по слоям: генератор прокручивается до конца в одном вызове.

## Взаимодействие с другими аргументами

- `--elastic-ep-join-mode`: требует заданного бэкенда; выбирает роль процесса (восстановление слота или присоединение нового).
- `--elastic-ep-rejoin`: устаревший псевдоним `--elastic-ep-join-mode recover`.
- `--max-ep-size`, `--elastic-ep-initial-size`, `--elastic-ep-join-rank-offset`: геометрия расширяемой группы; первый требует заданного бэкенда, остальные — активного расширения.
- `--elastic-ep-scale-timeout`: срок ожидания присоединяющейся группы.
- `--enable-elastic-expert-backup`: DRAM-бэкап весов экспертов; несовместим с рантайм-расширением.
- `--mooncake-ib-device`: при `mooncake` нормализуется и проверяется по `/sys/class/infiniband`.
- `--eplb-algorithm`: сужается до `elasticity_aware(_hierarchical)`.
- `--moe-a2a-backend`: `mooncake`/`nixl` в качестве a2a — отдельная настройка; для рантайм-расширения обязателен именно `nixl`.
- `--pp-size`: обязан быть 1.

## Типовые проблемы и диагностика

- `AssertionError: PP size should be set to 1 under elastic EP` — включен pipeline parallelism.
- `AssertionError: Elastic EP requires eplb_algorithm to be set to 'auto' or 'elasticity_aware(_hierarchical)'.` — несовместимый алгоритм EPLB.
- `AssertionError: Elastic EP runtime scale-up requires --elastic-ep-backend mooncake (got elastic_ep_backend=nixl)` — расширение возможно только на mooncake.
- `AssertionError: Elastic EP scale-up requires --moe-a2a-backend nixl (...)` — a2a-бэкенд не тот.
- `ImportError: Failed to import 'set_transfer_engine' from 'mooncake.pg'` — старый `mooncake-transfer-engine`, нужна 0.3.11+.
- `ModuleNotFoundError: No module named 'mooncake'` / ошибка создания NIXL-диспетчера — пакет транспорта не установлен; это отказ на импорте, argparse аргумент принял.
- `{"error": "elastic EP is not enabled (set --elastic-ep-backend)"}` с кодом 404 на `/scale_elastic_ep` — аргумент не задан.
- Текущее состояние читается через `GET /is_scaling_elastic_ep`; события восстановления и масштабирования пишутся с префиксом `[Elastic EP]`.

## Примеры

Отказоустойчивая EP-группа без рантайм-расширения:

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --pp-size 1 --moe-a2a-backend deepep --deepep-mode normal --elastic-ep-backend mooncake --mooncake-ib-device mlx5_0,mlx5_1 --enable-eplb
```

Расширяемая развертка (первичная группа):

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --dp-size 8 --ep-size 8 --pp-size 1 --enable-dp-attention --enable-dp-lm-head --moe-a2a-backend nixl --elastic-ep-backend mooncake --max-ep-size 16 --load-balance-method round_robin --tokenizer-worker-num 1 --disable-cuda-graph
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/elastic_ep/elastic_ep.py`
- `sglang/python/sglang/srt/entrypoints/elastic_ep.py`
- `sglang/python/sglang/srt/distributed/bootstrap.py`
- `sglang/python/sglang/srt/distributed/parallel_state.py`
- `sglang/python/sglang/srt/distributed/device_communicators/mooncake_transfer_engine.py`
- `sglang/python/sglang/srt/layers/moe/token_dispatcher/nixl.py`
- `sglang/python/sglang/srt/model_executor/model_runner.py`
- `sglang/python/sglang/srt/arg_groups/arg_utils.py`
