---
schema: 1
engine: sglang
primaryName: "--enable-tokenizer-batch-encode"
title: "--enable-tokenizer-batch-encode"
summary: Токенизирует список текстов из одного batch-запроса за один вызов токенизатора вместо цикла. Работает только для batch-запросов с чистым текстом и снимает защиту, из-за которой такой батч при DP-attention целиком уходит на первый ранг.
group: serving
related:
  - --enable-dynamic-batch-tokenizer
  - --dynamic-batch-tokenizer-batch-size
  - --dynamic-batch-tokenizer-batch-timeout
  - --disable-tokenizer-batch-decode
  - --skip-tokenizer-init
  - --enable-dp-attention
  - --tokenizer-mode
  - --enable-multimodal
  - --is-embedding
---

# --enable-tokenizer-batch-encode

## Кратко

Аргумент относится к **одному запросу, содержащему список входов** (`{"text": ["...", "...", ...]}` в `/generate` или список в `/v1/embeddings`), а не к нескольким параллельным запросам — для второго случая существует `--enable-dynamic-batch-tokenizer`, и включить оба сразу нельзя.

Без флага такой список токенизируется по элементу за раз в цикле. С флагом весь список уходит одним вызовом токенизатора, что на fast-реализации дает заметный выигрыш.

Ограничения жесткие: мультимодальный вход, готовые `input_ids` и `input_embeds` в батче приводят к ошибке запроса, а не к тихому откату. Отдельно стоит знать, что флаг обходит внутреннюю защиту, из-за которой батчевая токенизация при `--enable-dp-attention` отправляет весь батч на первый ранг.

## Оригинальная справка

```text
Enable batch tokenization for improved performance when processing multiple text inputs. Do not use with image inputs, pre-tokenized input_ids, or input_embeds.
```

## Паспорт аргумента

- Флаги: `--enable-tokenizer-batch-encode`
- Группа: `serving`
- Тип значения: bool; поле объявлено как `bool`, argparse получает `action="store_true"`, парного `--no-*` нет
- Допустимые значения: флаг без значения
- Значение по умолчанию: `False`
- Эффективное значение: переопределяется в двух местах `__post_init__`. **Принудительно `True`** для моделей embedding-gemma в `_handle_model_specific_adjustments` — там же выключается radix cache и chunked prefill, а в комментарии сказано, что список эмбеддингов должен уходить атомарно, иначе BCG начнет обрабатывать нулевой элемент, пока остальные еще токенизируются. **Принудительно `False`** при `--skip-tokenizer-init` (предупреждение `skip_tokenizer_init=True ignores --enable-tokenizer-batch-encode; disabling it.`)
- Где объявлен: `ServerArgs.enable_tokenizer_batch_encode`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (`_handle_model_specific_adjustments`, `_handle_tokenizer_batching`) → HTTP-слой, обработка каждого batch-запроса в `TokenizerManager._handle_batch_request`

## Что меняет в движке

Решение принимается в `_should_use_batch_tokenization` (`managers/tokenizer_manager.py`):

```python
return batch_size > 0 and (
    self.server_args.enable_tokenizer_batch_encode
    or (
        (not self.server_args.enable_dp_attention)
        and (not self._batch_has_text(batch_size, requests))
    )
)
```

То есть батчевый путь включается либо явно этим флагом, либо автоматически, когда в батче вообще нет текста (все запросы уже пришли с `input_ids`/`input_embeds`) **и** не включен DP-attention. Комментарий к функции прямо говорит: «Batch tokenization does not support DP attention yet, and it will make everything goes to the first rank currently». Явный флаг эту оговорку обходит — это и есть его главный побочный эффект.

Дальше `_batch_tokenize_and_process`:

1. если в батче нет текста, каждый элемент проходит обычный одиночный путь;
2. иначе вызывается `_validate_batch_tokenization_constraints`, который по каждому элементу бросает `ValueError` при мультимодальном входе, при заданных `input_ids` и при заданных `input_embeds` — тексты сообщений прямо советуют не задавать флаг;
3. все тексты собираются в список и токенизируются одним вызовом `_tokenize_texts`;
4. результаты раскладываются обратно по запросам, каждый проверяется `_validate_one_request`, затем весь набор уходит планировщику одним `_send_batch_request`.

Важная деталь производительности: `_tokenize_texts` сам ветвится по `is_fast`. Если токенизатор медленный (`--tokenizer-mode slow`), список все равно разбирается питоновским циклом, и флаг не дает ничего.

## Значения и формат

- Флаг без значения.
- Действует только на запросы с `batch_size > 1` и только когда `parallel_sample_num == 1`: путь `_handle_batch_request` с батчевой токенизацией выбирается именно в этой ветке.
- Взаимно исключающий с `--enable-dynamic-batch-tokenizer`: `_handle_tokenizer_batching` бросает `ValueError: Cannot enable both --enable-tokenizer-batch-encode and --enable-dynamic-batch-tokenizer. Please choose one tokenizer batching approach.`
- Отменить принудительное включение для embedding-gemma нельзя.

