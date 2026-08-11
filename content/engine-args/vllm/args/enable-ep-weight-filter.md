---
schema: 1
engine: vllm
primaryName: "--enable-ep-weight-filter"
title: "--enable-ep-weight-filter"
summary: При активном экспертном параллелизме ранг перестаёт читать с диска чужие экспертные тензоры. Сокращает дисковый ввод-вывод при загрузке MoE-модели в разы, но действует только на потензорных чекпоинтах и только на обычном пути safetensors.
group: ParallelConfig
related:
  - --enable-expert-parallel
  - --enable-eplb
  - --expert-placement-strategy
  - --load-format
  - --model-loader-extra-config
  - --tensor-parallel-size
  - --data-parallel-size
---

# --enable-ep-weight-filter

## Кратко

При экспертном параллелизме каждому рангу нужны веса только своих экспертов, но по умолчанию загрузчик всё равно читает весь чекпоинт и отбрасывает лишнее уже в памяти. `--enable-ep-weight-filter` переносит отбрасывание **до** чтения с диска: ранг открывает safetensors и пропускает тензоры чужих экспертов, не поднимая их байты.

Экономия существенна: в докстринге модуля указано, что на экспертов приходится порядка 85–90 % байтов весов MoE-модели.

У флага три условия применимости, каждое из которых легко нарушить незаметно: активный EP, MoE-модель и чекпоинт, где эксперты лежат отдельными тензорами с номером в имени.

## Оригинальная справка

```text
Skip non-local expert weights during model loading when expert
parallelism is active.  Each rank only reads its own expert shard from
disk, which can drastically reduce storage I/O for MoE models with
per-expert weight tensors (e.g. DeepSeek, Mixtral, Kimi-K2.5).  Has no
effect on 3D fused-expert checkpoints (e.g. GPT-OSS) or non-MoE
models.
```

## Паспорт аргумента

