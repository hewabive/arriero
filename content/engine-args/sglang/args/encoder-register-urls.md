---
schema: 1
engine: sglang
primaryName: "--encoder-register-urls"
title: "--encoder-register-urls"
summary: Список `EncoderBootstrapServer`-адресов, в которых энкодер регистрирует сам себя при старте. Задается на сервере с `--encoder-only`; регистрация идет в фоновом потоке с ретраями и снимается через `atexit`.
group: disagg
related:
  - --encoder-only
  - --language-only
  - --encoder-urls
  - --encoder-bootstrap-port
  - --encoder-transfer-backend
  - --host
  - --port
  - --ssl-certfile
  - --dp-size
---

# --encoder-register-urls

## Кратко

Это обратная сторона `--encoder-urls`: вместо того чтобы перечислять энкодеры на языковом сервере, энкодер сам приходит и объявляет о себе. Аргумент задается на процессе с `--encoder-only` и содержит адреса реестров (`EncoderBootstrapServer`), поднятых языковыми серверами на их `--encoder-bootstrap-port`. Регистрация асинхронна: старт энкодера не блокируется недоступным реестром.

## Оригинальная справка

```text
One or more EncoderBootstrapServer URLs to register this encoder with on startup, for dynamic encoder discovery. Example: --encoder-register-urls http://prefill0:8997 http://prefill1:8997. Used with --encoder-only servers.
```

## Паспорт аргумента

- Флаги: `--encoder-register-urls`
- Группа: `disagg`
- Тип значения: список строк; argparse получает `nargs="+"`, значения перечисляются через пробел
- Допустимые значения: `choices` нет; URL реестров, обычно `http://<language-host>:8997`
- Значение по умолчанию: `dataclasses.field(default_factory=list)` — пустой список
- Эффективное значение: совпадает с заданным; движок его не переписывает
- Где объявлен: `ServerArgs.encoder_register_urls`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `disaggregation/encode_server.py:launch_server` (или `_launch_server_dp`) непосредственно перед `uvicorn.run` — то есть уже после загрузки весов, но до приема трафика; снятие регистрации — через `atexit`

## Что меняет в движке

При непустом списке `_register_encoder_url_with_bootstrap` собирает **собственный** адрес энкодера и запускает демон-поток регистрации:

- хост берется из `--host`; если он пуст или равен `0.0.0.0`/`::`, подставляется реальный локальный IP (`get_local_ip_auto`), потому что wildcard-адрес нельзя опубликовать как точку подключения;
- схема — `https`, если задан `--ssl-certfile`, иначе `http`;
- порт — `--port`;
- на каждый адрес из списка идет `POST <bootstrap_url>/register_encoder_url` с телом `{"url": "<свой адрес>"}`, таймаут 5 с.

Ретраи независимы для каждого адреса: до 30 попыток с интервалом 5 с, то есть примерно 2,5 минуты. Успешный адрес выбывает из очереди; исчерпавший попытки дает `Giving up on bootstrap <url> after 30 attempts. Encoder discovery via this bootstrap will be incomplete.` и тоже выбывает. Сервер при этом работает и остается доступным напрямую по `--encoder-urls`, если его туда прописали.

`atexit`-обработчик `_unregister_encoder_url_from_bootstrap` шлет `DELETE /unregister_encoder_url` с тем же телом и таймаутом 2 с. Он срабатывает при штатном завершении процесса; при `SIGKILL` или падении регистрация останется, и адрес выселит health-check реестра.

Регистрация выполняется в обеих ветках запуска энкодера — и в обычной (`launch_server`), и в data-parallel (`_launch_server_dp`).

## Значения и формат

- Несколько значений через пробел: `--encoder-register-urls http://prefill0:8997 http://prefill1:8997`.
- Адрес — корень реестра со схемой; путь `/register_encoder_url` дописывается движком. Завершающий слэш даст двойной слэш.
- Порт в адресе — это `--encoder-bootstrap-port` соответствующего языкового сервера (по умолчанию `8997`), а не его `--port`.
- Пустой список — регистрация не выполняется вообще, ветка полностью пропускается.
- Значение читается только при `--encoder-only`; на языковом сервере оно бессмысленно (там аналог — `--encoder-urls`).

