---
schema: 1
engine: sglang
primaryName: "--asr-max-buffer-seconds"
title: "--asr-max-buffer-seconds"
summary: Потолок накопленного PCM-аудио в одной realtime-ASR сессии `/v1/realtime`. Защита от OOM, когда клиент шлет звук быстрее, чем модель успевает его распознавать; при превышении сессия закрывается с `buffer_overflow`.
group: serving
related:
  - --asr-max-concurrent-sessions
  - --is-embedding
  - --model-path
  - --enable-multimodal
---

# --asr-max-buffer-seconds

## Кратко

Аргумент относится к отдельному режиму обслуживания — realtime-транскрипции по WebSocket `/v1/realtime`. Обычного HTTP-пути генерации он не касается вообще: ни `/v1/chat/completions`, ни `/generate` про него не знают.

Клиент шлет base64-PCM16 кадрами `input_audio_buffer.append`; сервер копит их в байтовом буфере сессии и порезает на чанки для модели. Если поток входит быстрее, чем модель успевает переваривать, буфер растет неограниченно — этот аргумент задает его потолок в секундах звука.

## Оригинальная справка

```text
Maximum seconds of PCM audio the streaming ASR WebSocket handler will accumulate before closing the session with a buffer_overflow error. Guards against OOM when a client streams audio faster than inference can consume it. Default 60s.
```

## Паспорт аргумента

- Флаги: `--asr-max-buffer-seconds`
- Группа: `serving`
- Тип значения: целое, единица измерения — секунды звука
- Допустимые значения: `choices` нет; строго положительное целое (проверяется на старте)
- Значение по умолчанию: `60`
- Эффективное значение: `__post_init__` не переопределяет, но `_handle_asr_validation` отвергает неположительные значения
- Где объявлен: `ServerArgs.asr_max_buffer_seconds`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: создание `RealtimeConnection` на каждое WebSocket-соединение `/v1/realtime` → проверка при каждом `input_audio_buffer.append`

## Что меняет в движке

В конструкторе `RealtimeConnection` (`sglang/python/sglang/srt/entrypoints/openai/realtime/session.py`) значение переводится в байты:

```python
self.bytes_per_second = self.model_sample_rate * _SAMPLE_WIDTH   # _SAMPLE_WIDTH = 2
self.max_buffer_seconds = server_args.asr_max_buffer_seconds
self.audio = _AudioState(
    max_buffer_bytes=self.max_buffer_seconds * self.bytes_per_second,
    ...
)
```

`model_sample_rate` берется из адаптера транскрипции модели (`sglang/python/sglang/srt/entrypoints/openai/transcription_adapters/base.py`), по умолчанию 16000 Гц. `_SAMPLE_WIDTH = 2` — PCM16, моно. То есть при дефолтах бюджет буфера равен `60 × 16000 × 2 = 1 920 000` байт ≈ 1,83 МиБ на сессию.

Проверка выполняется до ресемплинга, по **целевому** числу сэмплов:

```python
if len(self.audio.pcm_buffer) + target_samples * _SAMPLE_WIDTH > self.audio.max_buffer_bytes:
    # Close 1009 ("message too big") so clients can distinguish
    # session-resource exhaustion from a normal close.
    await self._send_error_and_close(
        "buffer_overflow",
        f"Accumulated audio exceeded {self.max_buffer_seconds}s; "
        f"client is sending faster than inference can keep up",
        close_code=1009,
    )
```

То есть сессия не «подрезается», а **закрывается**: клиенту уходит error-событие с кодом `buffer_overflow` и WebSocket закрывается кодом 1009 (`message too big`), чтобы отличить исчерпание ресурсов от штатного завершения.

Валидация значения — в `ServerArgs._handle_asr_validation`:

```python
if self.asr_max_buffer_seconds <= 0:
    raise ValueError(f"--asr-max-buffer-seconds must be positive (got {self.asr_max_buffer_seconds}).")
```

## Значения и формат

- Целое число секунд звука; `60` по умолчанию.
- `0` и отрицательные отвергаются на старте с явным сообщением.
- Верхней границы нет — но каждая секунда это `sample_rate × 2` байт RAM на сессию, и потолок умножается на `--asr-max-concurrent-sessions`.
- Это не длина распознаваемого фрагмента и не «максимальная длина записи»: буфер расходуется по мере обработки, ограничение бьет только по **отставанию** обработки от приема.
- Единица считается по частоте дискретизации модели, а не клиента: клиентский PCM ресемплится к `model_sample_rate`, и в бюджет попадает уже пересчитанный объем.

## Когда использовать

- Обслуживаете realtime-ASR и хотите ограничить RAM на сессию: `буфер_МиБ ≈ seconds × sample_rate × 2 / 2²⁰`.
- Клиенты грузят длинные файлы «одним махом» вместо реального времени — уменьшите значение, чтобы такие сессии отваливались рано и предсказуемо.
- Наоборот, у вас медленная модель и рваная сеть, а разрывы недопустимы — увеличьте до 120–300, заранее посчитав RAM.
- **Не трогайте** на инстансе, который не обслуживает `/v1/realtime`: аргумент проверяется на старте, но дальше не используется.

## Влияние на производительность и память

- **RAM хоста**: линейно, `секунды × частота × 2` байт на **каждую живую сессию**. При 60 с, 16 кГц и 32 сессиях — до ~58 МиБ. На фоне весов модели немного, но это чистый рост при перегрузке.
- **VRAM и KV-пул**: не затрагиваются.
- **Latency**: значение не ускоряет и не замедляет распознавание; оно только определяет, когда сервер сдастся.
- **CPU**: ресемплинг выполняется в отдельном потоке (`asyncio.to_thread`), размер буфера на его стоимость не влияет.

## Взаимодействие с другими аргументами

- `--asr-max-concurrent-sessions`: множитель для памяти. Реальный потолок RAM под аудио-буферы — произведение двух аргументов на `sample_rate × 2`.
- `--model-path`: определяет архитектуру, а значит адаптер транскрипции и `model_sample_rate` — то есть цену одной секунды в байтах.
- `--enable-multimodal` / `--is-embedding`: задают режим инстанса; на модели без поддержки chunked streaming `/v1/realtime` отвергает соединение с `not_supported` еще до всякого буфера.

## Типовые проблемы и диагностика

- `ValueError: --asr-max-buffer-seconds must be positive (got 0).` — на старте, значение неположительное.
- **Сессии рвутся с `buffer_overflow` и close 1009** — клиент шлет быстрее, чем модель успевает. Варианта два: заставить клиента соблюдать реальное время (или дросселировать), либо поднять значение, приняв рост RAM. Увеличение значения **не** ускоряет распознавание, оно только оттягивает разрыв.
- **Сессия закрывается с `not_supported`** — модель не поддерживает chunked streaming; к этому аргументу отношения не имеет.
- **`invalid_payload` про бинарные кадры** — клиент шлет сырые байты вместо base64 в JSON; `/v1/realtime` принимает только текстовые кадры OpenAI Realtime.
- Логи: `[realtime] rejected (<code>)` для отказов до сессии, `[realtime] client disconnected: <session_id>` — штатное завершение. Принятое значение — в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-ASR-Flash --asr-max-buffer-seconds 120 --port 30000
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-ASR-Flash --asr-max-buffer-seconds 30 --asr-max-concurrent-sessions 8 --port 30000
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/entrypoints/openai/realtime/session.py`
- `sglang/python/sglang/srt/entrypoints/openai/realtime/handler.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_transcription.py`
- `sglang/python/sglang/srt/entrypoints/openai/transcription_adapters/base.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
