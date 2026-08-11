---
schema: 1
engine: sglang
primaryName: "--checkpoint-engine-wait-weights-before-ready"
title: "--checkpoint-engine-wait-weights-before-ready"
summary: Держит сервер незапрогретым, пока веса не приедут через `/update_weights_from_ipc`. Узкая интеграция с checkpoint-engine; ожидание ограничено 120 секундами и по истечении не отменяет старт.
group: model
related:
  - --custom-weight-loader
  - --load-format
  - --skip-server-warmup
  - --model-path
---

# --checkpoint-engine-wait-weights-before-ready

## Кратко

Флаг предназначен для сценария, где веса приходят не с диска, а от внешнего checkpoint-engine по IPC. Он вставляет ожидание перед прогревом сервера: `initial_weights_loaded` изначально ставится в `False`, и `_wait_and_warmup` крутится, пока успешный `/update_weights_from_ipc` не переведет флаг в `True`. Это не «отложенный старт» общего назначения: без внешнего компонента, который зальет веса, ожидание просто истечет по таймауту.

## Оригинальная справка

```text
If set, the server will wait for initial weights to be loaded via checkpoint-engine or other update methods before serving inference requests.
```

## Паспорт аргумента

- Флаги: `--checkpoint-engine-wait-weights-before-ready`
- Группа: `model`
- Тип значения: bool (флаг без значения)
- Допустимые значения: присутствует / отсутствует
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется
- Где объявлен: `ServerArgs.checkpoint_engine_wait_weights_before_ready`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, узкая интеграция с внешним инструментом
- Этап применения: инициализация tokenizer manager (сброс `initial_weights_loaded`) и `_wait_and_warmup` в HTTP-слое перед прогревом

## Что меняет в движке

Две точки, обе очевидные по коду.

`managers/tokenizer_manager.py`:

```python
self.initial_weights_loaded = True
if self.server_args.checkpoint_engine_wait_weights_before_ready:
    self.initial_weights_loaded = False
```

`entrypoints/http_server.py`:

```python
def _wait_and_warmup(server_args, launch_callback=None, execute_warmup_func=_execute_server_warmup):
    if server_args.checkpoint_engine_wait_weights_before_ready:
        _wait_weights_ready()
    ...
```

`_wait_weights_ready` опрашивает флаг раз в секунду `WAIT_WEIGHTS_READY_TIMEOUT` раз (переменная окружения `SGLANG_WAIT_WEIGHTS_READY_TIMEOUT`, по умолчанию **120**). Успех логируется как «Weights are ready after N.NN seconds». По истечении таймаута печатается `logger.error("Weights are not ready after waiting 120 seconds. Consider increasing SGLANG_WAIT_WEIGHTS_READY_TIMEOUT environment variable. Current status: initial_weights_loaded=False")` — и **выполнение продолжается**: прогрев запускается, сервер объявляет себя готовым. То есть таймаут не приводит к отказу старта, а приводит к серверу со стартовыми весами.

Снимает ожидание единственный обработчик — `POST /update_weights_from_ipc`: при успешном ответе он переводит `initial_weights_loaded` в `True`.

## Значения и формат

- Флаг без значения; парной формы нет.
- «Готовность» определяется одним булевым признаком процесса — сервер не проверяет, что именно залито и в каком объеме.
- Таймаут задается только переменной окружения, отдельного аргумента для него нет.
- Пока идет ожидание, HTTP-сервер уже слушает порт (иначе `/update_weights_from_ipc` было бы некому принять), но не прошел прогрев.

## Когда использовать

- Только в связке с checkpoint-engine или другим внешним поставщиком весов через IPC — например в RL-контуре, где инференс-сервер поднимается раньше, чем появляется актуальный чекпоинт.
- Не используйте как «подождать, пока подтянется NFS»: механизм ждет не файлы, а вызов API.
- Не используйте для отложенного открытия трафика: правильный инструмент для этого — внешняя проверка готовности перед добавлением инстанса в балансировщик.

## Влияние на производительность и память

- Продлевает старт ровно на время ожидания (до 120 с по умолчанию). VRAM к этому моменту уже занята: модель создана и стартовые веса загружены.
- Обновление весов через IPC само по себе требует дополнительной памяти на время переноса — эта стоимость на стороне внешнего компонента и `WeightUpdater`, а не флага.
- На throughput после готовности не влияет.

## Взаимодействие с другими аргументами

- `--custom-weight-loader`: разрешает нестандартные функции загрузки в API обновления весов; частый спутник этого флага.
- `--load-format`: стартовые веса всё равно грузятся обычным путем — флаг не отменяет первичную загрузку. Если стартовые веса не нужны, применим `--load-format dummy`.
- `--skip-server-warmup`: ожидание стоит **до** блока прогрева и выполняется независимо от него.
- `--model-path`: архитектура должна совпадать с той, чьи веса зальет внешний компонент.

## Типовые проблемы и диагностика

- В логе `Weights are not ready after waiting 120 seconds …` — внешний компонент не пришел. Сервер при этом уже принимает запросы и отвечает стартовыми весами: это худший вид тихой ошибки, поэтому не полагайтесь на флаг как на гейт.
- Ожидание длится дольше ожидаемого — увеличьте `SGLANG_WAIT_WEIGHTS_READY_TIMEOUT`; секунды тратятся ровно по одной на итерацию опроса.
- Готовность подтверждает строка «Weights are ready after N.NN seconds», а следом обычная «The server is fired up and ready to roll!».
- Значение флага, как его принял движок, — в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --checkpoint-engine-wait-weights-before-ready --port 30000
```

```bash
SGLANG_WAIT_WEIGHTS_READY_TIMEOUT=600 python -m sglang.launch_server --model-path /models/Qwen3-8B --load-format dummy --checkpoint-engine-wait-weights-before-ready --custom-weight-loader my_package.weight_load_func
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/model_executor/model_runner_components/weight_updater.py`
