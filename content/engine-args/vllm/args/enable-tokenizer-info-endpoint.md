---
schema: 1
engine: vllm
primaryName: "--enable-tokenizer-info-endpoint"
title: "--enable-tokenizer-info-endpoint"
summary: Регистрирует `GET /tokenizer_info`, который отдает конфигурацию токенизатора и полный текст chat-шаблона. Полезно при отладке промптов и нежелательно на публичном сервере.
group: Frontend
related:
  - --chat-template
  - --trust-request-chat-template
  - --api-key
  - --disable-fastapi-docs
---

# --enable-tokenizer-info-endpoint

## Кратко

Эндпоинт отдает `tokenizer.init_kwargs` (спецтокены, флаги нормализации, `tokenizer_class`) и, если сервер запущен с `--chat-template`, текст шаблона целиком.

Это самый прямой способ ответить на вопрос «каким шаблоном сервер реально рендерит промпт» — и одновременно способ отдать этот шаблон любому, кто может обратиться к API.

## Оригинальная справка

```text
Enable the `/tokenizer_info` endpoint. May expose chat
templates and other tokenizer configuration.
```

## Паспорт аргумента

- Флаги: `--enable-tokenizer-info-endpoint`, `--no-enable-tokenizer-info-endpoint`
- Группа argparse: `Frontend`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг присутствует (`true`), парный `--no-...` или отсутствие обоих (`false`)
- Значение по умолчанию: `false`
- Эффективное значение: не переопределяется
- Где объявлен: `vllm/entrypoints/openai/cli_args.py:BaseFrontendArgs.enable_tokenizer_info_endpoint`
- Этап применения: построение FastAPI-приложения (`attach_router`), до старта прослушивания порта

## Что меняет в движке

`attach_router` (`vllm/entrypoints/serve/tokenize/api_router.py`) объявляет маршрут внутри `if getattr(app.state.args, "enable_tokenizer_info_endpoint", False)`. При выключенном флаге маршрута в приложении нет вообще, и запрос получает 404 от FastAPI.

Обработчик вызывает `ServingTokenization.get_tokenizer_info()` → `TokenizerInfo(tokenizer, self.chat_template).to_dict()` (`vllm/entrypoints/serve/tokenize/serving.py`). Формирование ответа:

1. берется `tokenizer.init_kwargs`;
2. удаляются ключи `vocab_file` и `merges_file` — единственная санитизация, и она про пути к файлам словаря, а не про содержимое;
3. значения приводятся к JSON-сериализуемому виду;
4. добавляется `tokenizer_class` — имя класса токенизатора;
5. если `chat_template` непуст — добавляется ключ `chat_template` с полным текстом шаблона.

`chat_template` здесь — это разрешенное на старте значение `--chat-template`. Если аргумент не задавался, ключа в ответе не будет, даже когда шаблон приезжает из `tokenizer_config.json`.

## Значения и формат

- Включение: `--enable-tokenizer-info-endpoint`. Выключение: `--no-enable-tokenizer-info-endpoint`.
- «Не задан» = `false`.
- Эндпоинт — `GET /tokenizer_info`, без параметров, ответ — плоский JSON-объект.
- Выбрать, что именно раскрывать (только спецтокены, без шаблона), нельзя: гранулярности у флага нет.

## Когда использовать

- Отладка промптов на закрытом стенде: сравнить шаблон сервера с ожидаемым быстрее, чем читать логи.
- Инвентаризация: клиент хочет знать `bos_token`/`eos_token`/`tokenizer_class`, чтобы правильно собрать запрос с `prompt_token_ids`.
- Не включайте на сервере, доступном не только с localhost: даже без секретов в шаблоне вы отдаете системную разметку промпта и подсказываете, как ее обойти. Особенно вредно в паре с `--trust-request-chat-template` — клиент получает эталон и присылает его модификацию.
- Не рассчитывайте увидеть здесь шаблон модели: без `--chat-template` ключа `chat_template` в ответе не будет.

## Влияние на производительность и память

Не влияет: маршрут регистрируется один раз при построении приложения, обработчик читает уже загруженные атрибуты токенизатора. На VRAM, KV-cache, время старта и throughput эффекта нет.

## Взаимодействие с другими аргументами

- `--chat-template`: определяет, попадет ли шаблон в ответ и какой именно.
- `--trust-request-chat-template`: вместе эти два флага дают клиенту и эталон шаблона, и право его подменить.
- `--api-key`: минимальная преграда, если эндпоинт всё же нужен снаружи.
- `--disable-fastapi-docs`: соседний рычаг сокращения раскрываемой наружу информации о сервере.

## Типовые проблемы и диагностика

- **Симптом:** `GET /tokenizer_info` отвечает 404. **Причина:** флаг не задан, маршрут не зарегистрирован. **Лечение:** включить флаг и перезапустить инстанс.
- **Симптом:** в ответе нет `chat_template`. **Причина:** сервер запущен без `--chat-template`, шаблон приходит из токенизатора. **Лечение:** задать `--chat-template`, если нужно видеть его через API.
- **Симптом:** ответ выглядит скудно (только `tokenizer_class`). **Причина:** у токенизатора пустой `init_kwargs` — обычно у нестандартных реализаций. **Лечение:** смотреть конфигурацию токенизатора в каталоге модели.
- **Симптом (безопасность):** внешний клиент воспроизводит системный промпт. **Причина:** шаблон раскрыт через этот эндпоинт. **Лечение:** выключить флаг, ограничить доступ на уровне сети.
- **Подтверждение принятого значения:** `curl http://127.0.0.1:8000/tokenizer_info` возвращает 200 вместо 404; маршрут также перечислен в строках `Route: ...` при старте.

## Примеры

```bash
vllm serve /models/Qwen3-4B --enable-tokenizer-info-endpoint --host 127.0.0.1
```

```bash
vllm serve /models/Qwen3-4B --enable-tokenizer-info-endpoint --chat-template /etc/vllm/qwen3-tools.jinja
```

## Источники

- `vllm/vllm/entrypoints/openai/cli_args.py`
- `vllm/vllm/entrypoints/serve/tokenize/api_router.py`
- `vllm/vllm/entrypoints/serve/tokenize/serving.py`
- `vllm/vllm/entrypoints/openai/api_server.py`
- `vllm/docs/usage/security.md`