## Когда использовать

- Автомасштабирование пула энкодеров: новые процессы поднимаются и сами подключаются к языковым серверам, без перезапуска последних.
- Несколько языковых серверов (несколько prefill-нод EPD), которые должны видеть один и тот же пул энкодеров: перечислите все их реестры.
- Не используйте, если набор энкодеров фиксирован и известен заранее: `--encoder-urls` на языковой стороне проще и не зависит от порядка запуска.
- Не забывайте про `--host`: при `0.0.0.0` энкодер опубликует свой первый локальный IP, который может оказаться не тем интерфейсом, по которому до него дотянется языковой сервер.

## Влияние на производительность и память

- На VRAM, RAM и пропускную способность не влияет: это разовые HTTP-запросы при старте и один демон-поток, который живет до успеха или исчерпания ретраев.
- На время старта энкодера не влияет: регистрация запускается непосредственно перед `uvicorn.run` и не блокирует его.
- Косвенно влияет на **готовность развертывания**: языковой сервер начинает раскладывать элементы на этот энкодер только после успешной регистрации, то есть первые запросы могут уйти на меньший пул.

## Взаимодействие с другими аргументами

- `--encoder-only`: единственный режим, где список читается.
- `--encoder-bootstrap-port`: определяет порт в адресах, которые вы сюда пишете (на стороне языкового сервера).
- `--encoder-urls`: альтернативный, статический способ наполнить тот же реестр — списки складываются.
- `--host` / `--port`: из них собирается публикуемый адрес; wildcard-хост заменяется на реальный IP.
- `--ssl-certfile`: переключает схему публикуемого адреса на `https`.
- `--dp-size` на энкодере: регистрация работает и в DP-ветке; публикуется один адрес диспетчера, а не адреса воркеров.

## Типовые проблемы и диагностика

- Успех подтверждается строкой `Registered encoder URL '<свой url>' with bootstrap at <bootstrap url>`.
- `Bootstrap <url> returned 400: {"error": "Missing or empty 'url' field"}` — реестр получил пустое тело; практически это значит, что энкодер не смог определить свой адрес.
- `Giving up on bootstrap <url> after 30 attempts. Encoder discovery via this bootstrap will be incomplete.` — реестр так и не поднялся или недоступен; проверьте, что языковой сервер запущен с `--language-only` и что его `--encoder-bootstrap-port` совпадает с портом в адресе.
- Энкодер зарегистрирован, но языковой сервер до него не достучался: скорее всего опубликован неверный интерфейс. Проверьте текущий набор через `GET http://<language-host>:<encoder-bootstrap-port>/list_encoder_urls` и сравните с тем, что видно снаружи.
- После жесткого убийства энкодера его адрес остается в реестре: `atexit` не отработал. Выселение произойдет по health-check (три подряд неудачные пробы), настраиваемому через `SGLANG_ENCODER_BOOTSTRAP_HEALTH_CHECK_INTERVAL`, `..._TIMEOUT` и `..._EVICTED_TTL`.
- Принятое значение — в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path Qwen/Qwen3-VL-8B-Instruct --encoder-only --encoder-register-urls http://prefill0:8997 --host 10.0.0.21 --port 30000
```

```bash
python -m sglang.launch_server --model-path Qwen/Qwen3-VL-8B-Instruct --encoder-only --encoder-transfer-backend zmq_to_scheduler --encoder-register-urls http://prefill0:8997 http://prefill1:8997 --host 10.0.0.22 --port 30000
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/disaggregation/encode_server.py`
- `sglang/python/sglang/srt/disaggregation/encode_receiver.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/environ.py`
- `sglang/docs/docs/advanced_features/epd_disaggregation.mdx`
