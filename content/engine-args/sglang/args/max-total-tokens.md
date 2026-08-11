---
schema: 1
engine: sglang
primaryName: "--max-total-tokens"
title: "--max-total-tokens"
summary: Верхняя граница числа токенов в KV-пуле. Работает только вниз — если профилированная емкость меньше, побеждает она. Инструмент воспроизводимости и отладки, а не способ увеличить пул.
group: schedule
related:
  - --mem-fraction-static
  - --max-running-requests
  - --chunked-prefill-size
  - --page-size
  - --context-length
  - --swa-full-tokens-ratio
  - --hicache-ratio
  - --pp-size
---

# --max-total-tokens

## Кратко

`--max-total-tokens` ставит потолок на `max_total_num_tokens` — число слотов KV-пула. Это **только ограничение сверху**: движок все равно профилирует доступную память и берет минимум. Значение больше профилированного печатает предупреждение и игнорируется. Основное применение — зафиксировать одинаковый размер пула на разных машинах ради воспроизводимых замеров и повторяемых OOM'ов, а также освободить VRAM под что-то другое на той же карте.

## Оригинальная справка

```text
The maximum number of tokens in the memory pool. If not specified, it will be automatically calculated based on the memory usage fraction. This option is typically used for development and debugging purposes.

Supports standard SI suffixes (k, M, G, T) and IEC suffixes
(Ki, Mi, Gi, Ti). Suffixes are case-sensitive.

Decimals are allowed for SI suffixes only.

Examples:
    '1k' -> 1000      '1M' -> 1000000    '25.6k' -> 25600
    '1Ki' -> 1024     '1Mi' -> 1048576
```

## Паспорт аргумента

- Флаги: `--max-total-tokens`
- Группа: `schedule`
- Тип значения: целое (`Optional[int]`), парсится `human_readable_int`
- Допустимые значения: положительное целое, опционально с суффиксом SI (`k`, `M`, `G`, `T`) или IEC (`Ki`, `Mi`, `Gi`, `Ti`); суффиксы регистрозависимы, дробная часть допустима только с SI
- Значение по умолчанию: `null` — потолок не применяется
- Эффективное значение: `min(профилированная емкость, заданное значение)`, затем округление вниз до целого числа страниц (`--page-size`) и, при `--pp-size > 1`, минимум по всем PP-рангам
- Где объявлен: `ServerArgs.max_total_tokens`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный; апстрим сам помечает его как отладочный
- Этап применения: разбор CLI → `_handle_gpu_memory_settings` (ограничение prefill-графа) → `KVCacheConfigurator._apply_token_constraints` при выделении KV-пула

## Что меняет в движке

Значение читается в двух местах.

`_apply_token_constraints` применяет его к результату профилирования:

```python
user_limit = get_schedule().max_total_tokens
if user_limit is not None:
    if user_limit > token_capacity:
        logging.warning(
            f"max_total_tokens={user_limit} is larger than the profiled value "
            f"{token_capacity}. Use the profiled value instead."
        )
    token_capacity = min(token_capacity, user_limit)
```

После этого конфигуратор пересчитывает раскладку пула уже от ограниченного числа токенов (`calculate_pool_sizes_from_max_tokens`), выравнивая по странице. Для hybrid-SWA моделей ограниченное значение становится размером full-пула, а SWA-пул считается от него через `--swa-full-tokens-ratio`. Для DSV4 раскладка по под-пулам пересчитывается целиком.

`_handle_gpu_memory_settings` использует значение раньше, еще до загрузки модели: если `cuda_graph_config.prefill.max_bs` не задан явно, он ограничивается `min(chunked_prefill_size, max_total_tokens)` — то есть маленький `--max-total-tokens` заодно уменьшает захватываемые prefill-графы.

Освободившаяся память не возвращается: SGLang просто не выделяет ее под KV. Она остается свободной на карте — этим `--max-total-tokens` и полезен, когда на GPU должен поместиться второй процесс.

## Значения и формат

