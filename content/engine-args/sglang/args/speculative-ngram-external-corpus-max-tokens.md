---
schema: 1
engine: sglang
primaryName: "--speculative-ngram-external-corpus-max-tokens"
title: "--speculative-ngram-external-corpus-max-tokens"
summary: Потолок суммарного объёма внешних n-gram-корпусов в токенах. Превышение при старте валит запуск, при загрузке через HTTP — либо валит запрос, либо обрезает корпус. Ничего не выделяет: это защита host-памяти, а не резервирование.
group: spec
related:
  - --speculative-algorithm
  - --speculative-ngram-external-corpus-path
  - --speculative-ngram-external-sam-budget
  - --speculative-ngram-capacity
---

# --speculative-ngram-external-corpus-max-tokens

## Кратко

Внешний корпус n-gram-черновика превращается в суффиксный автомат в host-памяти и никогда не вытесняется. `--speculative-ngram-external-corpus-max-tokens` — единственный предохранитель против того, чтобы слишком большой файл (или слишком много корпусов, добавленных на ходу) съел RAM хоста. Значение по умолчанию — 10 000 000 токенов, что соответствует автомату в несколько ГиБ и заведомо больше, чем стоит держать на локальном сервере. Аргумент ничего не выделяет заранее: это верхняя граница, которая проверяется в момент загрузки.

## Оригинальная справка

```text
Fail startup if the tokenized external ngram corpus exceeds this many tokens. Tune this based on your CPU memory budget.
```

## Паспорт аргумента

- Флаги: `--speculative-ngram-external-corpus-max-tokens`
- Группа: `spec`
- Тип значения: int (число токенов)
- Допустимые значения: `choices` нет; при заданном `--speculative-ngram-external-corpus-path` обязано быть строго положительным
- Значение по умолчанию: `10000000`
- Эффективное значение: не переопределяется
- Где объявлен: `ServerArgs.speculative_ngram_external_corpus_max_tokens`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный; читается **только** при `--speculative-algorithm NGRAM`
- Этап применения: `_handle_ngram` (проверка положительности) → конструктор `NGRAMWorker` (стартовая загрузка) → каждая загрузка через `POST /add_external_corpus`

## Что меняет в движке

Лимит применяется в трёх местах:

1. **Стартовая загрузка из файла.** `iter_external_corpus_chunks` (`sglang/python/sglang/srt/speculative/cpp_ngram/external_corpus.py`) складывает длины токенизированных документов (плюс один токен-разделитель между ними) и при превышении бросает `ValueError: External ngram corpus exceeds the configured token limit (N) at line M after loading K tokens.` Исключение поднимается из конструктора `NGRAMWorker`, то есть сервер не стартует.
2. **Общий бюджет всех корпусов.** `NgramCorpus.remaining_token_budget` — это `external_corpus_max_tokens − total_loaded_tokens`, где `total_loaded_tokens` накапливается по всем успешно загруженным корпусам и уменьшается при `POST /remove_external_corpus`. Именно остаток передаётся в C++-загрузчик; при исчерпании — `External ngram corpus exceeds the remaining token budget (N) after loading K tokens.` В комментарии кода отмечено, что остаток считается один раз на загрузку и потому может быть заниженным (консервативным), если параллельно шли удаления.
3. **Загрузка через HTTP.** `TokenizerManager.add_external_corpus` (`sglang/python/sglang/srt/managers/tokenizer_control_mixin.py`) ведёт себя по-разному в зависимости от формы запроса: для `file_path` используется тот же `iter_external_corpus_chunks` и превышение приводит к ошибке; для списка `documents` документы просто **обрезаются** по достижении лимита, а в ответе выставляется признак усечения.

Само значение передаётся и в C++-объект (`Param::external_corpus_max_tokens`), где хранится как часть конфигурации, но решение о загрузке принимается на Python-стороне.

## Значения и формат

- Целое число токенов target-токенизатора, не байт и не строк файла.
- Учитываются и токены-разделители между документами (по одному на каждый документ, кроме первого).
- Лимит общий на все корпуса сразу, а не на каждый.
- Значение имеет смысл только вместе с `--speculative-ngram-external-corpus-path` либо с последующими вызовами `POST /add_external_corpus`; без внешних корпусов оно не проверяется и ни на что не влияет.
- Ориентир для расчёта: суффиксный автомат по структуре занимает порядка 0.4–0.5 КиБ host-памяти на токен корпуса (до `2n` состояний по 128 байт плюс до `3n` переходов и по два вектора детей на состояние). То есть лимит в 1 000 000 токенов — это разрешение занять несколько сотен МиБ; лимит по умолчанию — разрешение занять несколько ГиБ.

