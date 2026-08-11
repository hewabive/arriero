---
schema: 1
engine: sglang
primaryName: "--skip-tokenizer-init"
title: "--skip-tokenizer-init"
summary: Полностью убирает токенизатор из всех процессов: запросы обязаны приходить с input_ids, ответ возвращает token ids. Отключает строковые стоп-условия и принудительно сбрасывает три соседних аргумента.
group: serving
related:
  - --tokenizer-path
  - --tokenizer-mode
  - --tokenizer-backend
  - --detokenizer-worker-num
  - --tokenizer-worker-num
  - --enable-tokenizer-batch-encode
  - --enable-dynamic-batch-tokenizer
  - --disable-radix-cache
  - --preferred-sampling-params
---

# --skip-tokenizer-init

## Кратко

`--skip-tokenizer-init` переводит сервер в режим «сырых токенов»: `TokenizerManager`, `DetokenizerManager`, scheduler и tp-worker создаются с `tokenizer = None`. Клиент обязан присылать `input_ids`, а получает `output_ids`; текстовый промпт приводит к ошибке.

Это не оптимизация HTTP-слоя, а смена контракта API. Режим предназначен для внешних систем, которые уже владеют токенизацией (RL-обучение, собственный препроцессор, бенчмарки на фиксированных последовательностях), и несовместим с обычным OpenAI-совместимым потреблением.

## Оригинальная справка

```text
If set, skip init tokenizer and pass input_ids in generate request.
```

## Паспорт аргумента

- Флаги: `--skip-tokenizer-init`
- Группа: `serving`
- Тип значения: bool; поле объявлено как `bool`, argparse получает `action="store_true"`, парного `--no-*` нет
- Допустимые значения: флаг без значения
- Значение по умолчанию: `False`
- Эффективное значение: совпадает с заданным, но **переписывает три соседних аргумента** в `_handle_tokenizer_batching` (при незаданной переменной `SGLANG_RUST_SERVER`): `detokenizer_worker_num` принудительно становится `1` с предупреждением, `enable_tokenizer_batch_encode` и `enable_dynamic_batch_tokenizer` принудительно выключаются, каждый со своим предупреждением
- Где объявлен: `ServerArgs.skip_tokenizer_init`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (`_handle_tokenizer_batching`, проверка `--preferred-sampling-params`) → запуск процессов tokenizer/detokenizer/scheduler → HTTP-слой (валидация каждого запроса)

## Что меняет в движке

### Отсутствие токенизатора

- `TokenizerManager.__init__`: `self.tokenizer = None`; мультимодальный процессор при этом все равно создается, чтобы изображения кодировались.
- `DetokenizerManager.init_tokenizer`: `self.tokenizer = None`, `self.vocab_size = None`.
- `Scheduler` и `TpWorker`: пропускают загрузку токенизатора; scheduler отдельно ветвится по `self.skip_tokenizer_init` при формировании выходов.
- `GrammarManager` не инициализируется — структурная генерация (regex/JSON-схема) опирается на словарь токенизатора.
- `scheduler_components/ipc_channels.py`: выходной канал переключается так, что scheduler отправляет `BatchTokenIDOutput` напрямую, минуя строковый путь.

### Контракт запроса

`_tokenize_one_request` при `self.tokenizer is None` и отсутствии `input_ids`/`input_embeds` бросает:

```text
The engine initialized with skip_tokenizer_init=True cannot accept text prompts. Please provide input_ids or re-initialize the engine with skip_tokenizer_init=False.
```

### Что перестает работать в параметрах сэмплирования

`SamplingParams.normalize(None)` (`sampling/sampling_params.py`) отвергает три вещи, о чем `__post_init__` заранее пишет информационную строку `skip_tokenizer_init=True: string-based stop conditions (stop, stop_regex) and min_new_tokens are unavailable.`:

- `stop` — строковые стоп-последовательности (нужен токенизатор, чтобы их найти в тексте);
- `stop_regex`;
- `min_new_tokens` — требует `eos_token_id` токенизатора.

Останавливать генерацию остается через `stop_token_ids` и `max_new_tokens`.

Дополнительно: если задан `--preferred-sampling-params`, `__post_init__` прогоняет его через `SamplingParams(**...).normalize(None)` и падает на старте, если там есть что-то из перечисленного, — это единственная проверка, которая ловит несовместимость до запуска.

### Прогрев

Штатный warmup-запрос переключается на `input_ids: [10, 11, 12]` (по одному набору на каждый DP-ранг) и никогда не идет по VLM-ветке `/v1/chat/completions`.

## Значения и формат

- Флаг без значения.
- Токенизатор не загружается вовсе, поэтому `--tokenizer-path`, `--tokenizer-mode` и `--tokenizer-backend` становятся неактуальными (пути они по-прежнему резолвят в `__post_init__`, но загрузки не происходит).
- Отменить принудительный сброс `--detokenizer-worker-num`, `--enable-tokenizer-batch-encode` и `--enable-dynamic-batch-tokenizer` нельзя.