- `--max-total-tokens 262144`, `--max-total-tokens 262Ki` и `--max-total-tokens 0.26M` — валидные записи. `--max-total-tokens 1.5Ki` отвергается: дробь с IEC-суффиксом запрещена.
- Ошибка формата — `argparse.ArgumentTypeError: Invalid integer value: '…'` с подсказкой про регистрозависимость суффиксов; сервер не стартует.
- Значение больше профилированного не является ошибкой — только предупреждение в логе. Увеличить пул этим аргументом нельзя, для этого есть `--mem-fraction-static`.
- Значение не обязано быть кратно `--page-size`: округление вниз выполняется движком.
- `0` и отрицательные значения argparse примет, а конфигуратор превратит в пул нулевого размера — старт упадет на проверке `max_total_num_tokens <= 0`.

## Когда использовать

- Фиксировать размер пула для сравнимых замеров на разных картах или между версиями движка.
- Воспроизводить у себя дефицит памяти, о котором сообщили с меньшей карты, не меняя `--mem-fraction-static`.
- Оставить свободную VRAM для соседнего процесса на той же карте, когда точная граница важнее максимальной конкурентности.
- Не использовать как «оптимизацию»: в штатной эксплуатации размер пула регулируется `--mem-fraction-static`, и любое значение выше профилированного здесь бесполезно.
- Не использовать вместо `--max-running-requests`: этот аргумент ограничивает токены, а не запросы, хотя косвенно снижает и потолок запросов (`token_capacity // 2`).

## Влияние на производительность и память

- VRAM: уменьшает выделение KV-пула ровно на разницу «профилированное минус заданное», умноженную на размер ячейки KV. Заодно может уменьшить prefill-графы.
- RAM хоста: напрямую нет; при `--enable-hierarchical-cache` host-пул считается кратно device-пулу, поэтому уменьшение потолка уменьшает и потребление RAM.
- Время старта: не меняет.
- Throughput и latency: те же эффекты, что у уменьшенного `--mem-fraction-static` — меньше одновременных запросов, раньше начинаются ретракты.

## Взаимодействие с другими аргументами

- `--mem-fraction-static`: считает профилированную емкость; `--max-total-tokens` только режет результат.
- `--max-running-requests`: незаданное значение оценивается из `token_capacity`, а заданное ограничивается `token_capacity // 2` — уменьшив пул, вы уменьшаете и потолок конкурентности.
- `--page-size`: итоговое значение выравнивается вниз до целого числа страниц.
- `--swa-full-tokens-ratio`: на hybrid-SWA моделях распределяет ограниченное значение между full- и SWA-пулами; слишком маленький потолок дает `SWA pool (N tokens) cannot hold even one request`.
- `--chunked-prefill-size`: вместе определяют `cuda_graph_config.prefill.max_bs` при автоподборе.
- `--pp-size`: значения синхронизируются по минимуму между PP-рангами.
- `--hicache-ratio`: host-пул HiCache считается от размера device-пула, то есть от этого потолка.

## Типовые проблемы и диагностика

- `max_total_tokens=N is larger than the profiled value M. Use the profiled value instead.` — заданное значение недостижимо; либо примите M, либо поднимайте `--mem-fraction-static`.
- Пул оказался меньше заданного значения без предупреждения — сработало выравнивание по странице или PP-минимум. Смотрите фактическое `#tokens` в строке `KV Cache is allocated. dtype: …, #tokens: N, …`.
- Неожиданно низкий `max_running_requests` после установки потолка — следствие `token_capacity // 2`.
- `SWA pool (…) cannot hold even one request` на hybrid-SWA — потолок слишком мал для окна внимания; поднимите значение или `--swa-full-tokens-ratio`.
- Значение, как его принял движок, — в дампе `server_args=`; итоговый размер пула — в сводке `max_total_num_tokens=…` при готовности scheduler'а.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --max-total-tokens 262144
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --max-total-tokens 128Ki --mem-fraction-static 0.85 --page-size 64
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/utils/common.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_configurator.py`
- `sglang/python/sglang/srt/model_executor/pool_configurator.py`
- `sglang/python/sglang/srt/mem_cache/memory_pool.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
