---
schema: 1
engine: sglang
primaryName: "--speculative-ngram-external-corpus-path"
title: "--speculative-ngram-external-corpus-path"
summary: JSONL-файл, который при старте токенизируется и загружается в суффиксный автомат — второй, невытесняемый источник черновых предложений для NGRAM. Помогает только там, где ответы дословно повторяют текст корпуса.
group: spec
related:
  - --speculative-algorithm
  - --speculative-ngram-external-sam-budget
  - --speculative-ngram-external-corpus-max-tokens
  - --speculative-ngram-match-type
  - --speculative-ngram-max-trie-depth
  - --speculative-num-draft-tokens
---

# --speculative-ngram-external-corpus-path

## Кратко

По умолчанию черновик `--speculative-algorithm NGRAM` знает только то, что уже прошло через сервер. `--speculative-ngram-external-corpus-path` добавляет второй источник: JSONL-файл документов, который при старте токенизируется токенизатором target-модели и строится в суффиксный автомат (SAM). SAM не вытесняется и живёт параллельно префиксному дереву; на каждом decode-шаге он получает фиксированную долю бюджета узлов предложения (`--speculative-ngram-external-sam-budget`), отнимая её у дерева. Это узкоспециальная оптимизация: она окупается только когда модель дословно воспроизводит фрагменты корпуса.

## Оригинальная справка

```text
Path to an external JSONL corpus to pre-load into SAM at startup. Additional corpora can be added at runtime via POST /add_external_corpus.
```

## Паспорт аргумента

- Флаги: `--speculative-ngram-external-corpus-path`
- Группа: `spec`
- Тип значения: str — путь к существующему локальному файлу
- Допустимые значения: `choices` нет
- Значение по умолчанию: `null` — внешнего корпуса нет
- Эффективное значение: не переопределяется; при заданном пути `_handle_ngram` дополнительно требует, чтобы `--speculative-ngram-external-sam-budget` и `--speculative-ngram-external-corpus-max-tokens` были положительными, а бюджет не превышал `--speculative-num-draft-tokens − 1`
- Где объявлен: `ServerArgs.speculative_ngram_external_corpus_path`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный; читается **только** при `--speculative-algorithm NGRAM`
- Этап применения: `handle_speculative_decoding` → `_handle_ngram` (валидация связки аргументов) → конструктор `NGRAMWorker` (чтение файла, токенизация, построение SAM — блокирует старт)

## Что меняет в движке

`NGRAMWorker.__init__` (`sglang/python/sglang/srt/speculative/ngram_worker.py`) при заданном пути вызывает `iter_external_corpus_chunks` и полностью материализует результат (`list(...)`), затем `add_external_corpus` + `commit_corpus_load` и пишет в лог `Loaded external ngram corpus '<path>' (<N> tokens).`

`iter_external_corpus_chunks` (`sglang/python/sglang/srt/speculative/cpp_ngram/external_corpus.py`):

- проверяет, что путь — существующий файл, иначе `ValueError: External ngram corpus path does not exist: …`;
- читает построчно; пустые строки пропускает; каждая непустая строка разбирается как JSON и **обязана быть JSON-строкой** — объект, массив или число дают `ValueError: Invalid external ngram corpus record at line N: expected a JSON string.`;
- токенизирует документ через токенизатор target-воркера с `add_special_tokens=False`;
- между документами вставляет разделитель `SEPARATOR_TOKEN = −2³¹` (он же `SuffixAutomaton::kSeparatorToken`), чтобы совпадения не «перетекали» из одного документа в другой;
- режет поток на куски по 4096 токенов и следит за суммарным лимитом `--speculative-ngram-external-corpus-max-tokens`.