## Когда использовать

- Всегда задавать явно, если вы вообще пользуетесь внешними корпусами: значение по умолчанию не защищает ни от чего практически значимого.
- Ставить чуть выше реального размера корпуса — тогда лимит работает как проверка «файл не разросся с прошлого раза».
- Поднимать только вместе с проверкой host-резерва инстанса. В arriero эта память входит в host-draw инстанса (`docs/RESOURCE_MANAGEMENT.md`), и её превышение расходится с заявкой в ledger.
- Не использовать как способ «загрузить сколько влезет»: обрезка применяется только к варианту `documents` в HTTP-запросе; файл при превышении просто отвергается.

## Влияние на производительность и память

- RAM хоста: сам аргумент не выделяет ничего. Он ограничивает сверху объём, который займут автоматы. Фактическая память пропорциональна загруженным токенам, а не лимиту.
- Время старта: косвенно — чем больше разрешено загрузить, тем дольше может идти стартовая токенизация и построение автомата.
- CPU и VRAM под нагрузкой: не влияет.
- Acceptance rate: не влияет напрямую; влияет только через то, поместился корпус или нет.

## Взаимодействие с другими аргументами

- `--speculative-ngram-external-corpus-path`: при заданном пути лимит обязан быть положительным, иначе `ValueError` на старте.
- `--speculative-ngram-external-sam-budget`: другая половина той же связки — сколько узлов предложения достаётся автоматам; тоже обязан быть положительным при заданном пути.
- `--speculative-ngram-capacity`: независимый пул узлов префиксного дерева; их объёмы складываются в общем потреблении host-памяти.
- `--speculative-algorithm`: вне `NGRAM` аргумент не читается.

## Типовые проблемы и диагностика

- `External ngram corpus exceeds the configured token limit (N) at line M after loading K tokens.` — стартовый файл больше лимита; поднимите лимит или сократите файл. `M` указывает строку, на которой лимит был исчерпан.
- `External ngram corpus exceeds the remaining token budget (N) after loading K tokens.` — исчерпан общий остаток при добавлении очередного корпуса на ходу; удалите ненужный корпус через `POST /remove_external_corpus`.
- `--speculative-ngram-external-corpus-max-tokens must be positive when --speculative-ngram-external-corpus-path is set.` — задан ноль или отрицательное значение.
- `External ngram corpus max tokens must be positive.` — та же проверка внутри `iter_external_corpus_chunks` (сработает и при вызове через HTTP).
- Корпус, добавленный через `POST /add_external_corpus` со списком `documents`, загрузился «не весь» — это штатное усечение по лимиту; проверьте фактические числа через `GET /list_external_corpora`.
- Чем подтвердить: дамп `server_args=` при старте, строка `Loaded external ngram corpus '<path>' (<N> tokens).` и вывод `GET /list_external_corpora` (число токенов на каждый корпус).

## Примеры

```bash
python -m sglang.launch_server --model-path Qwen/Qwen2.5-7B-Instruct --speculative-algorithm NGRAM --speculative-num-draft-tokens 16 --speculative-ngram-external-corpus-path /srv/corpora/templates.jsonl --speculative-ngram-external-sam-budget 4 --speculative-ngram-external-corpus-max-tokens 200000
```

```bash
python -m sglang.launch_server --model-path Qwen/Qwen2.5-7B-Instruct --speculative-algorithm NGRAM --speculative-num-draft-tokens 12 --speculative-ngram-external-corpus-path /srv/corpora/handbook.jsonl --speculative-ngram-external-sam-budget 2 --speculative-ngram-external-corpus-max-tokens 1000000 --speculative-ngram-capacity 500000
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/speculative_hook.py`
- `sglang/python/sglang/srt/speculative/cpp_ngram/external_corpus.py`
- `sglang/python/sglang/srt/speculative/cpp_ngram/ngram_corpus.py`
- `sglang/python/sglang/kernels/ops/speculative/ngram_corpus.py`
- `sglang/python/sglang/srt/managers/tokenizer_control_mixin.py`
- `sglang/python/sglang/kernels/jit/csrc/ngram_corpus/param.h`
- `sglang/python/sglang/kernels/jit/csrc/ngram_corpus/suffix_automaton.h`
- arriero: `docs/RESOURCE_MANAGEMENT.md`
