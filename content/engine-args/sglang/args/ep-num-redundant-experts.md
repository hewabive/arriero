---
schema: 1
engine: sglang
primaryName: "--ep-num-redundant-experts"
title: "--ep-num-redundant-experts"
summary: Добавляет дополнительные физические слоты экспертов поверх логических, чтобы «горячие» эксперты можно было размножить между рангами. Сам по себе только тратит VRAM — раскладку по слотам делает EPLB или явное начальное размещение.
group: exec.moe
related:
  - --enable-eplb
  - --ep-size
  - --ep-dispatch-algorithm
  - --init-expert-location
  - --moe-a2a-backend
---

# --ep-num-redundant-experts

## Кратко

`--ep-num-redundant-experts R` увеличивает число **физических** экспертов слоя: `num_physical = num_logical + R`. Лишние слоты — это реплики логических экспертов, которые балансировщик может разложить по рангам так, чтобы популярный эксперт обслуживался несколькими GPU. Аргумент задает только бюджет реплик; кто и куда их положит, определяют `--enable-eplb`, `--init-expert-location` и `--ep-dispatch-algorithm`.

## Оригинальная справка

```text
Allocate this number of redundant experts in expert parallel.
```

## Паспорт аргумента

- Флаги: `--ep-num-redundant-experts`
- Группа: `exec.moe`
- Тип значения: целое
- Допустимые значения: не ограничены на уровне argparse; действует жесткое требование делимости (см. ниже)
- Значение по умолчанию: `0`
- Эффективное значение: не переопределяется; но `ExpertLocationMetadata._init_common` проверяет `num_physical_experts % ep_size == 0` ассертом, а часть моделей требует ровно `0`
- Где объявлен: `ServerArgs.ep_num_redundant_experts`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: построение модели (размерность экспертных тензоров), инициализация метаданных расположения экспертов, каждый forward при активном remap

## Что меняет в движке

1. **Размерность слоя.** Реализации MoE-моделей строят `FusedMoE` с `num_experts = <логические эксперты> + get_exec().moe.ep_num_redundant_experts` (`deepseek_v2.py`, `qwen3_moe.py`, `glm4_moe.py`, `minimax_m2.py` и другие). То есть под реплики реально выделяются веса.
2. **Метаданные расположения.** `ExpertLocationMetadata._init_common` считает `base_num_physical_experts = num_logical_experts + ep_num_redundant_experts` и требует делимости на `ep_size`: `assert num_physical_experts % ep_size == 0`. Локальное число экспертов на ранг — `num_physical_experts // ep_size`.
3. **Начальная раскладка.** При тривиальном размещении (`--init-expert-location trivial`, значение по умолчанию) `init_trivial` строит карту `arange(0, base_num_physical_experts) % num_logical_experts` — первые `num_logical` слотов идентичны, а `R` дополнительных достаются логическим экспертам `0…R-1` по порядку.
4. **Маршрутизация.** Перевод логических id в физические выполняется только если задан `--ep-dispatch-algorithm`: `ExpertLocationDispatchInfo.init_new` возвращает `None`, когда алгоритм не задан. Значение по умолчанию для алгоритма выставляется в `_handle_eplb_and_dispatch` **только** при `--enable-eplb` или нетривиальном `--init-expert-location` — наличие одних лишь избыточных экспертов такой подстановки не вызывает. В DeepSeek-V2/V3 к этому добавляется собственное условие: `ExpertLocationDispatchInfo` создается только при `enable_eplb`.

Вывод, который стоит держать в голове: `--ep-num-redundant-experts R` без EPLB и без нетривиального начального размещения выделяет и загружает `R` дополнительных экспертов на слой, но маршрутизатор в них не попадает.

## Значения и формат