## Когда использовать

- Эмбеддинги и классификация: типичная нагрузка — один запрос со списком из десятков и сотен коротких текстов. Здесь выигрыш наибольший, потому что токенизация занимает существенную долю времени обработки.
- Оффлайн-переработка корпуса батчами через `/generate` со списком текстов.
- **Не** включайте на мультимодальной нагрузке — получите `ValueError: For multimodal input processing do not set 'enable_tokenizer_batch_encode'.` на каждом батче с картинкой.
- **Не** включайте, если клиенты присылают готовые `input_ids` в батче: `Batch tokenization is not needed for pre-tokenized input_ids.`
- **Не** включайте вместе с `--enable-dp-attention`, если не готовы к тому, что батч целиком уйдет на первый ранг, обнулив выигрыш от DP.
- Не путайте с ускорением обычного чат-трафика: `/v1/chat/completions` шлет по одному запросу, и этот флаг на него не действует.

## Влияние на производительность и память

- **CPU и latency:** один вызов быстрого токенизатора вместо N. На батче из 100 коротких текстов это разница в разы по времени токенизации; на батче из двух — в пределах шума.
- **RAM:** все тексты батча и результаты токенизации держатся в памяти одновременно. Для батча из тысяч длинных текстов это заметный пик в HTTP-процессе.
- **VRAM:** не затрагивается напрямую. Косвенно — батч уходит планировщику одним `_send_batch_request`, поэтому все элементы попадают в очередь одновременно и конкурируют за KV-пул.
- **Throughput при DP-attention:** может **упасть**, потому что весь батч оседает на первом ранге.

## Взаимодействие с другими аргументами

- `--enable-dynamic-batch-tokenizer`: взаимоисключающие, `ValueError` на старте. Разница по смыслу: этот флаг батчит входы **внутри одного запроса**, тот — **между разными запросами**.
- `--skip-tokenizer-init`: принудительно выключает флаг с предупреждением.
- `--enable-dp-attention`: флаг снимает защиту, из-за которой батч уходит на первый ранг.
- `--tokenizer-mode slow`: выигрыш пропадает — батч разбирается циклом.
- `--enable-multimodal`: батч с мультимодальным входом отвергается.
- `--is-embedding`: типовой сценарий применения.
- `--disable-tokenizer-batch-decode`: зеркальный аргумент на стороне детокенизации, независимый.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: Cannot enable both --enable-tokenizer-batch-encode and --enable-dynamic-batch-tokenizer.` **Лечение:** выбрать один подход.
- **Симптом:** `ValueError: For multimodal input processing do not set 'enable_tokenizer_batch_encode'.` **Причина:** в батче есть изображение. **Лечение:** снять флаг.
- **Симптом:** `ValueError: Batch tokenization is not needed for pre-tokenized input_ids. Do not set 'enable_tokenizer_batch_encode'.` **Причина:** клиент прислал `input_ids`. **Замечание:** без флага такой батч и так пойдет батчевым путем автоматически — флаг здесь только мешает.
- **Симптом:** при DP-attention нагрузка перекосилась на первый ранг. **Причина:** флаг обошел защиту в `_should_use_batch_tokenization`. **Проверка:** сравнить занятость рангов в `/v1/loads`.
- **Симптом:** флаг задан, а выигрыша нет. **Причины:** клиенты шлют по одному входу на запрос (флаг не действует); либо `--tokenizer-mode slow`.
- **Симптом:** флаг включился сам. **Причина:** модель embedding-gemma. **Подтверждение:** `enable_tokenizer_batch_encode=True` в дампе `server_args=` при незаданном аргументе.

## В arriero

На основной поток менеджера флаг не влияет. Прокси arriero форвардит запросы OpenAI-совместимого чата и Anthropic-моста поштучно — одно тело запроса, один вход (`docs/API_PROXY_FOUNDATION.md`); батчевого пути `/generate` со списком текстов в этом тракте нет. Профиль KTransformers (`docs/KTRANSFORMERS_OPERATIONS.md`) — генеративный, не эмбеддинговый.

Ключ не зарезервирован за конфигурацией движка и будет принят схемой инстанса, но выигрыша не даст: включать его для инстанса kind `ktransformers` незачем.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/bge-m3 --is-embedding --enable-tokenizer-batch-encode --host 127.0.0.1 --port 30000
```

```bash
curl -sS http://127.0.0.1:30000/v1/embeddings -H 'Content-Type: application/json' -d '{"model": "bge-m3", "input": ["первый текст", "второй текст", "третий текст"]}'
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/managers/tokenizer_manager.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
- arriero: `docs/API_PROXY_FOUNDATION.md`, `docs/KTRANSFORMERS_OPERATIONS.md`
