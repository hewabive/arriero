---
schema: 1
engine: sglang
primaryName: "--speculative-token-map"
title: "--speculative-token-map"
summary: Путь к списку «горячих» token id (FR-Spec). Урезает lm_head draft-модели до этого подмножества словаря, удешевляя каждый черновой прогон. Для EAGLE3 игнорируется.
group: spec
related:
  - --speculative-algorithm
  - --speculative-draft-model-path
  - --speculative-use-rejection-sampling
  - --speculative-num-steps
  - --speculative-eagle-topk
---

# --speculative-token-map

## Кратко

`--speculative-token-map` включает FR-Spec: draft-модель считает логиты не по всему словарю, а по заранее отобранному подмножеству высокочастотных токенов. Матрица `lm_head`, разделяемая с target-моделью, урезается по строкам до этого списка, а индексы, которые возвращает черновик, отображаются обратно в полный словарь. Экономия — в GEMM выходного слоя черновика, который на маленьких draft-моделях составляет заметную долю стоимости шага. Для EAGLE3 аргумент бесполезен: такие чекпоинты несут собственное отображение.

## Оригинальная справка

```text
The path of the draft model's small vocab table.
```

## Паспорт аргумента

- Флаги: `--speculative-token-map`
- Группа: `spec`
- Тип значения: str — путь к файлу, читаемому `torch.load(..., weights_only=True)`, либо строка вида `<hf-repo-id>/<имя файла>`
- Допустимые значения: `choices` нет
- Значение по умолчанию: `null` — FR-Spec выключен
- Эффективное значение: не переопределяется в `__post_init__`. Специально **не** резолвится в `_handle_modelscope_paths` — разбор пути живёт в `load_token_map` (`sglang/python/sglang/srt/speculative/spec_utils.py`)
- Где объявлен: `ServerArgs.speculative_token_map`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: инициализация spec-воркера, `init_token_map` → `init_lm_head` (до захвата CUDA graph); на CLI-разборе путь не проверяется

## Что меняет в движке

`init_token_map` в `sglang/python/sglang/srt/speculative/eagle_worker_v2.py`:

- если алгоритм EAGLE3 — печатает `Speculative token map specified, but EAGLE3 models already have this. Ignoring the specified token map.` и обнуляет `hot_token_id`;
- иначе загружает список через `load_token_map` и кладёт в `hot_token_id` как `torch.int64`.

Дальше `init_lm_head` делает `head = head.clone()` и `head.data = head.data[self.hot_token_id]`: черновик получает **собственную копию** выходной матрицы размера `len(hot_token_id) × hidden_size` вместо разделяемой с target-моделью полной матрицы. В `draft_forward` каждый результат `fast_topk` пропускается через `topk_index = self.hot_token_id[topk_index]`, возвращая индексы в полный словарь, — поэтому верификация target-моделью остаётся корректной.

`load_token_map` разбирает путь так: если файла на диске нет, `os.path.dirname` трактуется как repo id, `os.path.basename` — как имя файла, и запускается `snapshot_download(repo_id, ignore_patterns=["*.bin", "*.safetensors"])`. При `SGLANG_USE_MODELSCOPE` вместо HF используется ModelScope. То есть опечатка в локальном пути не даёт ошибки «файл не найден», а превращается в попытку сетевой загрузки.

## Значения и формат

- Локальный путь к файлу, который `torch.load(..., weights_only=True)` читает как список или тензор целых id: `--speculative-token-map /models/fr-spec/freq_32768.pt`.
- Либо `repo/file`: `--speculative-token-map thunlp/LLaMA3-Instruct-8B-FR-Spec/freq_32768.pt` — так этот аргумент показан в апстрим-документации. Скачивание идёт при старте, без весов (`*.bin`/`*.safetensors` исключены из загрузки).
- Список должен быть подмножеством словаря **target-модели**: индексы используются для нарезки её `lm_head`. Значение вне `[0, vocab_size)` даст ошибку индексации на старте.
- Размер списка — обычно степень двойки (`freq_32768.pt` в примерах апстрима). Чем короче список, тем дешевле черновик и тем выше риск, что нужного токена в нём нет.
- Пустая строка не эквивалентна отсутствию аргумента: `""` — ложное значение и по факту отключает FR-Spec, но при этом путь всё равно попадает в дамп `server_args=`. Просто не задавайте аргумент.

## Когда использовать