## Когда использовать

- Внешний конвейер уже токенизирует данные и хочет полного контроля над последовательностями: RL-обучение с генерацией на лету, воспроизводимые бенчмарки, дообучение с teacher forcing.
- Замер чистой скорости движка без CPU-накладных расходов на токенизацию.
- **Не** использовать для обычного обслуживания через OpenAI-совместимый API. Ни один OpenAI-клиент не умеет слать `input_ids` вместо `messages`.
- Не использовать, если нужна структурная генерация (JSON-схемы, regex, вызов инструментов) — грамматический слой в этом режиме не поднимается.

## Влияние на производительность и память

- **RAM хоста:** экономия равна размеру токенизатора и процессора в каждом процессе, где он бы загрузился, — это единицы-десятки мегабайт на процесс, не тот порядок, ради которого стоит включать флаг.
- **CPU:** убирается токенизация и детокенизация из горячего пути. Для очень коротких запросов на очень высокой частоте это заметно; для типичной генерации сотен токенов — доли процента.
- **Время старта:** чуть меньше, токенизатор не читается.
- **VRAM:** не затрагивается.

Реальная мотивация включения — не производительность, а контракт: возможность отправлять точные последовательности токенов.

## Взаимодействие с другими аргументами

- `--detokenizer-worker-num`: принудительно `1`, поскольку декодировать нечего.
- `--enable-tokenizer-batch-encode`, `--enable-dynamic-batch-tokenizer`: принудительно выключены; попытка задать даст предупреждение и игнорирование.
- `--tokenizer-worker-num`: **не** сбрасывается. В комментарии кода это объяснено: воркеры продолжают обслуживать HTTP и состояние запросов, поэтому их размножение сохраняет смысл.
- `--tokenizer-path` / `--tokenizer-mode` / `--tokenizer-backend`: становятся бездействующими.
- `--preferred-sampling-params`: проверяется на совместимость на старте.
- `--disable-radix-cache`: не связан напрямую, но запросы с `input_embeds` дополнительно требуют его — это соседнее ограничение того же обработчика.
- `--enable-multimodal`: мультимодальный процессор создается и в этом режиме, изображения кодируются, но текстовая часть все равно должна прийти токенами.

## Типовые проблемы и диагностика

- **Симптом:** `The engine initialized with skip_tokenizer_init=True cannot accept text prompts.` **Причина:** клиент прислал текст. **Лечение:** слать `input_ids` либо снять флаг.
- **Симптом:** предупреждение `skip_tokenizer_init=True leaves no decode work for detokenizer workers; forcing detokenizer_worker_num=1 (requested N).` **Причина:** заданный `--detokenizer-worker-num` перекрыт. **Лечение:** убрать аргумент.
- **Симптом:** запросы со `stop: ["\n\n"]` отвергаются. **Причина:** строковые стоп-условия недоступны. **Лечение:** `stop_token_ids`.
- **Симптом:** сервер не стартует, ошибка при разборе `--preferred-sampling-params`. **Причина:** в наборе есть `stop`, `stop_regex` или `min_new_tokens`. **Лечение:** убрать их из набора.
- **Подтверждение режима:** информационная строка `skip_tokenizer_init=True: string-based stop conditions ...` в логе и `skip_tokenizer_init=True` в дампе `server_args=`.

## В arriero

Флаг несовместим с назначением инстанса kind `ktransformers`. Публичная поверхность arriero — OpenAI-совместимый API и Anthropic-мост (`docs/KTRANSFORMERS_OPERATIONS.md`), а прокси форвардит тело запроса с полями `messages`/`prompt`, то есть с текстом. При `--skip-tokenizer-init` каждый проксированный запрос получит ошибку «cannot accept text prompts».

Отдельно: проба готовности тоже пострадает частично. `/health` в этом режиме продолжит работать (он и так шлет `input_ids=[0]`), поэтому инстанс станет `ready`, а весь прикладной трафик будет падать. То есть отказ будет выглядеть как здоровая цель с постоянными ошибками — самая неприятная форма.

В сырых `args` ключ не зарезервирован, схема его пропустит. Не задавайте его для инстансов arriero.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --host 127.0.0.1 --port 30000 --skip-tokenizer-init
```

```bash
curl -sS http://127.0.0.1:30000/generate -H 'Content-Type: application/json' -d '{"input_ids": [10, 11, 12], "sampling_params": {"max_new_tokens": 8, "temperature": 0}}'
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/managers/detokenizer_manager.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/sampling/sampling_params.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- arriero: `docs/KTRANSFORMERS_OPERATIONS.md`, `docs/API_PROXY_FOUNDATION.md`
