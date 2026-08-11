---
schema: 1
engine: sglang
primaryName: "--stream-output"
title: "--stream-output"
summary: Устаревший алиас `--incremental-streaming-output` — переключает потоковую выдачу с накопительного текста на непересекающиеся приращения. Меняет форму данных между движком и HTTP-слоем, а не формат SSE, который видит клиент.
group: null
related:
  - --incremental-streaming-output
  - --stream-interval
  - --enable-streaming-session
  - --stream-response-default-include-usage
---

# --stream-output

## Кратко

По умолчанию SGLang шлет из детокенизатора **накопительный** текст: каждый чанк содержит весь ответ с начала, а HTTP-слой сам вырезает приращение срезом `text[offset:]`. С `--incremental-streaming-output` детокенизатор шлет уже готовые непересекающиеся куски, и HTTP-слой отдает их как есть. Флаг `--stream-output` — устаревшее имя этого переключателя.

Для клиента формат SSE не меняется: `delta.content` в обоих режимах содержит приращение. Меняется внутренняя механика, а с ней — поведение полей `logprobs` и `output_ids` в потоке и способ склейки нескольких накопившихся чанков.

## Оригинальная справка

```text
[Deprecated] Use --incremental-streaming-output instead.
```

## Паспорт аргумента

- Флаги: `--stream-output`
- Группа: `null` — устаревший алиас объявлен литеральным `parser.add_argument` в `add_cli_args`, вне группы `serving`, где живет актуальный флаг
- Тип значения: флаг без значения
- Допустимые значения: только присутствие флага
- Значение по умолчанию: `False`
- Эффективное значение: кладет `True` в `incremental_streaming_output`; дальше значение неотличимо от заданного актуальным флагом
- Где объявлен: `ServerArgs.add_cli_args`, файл — `sglang/python/sglang/srt/server_args.py`; `dest` — `incremental_streaming_output`
- Статус: устаревший (`DeprecatedStoreTrueAction`), замена — `--incremental-streaming-output`
- Этап применения: разбор CLI (предупреждение) → чтение в `TokenizerManager.__init__` и в OpenAI-слое при обработке каждого потокового чанка

## Что меняет в движке

### Предупреждение и трансляция

```text
'--stream-output' is deprecated and will be removed in a future release. Use '--incremental-streaming-output' instead.
```

Печатается на разборе аргументов, до `logging.basicConfig`, поэтому строка стоит в начале вывода без временного префикса.

### Две ветки в потоковом пути

`TokenizerManager` при инкрементальном режиме склеивает несколько накопившихся чанков в один (`_coalesce_streaming_chunks`) — иначе часть токенов потерялась бы, ведь чанки не перекрываются. В накопительном режиме склейка не нужна: достаточно взять последний чанк, он и так содержит всё.

В OpenAI-слое (`serving_completions.py`, `serving_chat.py`) ветвление проходит по трем местам:

- текст ответа: `delta = text` в инкрементальном режиме против `delta = text[offset:]` в накопительном;
- `logprobs`: в накопительном режиме массивы режутся окном `[n_prev_token:total_output_logprobs]`, в инкрементальном берутся целиком;
- `output_ids` при `return_token_ids`: в накопительном режиме берется хвост от предыдущей отметки, в инкрементальном — весь массив чанка.

## Значения и формат

- Булев флаг без значения; «не задан» — накопительный режим (значение по умолчанию).
- Отключить в командной строке то, что включено в YAML-конфиге, нельзя: парного `--no-*` нет. Впрочем, в YAML этот ключ и не задается — `incremental-streaming-output` отвергается механизмом `--config` как аргумент с нестандартным argparse-действием (ровно из-за этого устаревшего алиаса на общем `dest`).
- Влияет только на потоковые запросы; на неточные ответы и на `/v1/completions` без `stream: true` не действует.

## Когда использовать

- Не использовать: пишите `--incremental-streaming-output`.
- Сам режим (под новым именем) снижает объем данных, гоняемых между процессами: при длинном ответе накопительный режим пересылает весь текст на каждом чанке, то есть трафик растет квадратично по длине ответа. На длинных генерациях и высокой конкурентности это заметно.
- Не включать, если клиент или промежуточный слой рассчитывает на накопительные `logprobs`/`output_ids`: их форма в потоке меняется.

## Влияние на производительность и память

- VRAM и KV-пул: не затрагивает.
- RAM и межпроцессный трафик: главный эффект. Накопительный режим передает O(n²) символов на ответ длиной n чанков; инкрементальный — O(n).
- Latency: косвенно, через снижение накладных расходов сериализации на длинных ответах.
- Время старта: не меняет.

## Взаимодействие с другими аргументами

- `--incremental-streaming-output`: актуальное имя того же поля.
- `--stream-interval`: сколько токенов накапливается до отправки чанка; вместе они определяют и частоту, и размер чанков.
- `--enable-streaming-session`: отдельный режим сессий потоковой выдачи, не заменяет этот переключатель.
- `--stream-response-default-include-usage`: форма поля usage в потоке, ортогональна.

## Типовые проблемы и диагностика

- `'--stream-output' is deprecated …` — замените на `--incremental-streaming-output`.
- Клиент видит дублирующийся текст — почти всегда это самодельный клиент, который сам склеивает `delta`, рассчитывая на накопительный формат движка. Формат SSE от режима не зависит, поэтому проверьте логику клиента, а не флаг.
- `logprobs` в потоке содержат больше записей, чем ожидалось, — инкрементальный режим отдает массив чанка целиком, без окна.
- Что смотреть: `incremental_streaming_output=` в дампе `server_args=` при старте и в `GET /server_info`.

## Примеры

Актуальная форма вместо этого флага:

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --incremental-streaming-output
```

Вместе с настройкой частоты чанков:

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --incremental-streaming-output --stream-interval 4
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/argparse_actions.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_completions.py`
- `sglang/python/sglang/srt/entrypoints/openai/serving_chat.py`
