---
schema: 1
engine: sglang
primaryName: "--elastic-ep-scale-timeout"
title: "--elastic-ep-scale-timeout"
summary: Сколько секунд первичная развертка ждет присоединяющуюся группу после запроса на расширение EP. По истечении срока расширение помечается неудавшимся, и сервер продолжает работать в прежнем размере.
group: exec.moe
related:
  - --elastic-ep-backend
  - --elastic-ep-join-mode
  - --max-ep-size
  - --elastic-ep-initial-size
  - --elastic-ep-join-rank-offset
---

# --elastic-ep-scale-timeout

## Кратко

Аргумент относится только к рантайм-расширению elastic EP: между `POST /scale_elastic_ep` и моментом, когда новая группа реально вошла в WORLD, состояние висит в фазе ожидания. Таймаут ограничивает это ожидание. Единица — секунды, отсчет ведется по монотонным часам с момента постановки запроса в очередь.

## Оригинальная справка

```text
Timeout in seconds for a pending elastic EP scale operation.
```

## Паспорт аргумента

- Флаги: `--elastic-ep-scale-timeout`
- Группа: `exec.moe`
- Тип значения: float (секунды)
- Допустимые значения: строго положительное число; проверяется ассертом, но только когда рантайм-расширение действительно активно
- Значение по умолчанию: `600` (десять минут)
- Эффективное значение: не переопределяется
- Где объявлен: `ServerArgs.elastic_ep_scale_timeout`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, часть молодой подсистемы elastic EP
- Этап применения: `__post_init__` (проверка положительности) → конец каждого forward-прохода в `maybe_join_ep_ranks`

## Что меняет в движке

Проверка живет в `ModelRunner.maybe_join_ep_ranks` (`sglang/python/sglang/srt/model_executor/model_runner.py`) и выполняется на каждом forward-проходе, пока есть незавершенный запрос на расширение:

1. Локально считается `time.monotonic() - state.pending_since > elastic_ep_scale_timeout`.
2. Результат сводится по всей WORLD через `all_reduce` с операцией `MAX`, то есть достаточно одного ранга, у которого срок истек.
3. При срабатывании состояние переводится в `failed` с сообщением `Timed out waiting for ranks to join target EP size <N>`, генератор EPLB сбрасывается, ошибка публикуется наружу, а ранг 0 первичной группы пишет ее в лог с префиксом `[Elastic EP]`.

Важно, что таймаут — не откат: уже принятые ранги не выкидываются, просто расширение считается несостоявшимся, и сервер продолжает обслуживать трафик в прежнем эффективном размере. Новый запрос на расширение после этого возможен.

Отсчет привязан к `pending_since`, а не к моменту старта присоединяющегося процесса, поэтому долгая загрузка весов на новой группе полностью укладывается в этот бюджет.

## Значения и формат

- Число с плавающей точкой, секунды. `600` по умолчанию рассчитано на то, что присоединяющаяся группа успеет поднять процессы и прочитать веса модели с диска.
- `0` и отрицательные значения отвергаются ассертом `--elastic-ep-scale-timeout must be greater than zero.` — но только если расширение активно (задан `--elastic-ep-backend` и `--max-ep-size` больше локального `--tp-size`). В конфигурации без расширения некорректное значение пройдет молча и ни на что не повлияет.
- Верхней границы нет; очень большое значение означает, что зависшее расширение будет висеть до ручного вмешательства.

## Когда использовать

- Модель большая, а веса читаются с сетевого хранилища: замерьте время холодного старта присоединяющейся группы и поставьте таймаут с запасом — иначе расширение будет срываться каждый раз.
- Автоматизированное масштабирование, где висящая фаза расширения блокирует следующие запросы: наоборот, уменьшите таймаут, чтобы система быстрее возвращалась в определенное состояние.
- Не трогайте в конфигурации без `--max-ep-size`: значение не читается.

## Влияние на производительность и память

- Сама проверка стоит одного `all_reduce` небольшого тензора на forward-проход, и только пока висит незавершенное расширение. В установившемся режиме накладных расходов нет.
- На VRAM и RAM аргумент не влияет.
- Косвенно влияет на доступность: пока фаза расширения не завершилась и не провалилась, повторный запрос на расширение отклоняется с кодом 409.

## Взаимодействие с другими аргументами

- `--elastic-ep-backend`: без него аргумент не читается; для расширения должен быть `mooncake`.
- `--max-ep-size`: расширение считается активным только когда он задан и больше локального `--tp-size`; ассерт на положительность таймаута проверяется в этом же блоке.
- `--elastic-ep-join-mode scale`: роль процесса, который должен успеть присоединиться в срок.
- `--elastic-ep-join-rank-offset`, `--elastic-ep-initial-size`: геометрия присоединяющейся когорты; их несоответствие приводит к отказу раньше таймаута, с другим сообщением.

## Типовые проблемы и диагностика

- `[Elastic EP] Timed out waiting for ranks to join target EP size N` — присоединяющаяся группа не поднялась в срок. Проверьте ее собственный лог: чаще всего это долгая загрузка весов или ошибка на старте.
- Расширение проваливается заметно раньше таймаута с сообщением про когорту — это не таймаут, а несовпадение геометрии.
- `409` на повторном `POST /scale_elastic_ep` — предыдущее расширение еще в фазе ожидания; дождитесь таймаута или успеха, состояние видно через `GET /is_scaling_elastic_ep`.
- `AssertionError: --elastic-ep-scale-timeout must be greater than zero.` — некорректное значение при активном расширении.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --dp-size 8 --ep-size 8 --pp-size 1 --enable-dp-attention --enable-dp-lm-head --moe-a2a-backend nixl --elastic-ep-backend mooncake --max-ep-size 16 --elastic-ep-scale-timeout 1800 --load-balance-method round_robin --tokenizer-worker-num 1 --disable-cuda-graph
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --dp-size 8 --ep-size 8 --pp-size 1 --enable-dp-attention --enable-dp-lm-head --moe-a2a-backend nixl --elastic-ep-backend mooncake --max-ep-size 16 --elastic-ep-scale-timeout 120 --load-balance-method round_robin --tokenizer-worker-num 1 --disable-cuda-graph
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_executor/model_runner.py`
- `sglang/python/sglang/srt/elastic_ep/elastic_ep.py`
- `sglang/python/sglang/srt/entrypoints/elastic_ep.py`
