---
schema: 1
engine: vllm
primaryName: "--safetensors-prefetch-block-size"
title: "--safetensors-prefetch-block-size"
summary: Размер блока чтения при прогреве safetensors в page cache. Действует только когда prefetch активен (явно или автоматически на NFS/Lustre); по умолчанию 16 MiB.
group: LoadConfig
related:
  - --safetensors-load-strategy
  - --safetensors-prefetch-num-threads
  - --load-format
  - --download-dir
  - --model-loader-extra-config
---

# --safetensors-prefetch-block-size

## Кратко

Prefetch устроен предельно просто: фоновый поток открывает файл чекпоинта и читает его блоками до конца, чтобы страницы осели в page cache ядра до того, как основной путь дойдет до них через mmap. `--safetensors-prefetch-block-size` — размер этого блока в байтах.

На локальной ФС значение почти не важно. На сетевой оно определяет размер сетевого запроса: слишком мелкие блоки не насыщают канал, слишком крупные увеличивают задержку до первой полезной страницы.

## Оригинальная справка

```text
Read size in bytes for each safetensors checkpoint file prefetch.
```

## Паспорт аргумента

- Флаги: `--safetensors-prefetch-block-size`
- Группа argparse: `LoadConfig`
- Тип значения: int (байты); парсер принимает человекочитаемые суффиксы (`16M` = 16 777 216, `16m` = 16 000 000, `1G`, `1g`)
- Допустимые значения: `>= 1` (валидация `Field(default=..., ge=1)`), плюс повторная проверка `>= 1` в `_prefetch_checkpoint`
- Значение по умолчанию: `Field(default=DEFAULT_SAFETENSORS_PREFETCH_BLOCK_SIZE, ge=1)`, где константа равна `16 * 1024 * 1024`, то есть 16 MiB
- Эффективное значение: не переопределяется движком
- Где объявлен: `vllm/config/load.py:LoadConfig.safetensors_prefetch_block_size`
- Этап применения: чтение весов, только при активном prefetch

## Что меняет в движке

Значение доходит до `_prefetch_checkpoint` (`vllm/model_executor/model_loader/weight_utils.py`):

```
with open(file_path, "rb") as f:
    while f.read(block_size):
        pass
```

Прочитанные данные никуда не сохраняются — весь смысл в побочном эффекте: страницы файла попадают в page cache ядра. Основной путь чтения весов затем работает обычным mmap и получает уже прогретые страницы.

Вызов происходит только из `_prefetch_all_checkpoints`, а тот — только когда `should_prefetch` истинно: либо `--safetensors-load-strategy prefetch`, либо автоматическое включение при сетевой ФС и достаточной RAM. При `lazy`, `eager`, `torchao` и при отсутствии условий авто-включения аргумент не читается.

Факт запуска фиксируется строкой:

```text
Prefetching checkpoint files into page cache started (in background, num_threads=N, block_size=M bytes)
```

## Значения и формат

- Целое число байт, минимум 1. Суффиксы: прописные — двоичные (`16M` = 16 MiB), строчные — десятичные (`16m` = 16 000 000). Дробные значения с двоичным суффиксом запрещены.
- Значение по умолчанию (16 MiB) — разумная отправная точка для NFS с типичным `rsize`.
- Очень маленькие значения (килобайты) превращают прогрев в поток мелких сетевых операций и делают prefetch медленнее ленивого чтения.
- Очень крупные значения (сотни мегабайт) увеличивают гранулярность: поток дольше не отдает управление, а выигрыш по пропускной способности выходит на плато.
- Специальных значений (`0`, `-1`, `auto`) нет.

## Когда использовать

- Веса на NFS/Lustre, prefetch включен, и замеры показывают, что прогрев не насыщает канал: увеличьте блок до 32–64 MiB и сравните время фазы `Loading weights`.
- Хранилище с крупным оптимальным размером чтения (объектный шлюз, RAID с большим stripe): согласуйте блок с ним.
- Не трогайте на локальном NVMe: там prefetch, скорее всего, вообще не включится, а если включен явно — размер блока перестает быть узким местом.
- Не используйте как способ ограничить память: блок — это буфер одного чтения, а рост потребления дает не он, а сам page cache размером в чекпоинт.

## Влияние на производительность и память

- **Время старта.** Единственная область влияния — длительность фазы прогрева, и то только на медленном или сетевом хранилище.
- **RAM хоста.** Сам блок занимает `block_size` на поток (при 8 потоках и 16 MiB — 128 MiB буферов). Основное потребление дает page cache объемом в чекпоинт, и оно от этого аргумента не зависит.
- **Сеть/диск.** Определяет размер отдельной операции чтения; на этом и строится тюнинг.
- **VRAM.** Не влияет.
- **Throughput после старта.** Не влияет.

## Взаимодействие с другими аргументами

- `--safetensors-load-strategy`: единственный включатель. Без активного prefetch аргумент мертв.
- `--safetensors-prefetch-num-threads`: суммарная нагрузка на хранилище — это `num_threads × block_size` одновременно читаемых данных; тюнить их надо вместе.
- `--load-format`: prefetch живет в обычном safetensors-итераторе `DefaultModelLoader`; для `fastsafetensors`, `instanttensor`, `runai_streamer`, `tensorizer`, `sharded_state` он не применяется.
- `--download-dir`: определяет, на какой ФС лежит чекпоинт, а значит и осмысленный размер блока.
- `--model-loader-extra-config`: `enable_multithread_load` несовместим с явным `prefetch`, поэтому и с настройкой блока.

## Типовые проблемы и диагностика

- **Симптом:** значение задано, ничего не изменилось. **Причина:** prefetch не активен. **Проверка:** строка `Prefetching checkpoint files into page cache started (in background, num_threads=N, block_size=M bytes)` — если ее нет, аргумент не применялся. **Лечение:** задать `--safetensors-load-strategy prefetch`.
- **Симптом:** прогрев не успевает за загрузкой (в логе `Prefetching checkpoint files: 10% (x/y)` идет заметно медленнее, чем прогресс-бар чтения). **Лечение:** увеличить блок и/или число потоков.
- **Симптом:** `safetensors prefetch block size must be >= 1` **Причина:** нулевое или отрицательное значение проскочило мимо валидации поля (например, при программной сборке конфигурации). **Лечение:** задать положительное число.
- **Симптом:** ошибка вида `Failed to prefetch checkpoint file '<путь>'` в предупреждении. **Причина:** файл недоступен или чтение прервано; prefetch продолжает работу с остальными файлами и загрузку не ломает. **Лечение:** проверить доступность хранилища.
- **Подтверждение принятого значения:** число `block_size=M bytes` в стартовой строке prefetch и итоговая `Prefetching checkpoint files into page cache finished in X.XXs`.

## Примеры

```bash
vllm serve /mnt/nfs/models/Qwen3-32B --safetensors-load-strategy prefetch --safetensors-prefetch-block-size 32M
```

```bash
vllm serve /mnt/nfs/models/Qwen3-32B --safetensors-load-strategy prefetch --safetensors-prefetch-block-size 67108864 --safetensors-prefetch-num-threads 4
```

## Источники

- `vllm/vllm/config/load.py`
- `vllm/vllm/model_executor/model_loader/weight_utils.py`
- `vllm/vllm/model_executor/model_loader/default_loader.py`
- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/utils/argparse_utils.py`
