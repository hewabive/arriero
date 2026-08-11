---
schema: 1
engine: sglang
primaryName: "--incremental-streaming-output"
title: "--incremental-streaming-output"
summary: Переводит нативный `/generate` со стриминга накопленного текста на стриминг дельт. Формат SSE у OpenAI-эндпоинтов при этом не меняется — там фасад сам приводит вывод к дельтам в обоих режимах; выигрыш в том, что исчезает O(n²) склейка строк.
group: serving
related:
  - --stream-output
  - --stream-interval
  - --batch-notify-size
  - --stream-response-default-include-usage
  - --enable-return-hidden-states
---

# --incremental-streaming-output

## Кратко

Флаг меняет внутренний контракт стриминга: с накопительного («в каждом чанке весь текст с начала») на инкрементальный («в каждом чанке только новое»).

Для клиента это выглядит по-разному в зависимости от эндпоинта. На нативном `/generate` меняется сам формат SSE-кадров — это ломающее изменение для существующих клиентов. На `/v1/chat/completions`, `/v1/completions` и `/v1/responses` формат остается прежним: OpenAI-фасад в накопительном режиме сам нарезает дельты по offset'у, а в инкрементальном берет их напрямую. Выгода там не в формате, а в снятии квадратичной работы со строками.

## Оригинальная справка

```text
Whether to output as a sequence of disjoint segments.
```

## Паспорт аргумента

- Флаги: `--incremental-streaming-output`
- Группа: `serving`
- Тип значения: bool (флаг без значения)
- Допустимые значения: флаг присутствует / отсутствует
- Значение по умолчанию: `false`
- Эффективное значение: `__post_init__` не переопределяет. Существует устаревший алиас `--stream-output` (`DeprecatedStoreTrueAction`, `dest="incremental_streaming_output"`) — он выставляет то же поле и печатает предупреждение
- Где объявлен: `ServerArgs.incremental_streaming_output`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный (парная устаревшая форма — `--stream-output`)
- Этап применения: `TokenizerManager` при инициализации → обработка каждого стримингового ответа

## Что меняет в движке

### Уровень `TokenizerManager`

`_handle_batch_output` (`sglang/python/sglang/srt/managers/tokenizer_manager.py`) формирует `out_dict` по-разному:

- **инкрементальный режим**: `"text": delta_text`, `"output_ids": delta_output_ids`, а метаданные логпробов нарезаются под тот же диапазон (`_slice_streaming_output_meta_info`), `state.last_output_offset` двигается;
- **накопительный режим (по умолчанию)**: промежуточные чанки уходят с `"text": None` и ссылкой на общий список `output_ids`, а полный текст подставляется позже, в `_wait_one_response` (`out["text"] = state.get_text()`). Это сделано ровно затем, чтобы не пересобирать строку на каждом шаге.

Дополнительно в инкрементальном режиме `_wait_one_response` **склеивает** накопившиеся чанки (`_coalesce_streaming_chunks`), если планировщик успел отдать несколько порций между пробуждениями — иначе дельты бы терялись.

### Уровень OpenAI-фасада

`serving_chat.py` и `serving_completions.py` содержат симметричные ветки:

```python
if self.tokenizer_manager.server_args.incremental_streaming_output:
    delta = content["text"]
else:
    delta = content["text"][offset:]
    stream_offsets[index] = len(content["text"])
```

и такие же для `output_token_logprobs`/`output_top_logprobs` и для `return_token_ids`. То есть **клиент OpenAI получает дельты в обоих режимах**. Разница только в том, кто их вычисляет и какой ценой: без флага фасад режет строку по offset'у, а строка эта в `TokenizerManager` растет — суммарно O(n²) по длине ответа.

`serving_transcription.py` идет тем же путем: при инкрементальном режиме он локально восстанавливает накопленный текст, чтобы остальная логика работала одинаково.

### Уровень нативного `/generate`

`http_server.py` просто сериализует `out` в SSE:

```python
async for out in _global_state.tokenizer_manager.generate_request(obj, request):
    yield b"data: " + dumps_json(out) + b"\n\n"
```

Никакой нормализации нет. Поэтому именно здесь флаг меняет **клиентский контракт**: по умолчанию каждый кадр содержит весь текст с начала генерации, с флагом — только новый фрагмент. Клиент, написанный под накопительный формат, с этим флагом начнет терять текст (он берет последний кадр как полный ответ), и наоборот.

## Значения и формат

- Флаг булев, значения не принимает.
- «Не задан» = накопительный режим, исторический дефолт SGLang.
- Устаревшая форма `--stream-output` делает ровно то же самое и печатает предупреждение о замене; в новых конфигурациях используйте основной флаг.
- Промежуточного/автоматического режима нет.

## Когда использовать

- Длинные ответы (десятки тысяч токенов) и заметный CPU-расход в процессе токенизатора: накопительный режим переклеивает строку на каждой выдаче, инкрементальный — нет. Это самый честный аргумент «за» для OpenAI-нагрузки.
- Собственный клиент к нативному `/generate`, который хочет дельты и не хочет сам считать diff.
- **Не включайте**, если нативный `/generate` уже используют существующие клиенты: формат кадров поменяется молча, без ошибок и предупреждений.
- **Не включайте** ради «более плавного стрима»: плавность задает `--stream-interval`, а не этот флаг.

## Влияние на производительность и память

- VRAM не затрагивается.
- RAM/CPU процесса токенизатора: снимает квадратичную склейку текста. На ответе в 32k токенов при `--stream-interval 1` это разница между ~32k срезов растущей строки и ~32k коротких дельт.
- Latency отдельного чанка чуть ниже (нет пересборки строки), но эффект заметен только на длинных ответах.
- Трафик наружу: в накопительном режиме сервер формирует полную строку внутри, но по SSE OpenAI-фасад всё равно отдает дельты — размер ответа для клиента не меняется.

## Взаимодействие с другими аргументами

- `--stream-output`: устаревший алиас того же поля; не используйте его в новых запусках.
- `--stream-interval`: определяет, как часто формируются порции; этот флаг — что в них лежит. Комбинируются свободно.
- `--batch-notify-size`: в инкрементальном режиме включается коалесинг нескольких порций в одном пробуждении, поэтому большие значения `--batch-notify-size` здесь безопаснее, чем в накопительном.
- `--stream-response-default-include-usage`: usage-кадр формируется фасадом отдельно и от режима дельт не зависит.
- `--enable-return-hidden-states` и `return_token_ids`: их порезка по диапазону тоже переключается этим флагом — клиент, читающий `output_ids` из нативного стрима, должен знать режим.

## Типовые проблемы и диагностика

- **После включения нативный клиент показывает обрывки** — клиент рассчитан на накопительный формат. Либо верните флаг, либо научите клиента конкатенировать кадры.
- **В логе предупреждение о `--stream-output`** — используется устаревший алиас; замените на `--incremental-streaming-output`.
- **Ожидали изменения SSE у `/v1/chat/completions` и не увидели** — это правильно: фасад нормализует оба режима к дельтам.
- **Пропадают токены в инкрементальном режиме при большом `--batch-notify-size`** — не должно: за это отвечает `_coalesce_streaming_chunks`. Если наблюдаете — это баг движка, а не настройка; фиксируйте `rid` и полный кадр.
- Принятое значение — в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --incremental-streaming-output --port 30000
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --incremental-streaming-output --stream-interval 4 --batch-notify-size 32 --port 30000
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_chat.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_completions.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_transcription.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
