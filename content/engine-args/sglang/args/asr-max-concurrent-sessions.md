---
schema: 1
engine: sglang
primaryName: "--asr-max-concurrent-sessions"
title: "--asr-max-concurrent-sessions"
summary: Потолок одновременных realtime-ASR сессий на WebSocket `/v1/realtime`. Соединение сверх лимита принимается, получает событие `too_many_sessions` и закрывается — очереди нет.
group: serving
related:
  - --asr-max-buffer-seconds
  - --max-running-requests
  - --model-path
  - --tokenizer-worker-num
---

# --asr-max-concurrent-sessions

## Кратко

Отдельный лимит для отдельного режима обслуживания: realtime-транскрипции по WebSocket. К HTTP-конкурентности (`--max-running-requests`) отношения не имеет и с ней не связан — это два независимых счетчика, ограничивающих разные вещи.

Поведение при переполнении жестко: не ожидание в очереди, а немедленный отказ с явным кодом. Клиент обязан ретраить сам.

## Оригинальная справка

```text
Maximum number of concurrent realtime ASR WebSocket sessions served by /v1/realtime. New connections beyond this cap are accepted, sent an error{code:too_many_sessions} frame, and closed. Default 32.
```

## Паспорт аргумента

- Флаги: `--asr-max-concurrent-sessions`
- Группа: `serving`
- Тип значения: целое, единица измерения — одновременные WebSocket-сессии
- Допустимые значения: `choices` нет; строго положительное целое (проверяется на старте)
- Значение по умолчанию: `32`
- Эффективное значение: `__post_init__` не переопределяет, но `_handle_asr_validation` отвергает неположительные значения
- Где объявлен: `ServerArgs.asr_max_concurrent_sessions`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: конструктор `OpenAIServingTranscription` при старте (создание семафора) → каждое новое соединение `/v1/realtime`

## Что меняет в движке

Семафор создается один раз на обработчик транскрипции (`sglang/python/sglang/srt/entrypoints/openai/serving_transcription.py`):

```python
self._session_semaphore = asyncio.Semaphore(
    tokenizer_manager.server_args.asr_max_concurrent_sessions
)
```

Проверка — в `handle_realtime_transcription` (`sglang/python/sglang/srt/entrypoints/openai/realtime/handler.py`), **до** захвата слота:

```python
if session_semaphore.locked():
    await _reject_before_session(
        websocket, "too_many_sessions",
        f"Maximum concurrent sessions reached ({server_args.asr_max_concurrent_sessions}).",
        error_type="rate_limit_exceeded",
    )
    return
async with session_semaphore:
    ...
```

Три детали, которые видны только из кода:

1. Отказное соединение **сначала принимается** (`websocket.accept()` внутри `_reject_before_session`), затем получает JSON-событие `error` с `type: "rate_limit_exceeded"`, `code: "too_many_sessions"`, и только потом закрывается. Для клиента это не отказ рукопожатия, а короткая успешная сессия с ошибкой.
2. Проверка `supports_chunked_streaming` идет **раньше** проверки лимита, тоже без захвата слота: модель без поддержки chunked streaming отвечает `not_supported` и никогда не занимает сессию.
3. `async with` гарантирует освобождение слота даже при исключении внутри `RealtimeConnection` — «залипших» сессий из-за ошибок не остается.

Очереди нет: `locked()` истинно ровно тогда, когда счетчик семафора равен нулю, и в этом случае клиент сразу отвергается.

Валидация значения — в `ServerArgs._handle_asr_validation`:

```python
if self.asr_max_concurrent_sessions <= 0:
    raise ValueError(f"--asr-max-concurrent-sessions must be positive (got {self.asr_max_concurrent_sessions}).")
```

## Значения и формат

- Целое число сессий; `32` по умолчанию.
- `0` и отрицательные отвергаются на старте с явным сообщением.
- Верхней границы нет, но каждая сессия держит аудио-буфер до `--asr-max-buffer-seconds` секунд PCM и порождает запросы к модели.
- Значения «без лимита» нет.
- Семафор привязывается к event loop при первом захвате — то есть к циклу uvicorn при обычном запуске сервера; на конфигурацию это не влияет, но объясняет, почему лимит существует ровно в одном процессе-обработчике.

## Когда использовать

- Realtime-ASR открыт наружу и надо жестко ограничить число параллельных потоков — это единственный такой рычаг.
- Расчет RAM: `сессии × asr_max_buffer_seconds × sample_rate × 2` байт. При дефолтах (32 × 60 × 16000 × 2) это до ~58 МиБ только под аудио-буферы.
- Мало GPU-ёмкости: каждая сессия периодически отправляет чанк в модель, так что 32 сессии — это до 32 конкурирующих запросов сверх обычного трафика. На маленьком инстансе значение стоит снизить.
- **Не трогайте**, если `/v1/realtime` не используется.
- **Не используйте** как общий ограничитель конкурентности — HTTP-путь он не ограничивает никак.

## Влияние на производительность и память

- **RAM хоста**: линейно по числу сессий, множитель — `--asr-max-buffer-seconds`.
- **GPU**: косвенно, через число одновременных ASR-запросов к модели. Планировщик обрабатывает их наравне с остальными.
- **VRAM/KV-пул**: напрямую не резервируется; расход определяется фактическими запросами.
- Время старта и скорость forward не меняются.

## Взаимодействие с другими аргументами

- `--asr-max-buffer-seconds`: второй множитель в формуле памяти; вместе они и задают потолок RAM под аудио.
- `--max-running-requests`: ограничивает батч планировщика, а не число WebSocket-сессий. Сессия, не попавшая в батч, просто ждет — отказа не будет.
- `--model-path`: определяет адаптер транскрипции; модель без chunked streaming отвергает соединения раньше проверки лимита.
- `--tokenizer-worker-num`: семафор живет в обработчике транскрипции; при нескольких токенизатор-воркерах учитывайте, что лимит считается в пределах процесса, обслуживающего соединение.

## Типовые проблемы и диагностика

- `ValueError: --asr-max-concurrent-sessions must be positive (got 0).` — на старте.
- **Клиент получает `error` с `code: "too_many_sessions"` и соединение закрывается** — лимит исчерпан. Ретрай с экспоненциальной задержкой на стороне клиента обязателен: сервер не ставит в очередь.
- **Отказ приходит как `not_supported`, а не `too_many_sessions`** — дело не в лимите: модель не поддерживает chunked streaming.
- **Лимит «не работает», сессий больше заявленного** — считайте сессии в пределах одного процесса-обработчика; при нескольких токенизатор-воркерах каждый держит свой семафор.
- В логе отказы видны как `[realtime] rejected (too_many_sessions)`; штатные завершения — `[realtime] client disconnected (normal)`. Принятое значение — в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-ASR-Flash --asr-max-concurrent-sessions 8 --port 30000
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-ASR-Flash --asr-max-concurrent-sessions 64 --asr-max-buffer-seconds 30 --port 30000
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_transcription.py`
- `sglang/python/sglang/srt/entrypoints/openai/realtime/handler.py`
- `sglang/python/sglang/srt/entrypoints/openai/realtime/session.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