C++-сторона (`sglang/python/sglang/kernels/jit/csrc/ngram_corpus/suffix_automaton.cpp`) строит классический суффиксный автомат: `appendTokens` расширяет его по токену, `finalize` считает частоты вхождений и позиции последнего вхождения по suffix-link'ам и заранее сортирует детей каждого состояния дважды — по частоте (`children_by_freq`) и по свежести (`children_by_recency`). Готовый автомат кладётся в словарь `sams_` под своим `corpus_id` (для стартового корпуса это сам путь).

На каждом decode-шаге `Ngram::batchMatch` делит бюджет узлов: `total = min(external_sam_budget, num_draft_tokens − 1)`, `per_sam = total / число корпусов`, а дереву остаётся `(num_draft_tokens − 1) − per_sam · число корпусов`. Если `per_sam` оказывается нулём, SAM'ы пропускаются целиком. Результаты дерева и каждого автомата объединяются `combineRootResults_`. Совпадение в SAM ищется по тем же правилам, что и в дереве, с окном `--speculative-ngram-max-trie-depth`, и строится тем же алгоритмом (`BFS` или `PROB`), что задан `--speculative-ngram-match-type`.

Дополнительные корпуса добавляются на ходу: `POST /add_external_corpus` (`file_path` или список `documents` плюс `corpus_id`), `POST /remove_external_corpus`, `GET /list_external_corpora` (`sglang/python/sglang/srt/entrypoints/http_server.py`). Загрузка идёт в фоновом потоке, одновременно допускается только одна: вторая получает `Another corpus load is already in progress.`

## Значения и формат

- Формат файла — JSONL, где каждая строка это **строковый** JSON-литерал:

  ```json
  "def parse_config(path: str) -> Config:"
  "Данный документ описывает порядок эксплуатации …"
  ```

  Строки-объекты вида `{"text": "..."}` не поддерживаются.
- Путь должен существовать на момент старта; никакой загрузки из Hugging Face здесь нет (в отличие от `--speculative-token-map`).
- Корпус токенизируется токенизатором target-модели: файл, подготовленный для другой модели, формально загрузится, но совпадения будут искаться в чужих идентификаторах — практической пользы не будет.
- Пустой после токенизации корпус отвергается: `External corpus is empty — no tokens were loaded.`
- Идентификатор стартового корпуса — сам путь; повторно загрузить корпус с тем же id нельзя (`External corpus '…' already exists.`).

## Когда использовать

- Когда ответы дословно воспроизводят фиксированный текст: справочник, набор шаблонов, схема/грамматика, повторяющиеся куски кода, RAG-контекст, который подставляется в каждый запрос.
- Когда сервер только запустился и локальное дерево ещё пустое — корпус даёт предложения с первого запроса.
- **Не** использовать для «общего улучшения качества»: SAM предлагает продолжения, встречавшиеся в корпусе, а не правдоподобные; на свободной генерации совпадения будут случайными, а отданные ему `per_sam` узлов гарантированно потеряны для локального дерева, у которого предложения обычно лучше.
- Не загружать большой корпус «на всякий случай»: он занимает host-память постоянно, никогда не вытесняется и удлиняет старт.
- Перед включением измерьте базовый `accept rate` без корпуса — иначе не с чем сравнивать.

## Влияние на производительность и память

- RAM хоста: SAM держит до `2n` состояний на `n` токенов, `sizeof(SamState)` = 128 байт на x86-64 с libstdc++, плюс до `3n` переходов в хеш-таблицах и по два отсортированных вектора детей на состояние. По структуре это порядка 0.4–0.5 КиБ на токен корпуса (оценка по размерам полей, не измерение): корпус в один миллион токенов — сотни МиБ, которые складываются с пулом `--speculative-ngram-capacity`. Точную цифру снимайте по RSS процесса.
- RAM хоста, пик при загрузке: `list(iter_external_corpus_chunks(...))` материализует весь токенизированный корпус как Python-списки до передачи в C++ — на время старта это ещё десятки МиБ на миллион токенов.
- Время старта: чтение + токенизация всего файла + построение автомата выполняются синхронно в конструкторе воркера, до готовности сервера.
- CPU под нагрузкой: на каждом decode-шаге к поиску в дереве добавляется поиск в каждом автомате плюс слияние результатов.
- VRAM: не влияет — размер предложения и маска дерева определяются `--speculative-num-draft-tokens`.
- Acceptance rate: может как вырасти, так и упасть — узлы, отданные автомату, отбираются у локального дерева.

