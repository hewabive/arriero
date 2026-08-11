---
schema: 1
engine: sglang
primaryName: "--encoder-bootstrap-port"
title: "--encoder-bootstrap-port"
summary: Порт реестра энкодеров (`EncoderBootstrapServer`), который поднимает сервер с `--language-only` в процессе tokenizer manager. Энкодеры регистрируются здесь, получатель отсюда читает актуальный список URL.
group: disagg
related:
  - --language-only
  - --encoder-only
  - --encoder-urls
  - --encoder-register-urls
  - --encoder-transfer-backend
  - --host
  - --port
  - --api-key
  - --disaggregation-bootstrap-port
---

# --encoder-bootstrap-port

## Кратко

Это порт маленького FastAPI-приложения, которое живет в демон-потоке процесса tokenizer manager и служит реестром энкодеров EPD. Поднимается **только** при `--language-only`. Не путайте с `--disaggregation-bootstrap-port`: тот принадлежит PD-ярусу и поднимается на prefill-сервере, этот — энкодерному ярусу и поднимается на языковом. Значение по умолчанию `8997` соседствует с `8998` у PD-реестра именно для того, чтобы их можно было держать рядом.

## Оригинальная справка

```text
Port for the EncoderBootstrapServer that runs in the language-only tokenizer manager process. Encoders register here, and language-only receivers fetch the current URL list from here.
```

## Паспорт аргумента

- Флаги: `--encoder-bootstrap-port`
- Группа: `disagg`
- Тип значения: int
- Допустимые значения: `choices` нет; свободный TCP-порт, отличный от `--port` и от `--disaggregation-bootstrap-port`
- Значение по умолчанию: `8997`
- Эффективное значение: совпадает с заданным — ни один `_handle_*` его не переписывает
- Где объявлен: `ServerArgs.encoder_bootstrap_port`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `TokenizerManager.init_disaggregation` при `--language-only` — запуск `EncoderBootstrapServer(host=--host, port=--encoder-bootstrap-port, urls=<разделяемый список>)` в демон-потоке

## Что меняет в движке

`EncoderBootstrapServer` (`disaggregation/encode_receiver.py`) — FastAPI-приложение на uvicorn с четырьмя маршрутами:

```
GET    /health                  проверка живости самого реестра
POST   /register_encoder_url    тело {"url": "http://enc0:30000"}
DELETE /unregister_encoder_url  тело {"url": "http://enc0:30000"}
GET    /list_encoder_urls       {"encoder_urls": [...]}
```

Список URL он **не хранит отдельно**: ему передается по ссылке тот же массив, который читает приемник мультимодальных данных и который предзаполнен значениями `--encoder-urls`. Регистрация/снятие мутируют его под внутренним замком.

Реестр сам проверяет здоровье зарегистрированных энкодеров: фоновая задача опрашивает их с интервалом `SGLANG_ENCODER_BOOTSTRAP_HEALTH_CHECK_INTERVAL` (по умолчанию 10 c; `0` отключает проверку) с таймаутом `SGLANG_ENCODER_BOOTSTRAP_HEALTH_CHECK_TIMEOUT` (2 c). Адрес выселяется после трех подряд неудачных проб, но продолжает опрашиваться, чтобы вернуться автоматически; окончательно он отбрасывается через `SGLANG_ENCODER_BOOTSTRAP_EVICTED_TTL` (600 c; `0` — опрашивать бесконечно).

Старт подтверждается строкой `EncoderBootstrapServer starting on <host>:<port> ...`; ошибка bind'а — `EncoderBootstrapServer error: ...` с трассировкой, после чего поток завершается (`EncoderBootstrapServer thread stopped`), а сам языковой сервер продолжает работать со статическим списком `--encoder-urls`.

## Значения и формат

- Целое число порта; проверки диапазона и занятости нет.
- Реестр биндится на `--host` языкового сервера. Если это `0.0.0.0`, реестр доступен снаружи — учитывайте это, он не аутентифицируется.
- Значение должно совпадать с портом в `--encoder-register-urls` энкодеров: те стучатся именно по нему.
- При `--language-only` не заданном порт не используется вообще, даже если задан явно.
- Порт не должен совпадать с `--port` этого же сервера и с `--disaggregation-bootstrap-port`, если сервер одновременно работает как PD-prefill.

## Когда использовать

- Порт 8997 занят другим процессом на хосте.
- Несколько языковых серверов на одном хосте: разведите их реестры.
- Динамическая регистрация не нужна вовсе (все энкодеры перечислены в `--encoder-urls`): реестр все равно поднимется, но менять порт незачем — просто закройте его на файрволе.
- Не меняйте порт, не обновив `--encoder-register-urls` на всех энкодерах: они уйдут в 30 ретраев и сдадутся.

## Влияние на производительность и память

На VRAM, RAM и пропускную способность не влияет: реестр обслуживает только регистрации и периодические health-пробы. Единственный расход — фоновая задача опроса, частота которой задается `SGLANG_ENCODER_BOOTSTRAP_HEALTH_CHECK_INTERVAL`. Косвенно влияет на готовность: пока энкодер не зарегистрировался, языковой сервер о нем не знает и раскладывает элементы на меньший пул.

## Взаимодействие с другими аргументами

- `--language-only`: единственный режим, где реестр поднимается.
- `--encoder-register-urls` на энкодерах: там указывают `http://<language-host>:<этот порт>`.
- `--encoder-urls`: предзаполняет тот же список, который реестр мутирует.
- `--host`: интерфейс, на котором слушает реестр.
- `--port`: HTTP-фасад языкового сервера, другой порт.
- `--disaggregation-bootstrap-port`: реестр **другого** яруса (PD); в полном EPD оба могут быть подняты на одном процессе (языковой сервер с `--disaggregation-mode prefill`), и их порты обязаны различаться.
- `--api-key`: не защищает реестр — это отдельный listener без аутентификации.

## Типовые проблемы и диагностика

- Подтверждение старта: `EncoderBootstrapServer starting on <host>:<port> ...`. Отсутствие строки при наличии `EncoderBootstrapServer error: ...` — порт занят или недоступен для bind'а.
- Энкодеры пишут `Giving up on bootstrap <url> after 30 attempts` — порт в их `--encoder-register-urls` не тот или реестр не поднялся.
- Текущий набор адресов проверяется напрямую: `curl http://<language-host>:<encoder-bootstrap-port>/list_encoder_urls`.
- Энкодер зарегистрировался и пропал из списка сам — сработал health-check (три неудачные пробы). Смотрите доступность `GET /health` энкодера с языкового хоста и при необходимости поднимайте `SGLANG_ENCODER_BOOTSTRAP_HEALTH_CHECK_TIMEOUT`.
- **Безопасность.** `POST /register_encoder_url` позволяет любому, кто дотянулся до порта, подсунуть языковому серверу произвольный адрес «энкодера» и получать его мультимодальные данные. Порт обязан быть закрыт от всего, кроме собственных энкодеров.
- Принятое значение — в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path Qwen/Qwen3-VL-8B-Instruct --language-only --encoder-bootstrap-port 8997 --encoder-transfer-backend zmq_to_scheduler --port 30002
```

```bash
python -m sglang.launch_server --model-path Qwen/Qwen3-VL-8B-Instruct --language-only --disaggregation-mode prefill --encoder-bootstrap-port 9997 --disaggregation-bootstrap-port 8998 --port 30002
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/disaggregation/encode_receiver.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/disaggregation/encode_server.py`
- `sglang/python/sglang/srt/environ.py`
- `sglang/docs/docs/advanced_features/epd_disaggregation.mdx`
