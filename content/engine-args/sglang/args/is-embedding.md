---
schema: 1
engine: sglang
primaryName: "--is-embedding"
title: "--is-embedding"
summary: Переводит decoder-модель в режим эмбеддингов: сервер перестает быть генеративным, планировщик считает pooling-проход вместо декодирования. Для нативных encoder-архитектур включается сам.
group: model
related:
  - --model-path
  - --json-model-override-args
  - --prefill-only-disable-kv-cache
  - --chunked-prefill-size
  - --disable-radix-cache
  - --enable-multimodal
  - --attention-backend
---

# --is-embedding

## Кратко

`--is-embedding` — это флаг намерения, а не оптимизация. Он говорит движку: обслуживать `CausalLM`-чекпоинт как модель эмбеддингов. Следствие — `ModelConfig.is_generation` становится False, и весь сервер меняет режим: планировщик идет по embedding-ветке forward, health-check перестает генерировать токен, `/v1/embeddings` начинает работать. Для архитектур, которые сами по себе являются энкодерами, флаг не нужен — `__post_init__` включает режим автоматически.

## Оригинальная справка

```text
Whether to use a CausalLM as an embedding model.
```

## Паспорт аргумента

- Флаги: `--is-embedding`
- Группа: `model`
- Тип значения: bool (флаг без значения)
- Допустимые значения: присутствует / отсутствует
- Значение по умолчанию: `false`
- Эффективное значение: включается автоматически в `_handle_model_capability_adjustments`, если `embedding_model_spec.auto_enable_embedding` истинно для архитектуры («Embedding architecture detected: enabling embedding mode automatically»); для EmbeddingGemma дополнительно принудительно ставятся `disable_radix_cache=True`, `chunked_prefill_size=-1`, `enable_tokenizer_batch_encode=True` и подбирается prefill-backend
- Где объявлен: `ServerArgs.is_embedding`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` → `ModelConfig` (`is_generation`) → инициализация tokenizer manager и планировщика → HTTP-слой

## Что меняет в движке

Значение уходит в `ModelConfig.from_server_args(is_embedding=…)`, где через `is_generation_model(architectures, is_embedding)` вычисляется `self.is_generation`. Для архитектуры, не входящей в список заведомо эмбеддинговых, функция просто возвращает `not is_embedding` — то есть флаг напрямую выключает генеративный режим.

Дальше `is_generation` расходится:

- **Планировщик** (`managers/scheduler.py`): `if self.is_generation:` выбирает генеративный forward; иначе выполняется embedding-проход без сэмплирования.
- **Tokenizer manager**: обратная проверка — `EmbeddingReqInput` на генеративной модели отвергается с текстом «This model does not appear to be an embedding model by default. Please add `--is-embedding` when launching the server or try another model.» Это ровно та ошибка, ради которой флаг обычно и вспоминают.
- **HTTP-слой**: `/health_generate` формирует пробный запрос по типу модели; `/get_model_info` отдает `is_generation`, а warmup выбирает форму прогрева (`max_new_tokens = 8 if is_generation else 1`).
- **Rerank** (`entrypoints/openai/serving_rerank.py`) прямо рассчитывает на `is_generation == False`.

Также `--is-embedding` — жесткая предпосылка `--prefill-only-disable-kv-cache`: без него включение падает с `ValueError: --prefill-only-disable-kv-cache currently requires --is-embedding.`

## Значения и формат

- Флаг без значения; парной формы `--no-is-embedding` нет, поэтому автоматически включенный режим (encoder-архитектура) выключить нельзя.
- На генеративной модели включение не «добавляет endpoint», а **заменяет** режим: сервер перестает быть генеративным.
- Matryoshka-эмбеддинги включаются не этим флагом, а полями конфига (`matryoshka_dimensions` / `is_matryoshka`); при их отсутствии в модели используется `--json-model-override-args`.

## Когда использовать

- Модель — decoder (`…ForCausalLM`), а вам нужны векторы: единственный корректный способ.
- Получили ошибку «Please add `--is-embedding` when launching the server» на запрос к `/v1/embeddings` — это прямое указание.
- Не включайте на модели, которую тот же процесс должен обслуживать генеративно: совместить режимы нельзя, нужен второй инстанс.
- Не включайте «для скорости» — режим не ускоряет генерацию, он ее отключает.

## Влияние на производительность и память

- Убирается всё, что нужно только декодированию: сэмплирование, decode-CUDA-graph по генеративному пути, дополнительные буферы спекуляции.
- В связке с `--prefill-only-disable-kv-cache` (только на Hopper/Blackwell, FA-backend, `--chunked-prefill-size -1`, `--disable-radix-cache`) KV-пул не выделяется вовсе — это самая большая экономия VRAM, доступная эмбеддинг-серверу.
- Для EmbeddingGemma автоматически выключается radix cache и chunked prefill: у энкодера с двунаправленным вниманием переиспользование префикса математически неверно, поэтому экономия памяти на кеше там недоступна принципиально.
- Пропускная способность измеряется в текстах, а не в токенах в секунду; батч собирается на prefill-проходе.

## Взаимодействие с другими аргументами

- `--prefill-only-disable-kv-cache`: требует этот флаг и дополнительно несовместим с fp4/mxfp8 KV.
- `--chunked-prefill-size`: для полностью энкодерного режима должен быть `-1` (один запрос — один forward); для EmbeddingGemma движок ставит это сам.
- `--disable-radix-cache`: для двунаправленного внимания включается принудительно.
- `--attention-backend` / `--prefill-attention-backend`: быстрый путь без KV существует только у FA-backend'ов на SM90/SM100.
- `--enable-multimodal`: мультимодальные эмбеддинги зависят от архитектуры, флаг режима их не включает.
- `--json-model-override-args`: способ дообъявить `matryoshka_dimensions`.

В arriero инстанс kind `ktransformers` подключается к прокси как обычная генеративная модель; эмбеддинг-режим прокси-путями не обслуживается, поэтому включать этот флаг для управляемого KT-инстанса смысла нет.

## Типовые проблемы и диагностика

- «This model does not appear to be an embedding model by default. Please add `--is-embedding` …» — запрос к `/v1/embeddings` на генеративном сервере.
- `ValueError: --prefill-only-disable-kv-cache currently requires --is-embedding.` — порядок включения.
- Сервер стартовал без флага, но ведет себя как эмбеддинговый — сработал автодетект; ищите строку «Embedding architecture detected: enabling embedding mode automatically.»
- Генеративные запросы не дают результата — проверьте `is_generation` в ответе `/get_model_info`: это самый прямой способ увидеть режим.
- Значение флага, как его принял движок (включая автоматическое включение), — в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/e5-mistral-7b-instruct --is-embedding --port 30000
```

```bash
python -m sglang.launch_server --model-path /models/e5-mistral-7b-instruct --is-embedding --chunked-prefill-size -1 --disable-radix-cache --prefill-only-disable-kv-cache
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/configs/model_config.py`
- `sglang/python/sglang/srt/configs/embedding_model_spec.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/docs/docs/supported-models/embedding_models.mdx`