## Взаимодействие с другими аргументами

- `--speculative-ngram-external-sam-budget`: обязателен и должен быть положительным; определяет, сколько узлов предложения достаётся автоматам.
- `--speculative-ngram-external-corpus-max-tokens`: жёсткий лимит на суммарный объём загруженного; превышение — отказ старта.
- `--speculative-num-draft-tokens`: бюджет автомата не может превышать `num_draft_tokens − 1`.
- `--speculative-ngram-match-type`: тот же алгоритм построения применяется и к автомату.
- `--speculative-ngram-max-trie-depth`: ограничивает окно сопоставления в автомате так же, как в дереве.
- `--speculative-ngram-capacity`: независимая структура; их объёмы складываются.
- `--speculative-algorithm`: вне `NGRAM` аргумент не читается, а HTTP-ручки отвечают `Ngram speculative decoding is not enabled.`

## Типовые проблемы и диагностика

- `External ngram corpus path does not exist: …` — путь не найден на момент старта.
- `Invalid JSON in external ngram corpus at line N: …` / `Invalid external ngram corpus record at line N: expected a JSON string.` — формат файла: нужна строка-литерал на каждой строке.
- `External ngram corpus exceeds the configured token limit (N) at line M after loading K tokens.` — увеличьте `--speculative-ngram-external-corpus-max-tokens` или сократите корпус.
- `--speculative-ngram-external-sam-budget must be positive when --speculative-ngram-external-corpus-path is set.` — задайте бюджет.
- `speculative_ngram_external_sam_budget must be less than or equal to speculative_num_draft_tokens - 1 (N).` — бюджет больше размера дерева.
- `External corpus is empty — no tokens were loaded.` — файл есть, но после токенизации пуст.
- Старт заметно дольше и RSS вырос на сотни МиБ — это и есть автомат; уменьшите корпус.
- `accept rate` упал после подключения корпуса — узлы уходят автомату впустую; уменьшите `--speculative-ngram-external-sam-budget` или уберите корпус.
- Чем подтвердить загрузку: строка `Loaded external ngram corpus '<path>' (<N> tokens).` в стартовом логе и `GET /list_external_corpora` на работающем сервере.

## Примеры

```bash
python -m sglang.launch_server --model-path Qwen/Qwen2.5-7B-Instruct --speculative-algorithm NGRAM --speculative-num-draft-tokens 16 --speculative-ngram-external-corpus-path /srv/corpora/templates.jsonl --speculative-ngram-external-sam-budget 4
```

```bash
python -m sglang.launch_server --model-path Qwen/Qwen2.5-7B-Instruct --speculative-algorithm NGRAM --speculative-num-draft-tokens 12 --speculative-ngram-external-corpus-path /srv/corpora/handbook.jsonl --speculative-ngram-external-sam-budget 2 --speculative-ngram-external-corpus-max-tokens 500000 --speculative-ngram-capacity 500000
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/speculative_hook.py`
- `sglang/python/sglang/srt/speculative/ngram_worker.py`
- `sglang/python/sglang/srt/speculative/cpp_ngram/external_corpus.py`
- `sglang/python/sglang/srt/speculative/external_corpus_manager.py`
- `sglang/python/sglang/srt/managers/tokenizer_control_mixin.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/python/sglang/kernels/jit/csrc/ngram_corpus/suffix_automaton.h`
- `sglang/python/sglang/kernels/jit/csrc/ngram_corpus/suffix_automaton.cpp`
- `sglang/python/sglang/kernels/jit/csrc/ngram_corpus/ngram.cpp`
