---
schema: 1
engine: sglang
primaryName: "--debug-tensor-dump-input-file"
title: "--debug-tensor-dump-input-file"
summary: Подменяет прогревочный запрос фиксированными `input_ids` из `.npy`-файла и после него завершает сервер. Одноразовый режим «один prefill и выход»; вместе с `--debug-tensor-dump-output-folder` в этом checkout'е не работает.
group: observability
related:
  - --debug-tensor-dump-output-folder
  - --debug-tensor-dump-layers
  - --skip-server-warmup
  - --msprobe-dump-config
  - --disaggregation-mode
---

# --debug-tensor-dump-input-file

## Кратко

Аргумент превращает запуск сервера в одноразовый прогон: прогревочный запрос вместо текста «The capital city of France is» получает `input_ids`, загруженные из указанного `.npy`-файла, `max_new_tokens` выставляется в `0` (значит, только prefill, без генерации), а сразу после завершения прогрева процесс убивает собственное дерево процессов. Смысл — воспроизводимо прогнать один и тот же вход через модель, чтобы снять с него дамп. Ровно здесь и кроется проблема: штатный напарник `--debug-tensor-dump-output-folder` принудительно отключает прогрев, из-за чего в этом checkout'е пара не работает.

## Оригинальная справка

```text
The input filename for dumping tensors
```

## Паспорт аргумента

- Флаги: `--debug-tensor-dump-input-file`
- Группа: `observability`
- Тип значения: str — путь к файлу `.npy` (формат NumPy), читается через `np.load(...).tolist()`
- Допустимые значения: `choices` нет; формат и содержимое не валидируются
- Значение по умолчанию: `null`
- Эффективное значение: совпадает с заданным; ни один `_handle_*` его не переписывает. Но фактическое срабатывание зависит от `skip_server_warmup`, который переписывают другие аргументы
- Где объявлен: `ServerArgs.debug_tensor_dump_input_file`, файл — `sglang/python/sglang/srt/server_args.py`. Прямо над объявлением оставлен комментарий-напоминание о будущем удалении старого кода дампера — путь помечен авторами как устаревающий
- Статус: обычный, отладочный, с явной пометкой на удаление в исходниках
- Этап применения: прогревочный запрос в `_execute_server_warmup` → завершение процесса в `_wait_and_warmup`

## Что меняет в движке

Обе точки чтения находятся в `sglang/python/sglang/srt/entrypoints/http_server.py`.

Первая — внутри сборки прогревочного запроса:

```python
if server_args.debug_tensor_dump_input_file:
    json_data.pop("text", None)
    json_data["input_ids"] = np.load(server_args.debug_tensor_dump_input_file).tolist()
    json_data["sampling_params"]["max_new_tokens"] = 0
```

Запрос уходит на `/generate` (для эмбеддинг-моделей — на `/encode`). Поскольку `max_new_tokens` равен нулю, выполняется только prefill.

Вторая — в конце `_wait_and_warmup`, сразу после строки `The server is fired up and ready to roll!`:

```python
if server_args.debug_tensor_dump_input_file:
    kill_process_tree(os.getpid())
```

То есть сервер не остается доступным: он завершает себя вместе со всеми подпроцессами.

### Несовместимость с `--debug-tensor-dump-output-folder`

`__post_init__` при заданном `--debug-tensor-dump-output-folder` выставляет `skip_server_warmup = True`. В `_wait_and_warmup` прогрев в этом случае не выполняется вовсе — ветка уходит в `else`, где статус сервера просто помечается как `Up`. Дальше печатается «fired up» и срабатывает `kill_process_tree`. Итог: ни одного forward не произошло, дампа нет, процесс завершился.

Практический вывод: в этом commit'е (`b20c375c`) сочетание двух аргументов не даёт дампа. Работоспособные варианты — либо снимать дамп без файла входа (послать запрос самому, пока сервер жив), либо использовать `--debug-tensor-dump-input-file` с механизмом захвата, который не отключает прогрев, — например с не-интрузивным дампером `sglang/python/sglang/srt/debug_utils/dumper.py`, который включается не через CLI. Тот же конфликт затрагивает и `--msprobe-dump-config`: он тоже выставляет `skip_server_warmup = True`.

## Значения и формат