- Флаги: `--enable-ep-weight-filter`, `--no-enable-ep-weight-filter`
- Группа argparse: `ParallelConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг ⇒ `True`, `--no-enable-ep-weight-filter` ⇒ `False`; не задан ⇒ `False`
- Значение по умолчанию: `False`
- Эффективное значение: при `True` фильтр всё равно **не применяется**, если модель не MoE, если не задан `--enable-expert-parallel`, если включён `--enable-eplb`, если `ep_size <= 1` или если число экспертов не положительно (`DefaultModelLoader._init_ep_weight_filter`)
- Где объявлен: `vllm/config/parallel.py:ParallelConfig.enable_ep_weight_filter`
- Этап применения: загрузка весов (`DefaultModelLoader.load_weights` → итератор safetensors)

## Что меняет в движке

`_init_ep_weight_filter` вычисляет `ep_size` и `ep_rank` по той же формуле, что `FusedMoEParallelConfig.make` (`ep_size = dp × pcp × tp`), и через `compute_local_expert_ids(num_experts, ep_size, ep_rank, placement)` получает множество глобальных индексов «своих» экспертов. Раскладка берётся из `--expert-placement-strategy`, поэтому фильтр и слои модели видят один и тот же набор.

Дальше `should_skip_weight(weight_name, local_expert_ids)` решает по имени тензора:

- имя разбирается регулярным выражением `\.experts\.(\d+)\.` — только **потензорные** эксперты. Трёхмерные слитые тензоры вида `.experts.gate_proj.weight` (GPT-OSS) номера не содержат и не фильтруются никогда;
- пропускаются только тяжёлые тензоры с суффиксом `.weight` или `.weight_packed`. Масштабы и метаданные читаются со **всех** экспертов намеренно: они малы, а некоторым backend'ам (FlashInfer NVFP4) нужен глобальный максимум по всем экспертам;
- всё, что не является экспертным тензором (внимание, нормализации, эмбеддинги, shared-эксперты), не трогается.

**EPLB отключает фильтр целиком.** Комментарий в `_init_ep_weight_filter` объясняет: при EPLB избыточные физические слоты могут ссылаться на логических экспертов, чужих по умолчанию, и загрузчику нужны все экспертные веса, чтобы эти слоты заполнить.

**Фильтр доходит только до одного пути загрузки.** `local_expert_ids` передаётся в `safetensors_weights_iterator`. Ветки `multi_thread_safetensors_weights_iterator` (включается через `--model-loader-extra-config '{"enable_multithread_load": true}'`) и `instanttensor_weights_iterator` этот аргумент не получают — с ними фильтр не действует.

## Значения и формат

- Булев флаг без значения. «Не задан» = `False`.
- `--no-enable-ep-weight-filter` — явное подтверждение дефолта.
- Специальных значений нет; настройки у фильтра нет — множество локальных экспертов выводится из EP-топологии и стратегии раскладки.

## Когда использовать

- **MoE-модель с потензорными экспертами и медленным или сетевым хранилищем.** В справке перечислены DeepSeek, Mixtral, Kimi-K2.5 — модели, где каждый эксперт лежит отдельными тензорами.
- **Много рангов на один чекпоинт.** Без фильтра каждый из `ep_size` процессов вычитывает весь чекпоинт целиком; при восьми рангах это восьмикратный трафик по одному и тому же файлу.
- **Не ждите эффекта на слитых чекпоинтах** (GPT-OSS и подобные): справка это прямо оговаривает, и код подтверждает — регулярное выражение такие имена не матчит.
- **Не ждите эффекта вместе с `--enable-eplb`**: фильтр будет пропущен.
- **Не ждите эффекта при многопоточной загрузке**: `enable_multithread_load` использует другой итератор, куда список локальных экспертов не передаётся.

## Влияние на производительность и память

- **Время старта.** Основной выигрыш: меньше прочитанных байтов на ранг. Насколько именно — зависит от доли экспертов в чекпоинте и от `ep_size`.
- **Дисковый и сетевой ввод-вывод.** Сокращается пропорционально доле чужих экспертов; это и есть заявленная цель.
- **VRAM.** Не меняется: чужие эксперты и без фильтра не оставались на устройстве, они лишь проходили через host-память.
- **RAM хоста.** Снижается пиковое потребление на этапе загрузки — меньше буферов с ненужными тензорами.
- **Throughput/latency в установившемся режиме.** Не влияет: флаг работает только на загрузке.

## Взаимодействие с другими аргументами

- `--enable-expert-parallel`: обязателен, иначе фильтр не активируется.
- `--enable-eplb`: полностью отменяет фильтр.
- `--expert-placement-strategy`: определяет, какие индексы считаются локальными; фильтр и карта экспертов используют одно и то же значение.
- `--tensor-parallel-size`, `--data-parallel-size`, `--prefill-context-parallel-size`: их произведение — это `ep_size`, от которого зависит доля пропущенных весов.
- `--load-format`, `--model-loader-extra-config`: фильтр живёт в обычном пути safetensors; альтернативные загрузчики его не используют.

## Типовые проблемы и диагностика

- **Симптом:** флаг задан, но в логе нет строки `EP weight filter: ...`, и старт не ускорился. **Причина:** не выполнено одно из условий — модель не MoE, EP не включён, включён EPLB, `ep_size == 1`. **Проверка:** наличие `enable_expert_parallel=True` в стартовом конфиге и отсутствие `enable_eplb=True`.
- **Симптом:** строка `EP weight filter: ep_size=8, ep_rank=3, loading 32/256 experts` есть, а времени загрузки это не изменило. **Причина:** чекпоинт со слитыми трёхмерными тензорами экспертов, либо загрузка идёт через `enable_multithread_load`. **Лечение:** для второго случая — отключить многопоточный загрузчик, если экономия ввода-вывода важнее.
- **Симптом:** после включения фильтра часть весов «не найдена». **Проверка:** имена тензоров в чекпоинте — фильтр опирается на шаблон `.experts.<число>.` и суффиксы `.weight`/`.weight_packed`. Нестандартная схема именования сюда не попадает и не должна фильтроваться.
- **Подтверждение принятого значения:** одна строка `EP weight filter: ep_size=%d, ep_rank=%d, loading %d/%d experts` на ранг, печатается через `info_once` на этапе загрузки.

## Примеры

```bash
vllm serve /models/DeepSeek-V3 --enable-expert-parallel --enable-ep-weight-filter --data-parallel-size 8 --tensor-parallel-size 1
```

```bash
vllm serve /models/Mixtral-8x7B-Instruct --enable-expert-parallel --enable-ep-weight-filter --tensor-parallel-size 4 --gpu-memory-utilization 0.9
```

## Источники

- `vllm/vllm/config/parallel.py`
- `vllm/vllm/model_executor/model_loader/ep_weight_filter.py`
- `vllm/vllm/model_executor/model_loader/default_loader.py`
- `vllm/vllm/model_executor/layers/fused_moe/expert_map_manager.py`
- `vllm/docs/serving/expert_parallel_deployment.md`