- EAGLE/EAGLE2 (`--speculative-algorithm EAGLE` или `NEXTN`) с большим словарём и маленькой draft-моделью: там выходной GEMM черновика соизмерим с остальным его прогоном.
- Когда есть готовый файл частот, собранный на том же токенизаторе, что и target-модель. Чужой файл, снятый с другого токенизатора, тихо испортит качество предложений (индексы отобразятся не в те токены).
- Не использовать с EAGLE3 — будет проигнорирован с предупреждением.
- Не использовать вместе с `--speculative-use-rejection-sampling`: несовпадение словарей черновика и target-модели там отвергается явной ошибкой.
- Не использовать как способ «ускорить target-модель»: полное распределение target-модели остаётся нетронутым, урезается только черновик.

## Влияние на производительность и память

- VRAM: `head.clone()` на момент инициализации создаёт полную копию выходной матрицы (`vocab_size × hidden_size` в dtype весов), после нарезки остаётся урезанная копия `len(hot) × hidden_size`. Для Llama-3 8B (словарь 128 256, hidden 4096, bf16) это пик около 0.98 ГиБ и постоянные 0.25 ГиБ при списке в 32 768 токенов — вместо нулевого расхода при разделяемой матрице.
- Compute: выходной GEMM черновика уменьшается пропорционально `len(hot) / vocab_size`; softmax и `topk` на черновике — тоже.
- Время старта: плюс чтение файла; при пути вида `repo/file` — ещё и сетевая загрузка репозитория.
- Latency: выигрыш тем заметнее, чем меньше draft-модель и больше словарь.
- Качество: список должен покрывать типичные продолжения; иначе падает acceptance rate, и выигрыш от дешёвого черновика съедается лишними верификациями.
- RAM хоста: разово на время `torch.load`.

## Взаимодействие с другими аргументами

- `--speculative-algorithm`: имеет смысл только для EAGLE-семейства с отдельным черновиком; при `EAGLE3` игнорируется, при `NGRAM` черновой модели нет вообще.
- `--speculative-draft-model-path`: список частот должен соответствовать паре target + этот черновик.
- `--speculative-use-rejection-sampling`: взаимно исключены — rejection sampling требует, чтобы черновик выдавал распределение по полному словарю target-модели.
- `--speculative-num-steps` / `--speculative-eagle-topk`: экономия умножается на число черновых прогонов за decode-шаг, поэтому эффект тем заметнее, чем глубже и шире черновик.

## Типовые проблемы и диагностика

- В логе `Speculative token map specified, but EAGLE3 models already have this. Ignoring the specified token map.` — аргумент не действует, уберите его.
- Долгий старт и сетевая активность вместо ошибки при опечатке в пути — сработала ветка «repo id + имя файла». Проверьте, что файл существует локально (`ls`), прежде чем винить движок.
- `IndexError` при нарезке `head.data[hot_token_id]` — в списке есть id вне словаря target-модели; файл снят с другого токенизатора.
- `--speculative-use-rejection-sampling requires the draft and target to share one vocab, but the draft vocab (N) != target vocab (M)` — это ровно случай включённого FR-Spec вместе с rejection sampling.
- Ускорения нет, `accept rate` заметно упал после включения — список слишком короткий для вашего домена. Возьмите больший файл частот или откажитесь от FR-Spec.
- Чем подтвердить, что путь принят: дамп `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`) — поле `speculative_token_map`.

## Примеры

```bash
python -m sglang.launch_server --model-path meta-llama/Meta-Llama-3-8B-Instruct --speculative-algorithm EAGLE --speculative-draft-model-path lmsys/sglang-EAGLE-LLaMA3-Instruct-8B --speculative-num-steps 3 --speculative-eagle-topk 4 --speculative-num-draft-tokens 16 --speculative-token-map thunlp/LLaMA3-Instruct-8B-FR-Spec/freq_32768.pt
```

```bash
python -m sglang.launch_server --model-path /models/Meta-Llama-3-8B-Instruct --speculative-algorithm EAGLE --speculative-draft-model-path /models/sglang-EAGLE-LLaMA3-Instruct-8B --speculative-num-steps 3 --speculative-eagle-topk 1 --speculative-num-draft-tokens 4 --speculative-token-map /models/fr-spec/freq_32768.pt
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/speculative/spec_utils.py`
- `sglang/python/sglang/srt/speculative/eagle_worker_v2.py`
- `sglang/python/sglang/srt/speculative/standalone_worker_v2.py`
- `sglang/docs/docs/advanced_features/speculative_decoding.mdx`