- Файл должен читаться `numpy.load`, то есть быть `.npy` (или `.npz` с одним массивом — но тогда `.tolist()` применится к объекту `NpzFile` и упадет; практически нужен именно `.npy`).
- Одномерный массив даст плоский список токенов — один запрос. Двумерный даст список списков — батч запросов.
- Тип элементов должен быть целочисленным: значения уходят как `input_ids`.
- Ограничений на длину нет; она должна укладываться в `--context-length` и в `--max-prefill-tokens`, иначе запрос будет отвергнут уже внутри движка.
- Специальных значений (`-`, `auto`) нет; несуществующий путь даст `FileNotFoundError` в момент прогрева, то есть уже после загрузки весов.
- Отключить у работающего сервера нельзя — да и сервер после срабатывания не работает.

## Когда использовать

- Когда нужен строго воспроизводимый вход: одни и те же `input_ids` на двух сборках, чтобы сравнить численные результаты без влияния токенизатора и шаблона чата.
- Когда захват данных делается механизмом, не отключающим прогрев, и нужно, чтобы сервер отработал ровно один prefill и вышел — удобно в скриптах сравнения.
- Не использовать вместе с `--debug-tensor-dump-output-folder` (см. выше) — молчаливый пустой результат.
- Не использовать на сервере, который должен продолжать обслуживать запросы: аргумент гарантированно завершает процесс.
- Не задавать в постоянной конфигурации инстанса: инстанс будет стартовать и немедленно умирать.

## Влияние на производительность и память

- VRAM и RAM: файл `.npy` с идентификаторами токенов занимает килобайты; на потребление модели не влияет.
- Время работы: сервер живет от старта до конца прогрева. Всё, что дальше, не выполняется.
- На throughput и latency не влияет по построению — обслуживания трафика не происходит.
- Единственная косвенная стоимость — полная загрузка весов ради одного прохода.

## Взаимодействие с другими аргументами

- `--debug-tensor-dump-output-folder`: несовместим в этом checkout'е — отключает прогрев, который читает файл.
- `--debug-tensor-dump-layers`: относится к тому же дампу и вместе с этим аргументом смысла не имеет по той же причине.
- `--skip-server-warmup`: заданный явно, он приводит к тому же результату — файл не читается, процесс завершается сразу после старта.
- `--msprobe-dump-config`: тоже выставляет `skip_server_warmup = True`, конфликт идентичен.
- `--disaggregation-mode`: прогрев в режимах, отличных от `null`, идет по другой ветке; поведение файла входа там не проверялось в этом документе, ориентируйтесь на код `_execute_server_warmup`.
- Мультимодальные модели: для VLM прогревочный payload собирается в формате `/v1/chat/completions` и ключа `sampling_params` не содержит, поэтому строка `json_data["sampling_params"]["max_new_tokens"] = 0` завершится `KeyError`. Аргумент рассчитан на текстовые модели.

## Типовые проблемы и диагностика

- Сервер стартовал и сразу завершился, дампа нет — задан вместе с `--debug-tensor-dump-output-folder`. В логе будут и `Cuda graph and server warmup are disabled because of using tensor dump mode`, и `The server is fired up and ready to roll!` без единой строки `Dump …th pass to …`.
- `FileNotFoundError` после загрузки весов — неверный путь; ошибка приходит из прогревочного потока, за ней следует `Initialization failed. warmup error: …` и завершение процесса.
- `KeyError: 'sampling_params'` — модель определилась как мультимодальная.
- Запрос отвергнут по длине — массив длиннее `--context-length` или `--max-prefill-tokens`.
- Сервер завершился «сам по себе» без ошибок — это штатное поведение аргумента, а не сбой.
- **В arriero:** инстанс с этим аргументом будет выглядеть как немедленно падающий: процесс закроется сразу после старта, и запуск получит `stopReason: "crash"` (`docs/STATUS_LAYERS.md`). Использовать аргумент имеет смысл только вручную, запуская `python -m sglang.launch_server` из окружения инстанса, а не через менеджер.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --debug-tensor-dump-input-file /var/tmp/probe_input_ids.npy
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --debug-tensor-dump-input-file /var/tmp/probe_input_ids.npy --context-length 8192
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/python/sglang/srt/debug_utils/tensor_dump_forward_hook.py`
- arriero: `docs/STATUS_LAYERS.md`