- `0` — выключено, реплик нет.
- `R > 0` — требуется, чтобы `(num_logical_experts + R)` делилось на `--ep-size`. Практически это означает, что `R` кратно `ep_size`, если число логических экспертов уже кратно ему (типичный случай — 256 экспертов DeepSeek на 8 или 16 рангов).
- Часть моделей не поддерживает реплики и падает ассертом на любом ненулевом значении (в checkout'е это `bailing_moe` и `llada2` — там стоит явный `assert … == 0` с пометкой «not supported now»).
- Значение общее для всех слоев модели: бюджет реплик на слой, а не на всю сеть.

## Когда использовать

- Крупная EP-развертка, где распределение токенов по экспертам заметно неравномерно, и профиль показывает, что часть рангов простаивает. Тогда `--ep-num-redundant-experts` вместе с `--enable-eplb` дает балансировщику пространство для маневра.
- При статической, заранее посчитанной раскладке — вместе с `--init-expert-location`.
- Не включайте на одной GPU или при `--ep-size 1`: балансировать нечего, а VRAM реплики съедят.
- Не включайте «на всякий случай» без EPLB: см. раздел выше — слоты будут мертвым грузом.

## Влияние на производительность и память

- **VRAM.** Прямой линейный расход: `R` дополнительных наборов весов эксперта на каждый MoE-слой, распределенных по рангам. Это единственный существенный расход, который вносит аргумент.
- **Throughput.** Выигрыш появляется опосредованно — через выравнивание нагрузки между рангами (меньше простоя на самом загруженном ранге в каждом слое MoE).
- **Latency.** Сам по себе remap логических id в физические — дешевая индексная операция; заметного вклада в latency он не дает.
- **Старт.** Реплики удлиняют загрузку весов пропорционально их числу.

## Взаимодействие с другими аргументами

- `--enable-eplb`: основной потребитель бюджета реплик. EPLB считает раскладку `physical_to_logical_map` по статистике активаций и переносит/размножает эксперты в пределах выделенных слотов.
- `--init-expert-location`: статическая альтернатива EPLB; нетривиальное значение включает подстановку `--ep-dispatch-algorithm` по умолчанию.
- `--ep-dispatch-algorithm`: определяет, какую физическую реплику выбирает ранг (`static`, `dynamic`, `fake`, `lp`).
- `--moe-a2a-backend`: при `none` требуется ранг-инвариантный выбор реплики — `static` и `lp` в этом случае запрещены с явной ошибкой, потому что все ранги считают одни и те же токены и обязаны выбрать одну и ту же реплику.
- `--ep-size`: делитель в проверке делимости и знаменатель для локального числа экспертов.
- `--enable-waterfill`: при статическом EPLB учитывает реплики в расчете слотов на ранг (`num_routed_experts + ep_num_redundant_experts`).
- В гибридном режиме KTransformers эта же карта `physical_to_logical_map_cpu` передается в kt-kernel при загрузке CPU-весов (`KTEPWrapperMethod.process_weights_after_loading`), то есть раскладка касается и CPU-части.

## Типовые проблемы и диагностика

- `AssertionError` в `ExpertLocationMetadata._init_common` — сумма логических и избыточных экспертов не делится на `--ep-size`.
- Ассерт вида `assert get_exec().moe.ep_num_redundant_experts == 0` — модель не поддерживает реплики.
- VRAM вырос, а балансировки нет — включен только этот аргумент. Добавьте `--enable-eplb` (или `--init-expert-location`), иначе слоты не используются.
- Расход VRAM на реплики оценивается как `R × (размер весов одного эксперта) × (число MoE-слоев)`, распределенный по рангам.
- Итоговое значение — в дампе `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`); фактическую раскладку можно вывести в лог переменной `SGLANG_LOG_EXPERT_LOCATION_METADATA`, которую читает EPLB-менеджер.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --moe-a2a-backend deepep --ep-num-redundant-experts 32 --enable-eplb
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --moe-a2a-backend deepep --ep-num-redundant-experts 16 --enable-eplb --eplb-rebalance-num-iterations 2000
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/eplb/expert_location.py`
- `sglang/python/sglang/srt/eplb/expert_location_dispatch.py`
- `sglang/python/sglang/srt/layers/moe/topk.py`
- `sglang/python/sglang/srt/models/deepseek_v2.py`
- `sglang/python/sglang/srt/models/qwen3_moe.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/moe_ep_setup.py`
- `sglang/docs/docs/advanced_features/expert_parallelism.mdx`
