---
schema: 1
engine: sglang
primaryName: "--speculative-ngram-match-type"
title: "--speculative-ngram-match-type"
summary: Выбирает алгоритм построения чернового дерева из n-gram-кеша: `BFS` разворачивает продолжения по свежести с шириной, зависящей от длины совпадения, `PROB` — по частоте, с глобальной жадностью по вероятности пути.
group: spec
related:
  - --speculative-algorithm
  - --speculative-ngram-min-bfs-breadth
  - --speculative-ngram-max-bfs-breadth
  - --speculative-ngram-max-trie-depth
  - --speculative-ngram-capacity
  - --speculative-num-draft-tokens
---

# --speculative-ngram-match-type

## Кратко

Под `--speculative-algorithm NGRAM` черновик берётся не из модели, а из host-структуры: префиксного дерева, куда складываются хвосты уже обработанных запросов. `--speculative-ngram-match-type` определяет, как из найденных совпадений собирается дерево-предложение: `BFS` — обход в ширину, где дети узла берутся в порядке «кто встречался позже», а ширина рассчитывается от длины совпавшего суффикса; `PROB` — жадный обход по глобальной куче, где приоритет узла равен произведению нормированных частот вдоль пути. Это единственный аргумент n-gram-семейства, который меняет сам алгоритм, а не его границы.

## Оригинальная справка

```text
The match type for cache tree.
```

## Паспорт аргумента

- Флаги: `--speculative-ngram-match-type`
- Группа: `spec`
- Тип значения: строка. Поле объявлено как `Literal["BFS", "PROB"]`, поэтому argparse получает `choices` и обычный `type=str`
- Допустимые значения: `BFS`, `PROB` — регистрозависимо, `bfs` argparse отвергнет
- Значение по умолчанию: `BFS`
- Эффективное значение: не переопределяется
- Где объявлен: `ServerArgs.speculative_ngram_match_type`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный; читается **только** при `--speculative-algorithm NGRAM`, в остальных конфигурациях инертен
- Этап применения: конструктор `NGRAMWorker` → конструктор C++-объекта `Ngram` → каждый вызов `batchMatch` на decode-шаге

## Что меняет в движке

Значение уходит в `NgramCorpus(match_type=...)` (`sglang/python/sglang/srt/speculative/cpp_ngram/ngram_corpus.py`) и дальше в C++-объект. В `Ngram::batchMatch` (`sglang/python/sglang/kernels/jit/csrc/ngram_corpus/ngram.cpp`) оно выбирает пару функций построения — для локального дерева и для внешних суффиксных автоматов:

- `BFS` → `Trie::buildRecency` / `SuffixAutomaton::buildRecency`;
- `PROB` → `Trie::buildFrequency` / `SuffixAutomaton::buildFrequency`;
- любое другое значение → `std::runtime_error: Unknown match_type: '…'. Must be 'BFS' or 'PROB'.`

**`BFS` (recency).** Для каждого якоря — совпавшего суффикса глубины `d` — заводится очередь, стартовая ширина считается как
`(max_match_depth − d) · scale + min_bfs_breadth`, где `max_match_depth = max(1, max_trie_depth − 1)` и `scale = (max_bfs_breadth − min_bfs_breadth) / max_match_depth`. То есть чем длиннее совпадение, тем уже старт (у самого длинного — ровно `--speculative-ngram-min-bfs-breadth`), чем короче — тем ближе к `--speculative-ngram-max-bfs-breadth`. На каждом уровне вглубь ширина уменьшается на `scale` и не опускается ниже `1`. Дети узла перебираются в порядке его LRU-списка, то есть «самый недавно виденный первым». Якоря обходятся от самого глубокого к самому мелкому, так что бюджет узлов достаётся сначала наиболее специфичным совпадениям.

**`PROB` (frequency).** Никакой ширины по уровням: у каждого узла берутся первые `--speculative-ngram-max-bfs-breadth` детей из `sorted_children` (упорядочены по убыванию частоты), их частоты нормируются на сумму по этой же верхушке, и произведение нормированных частот вдоль пути кладётся в общую max-кучу. Дальше дерево растёт жадно: каждый раз разворачивается самый вероятный узел из кучи, пока не исчерпан бюджет. `--speculative-ngram-min-bfs-breadth` в этом режиме **не используется вообще** — он лишь проверяется на `0 < min ≤ max` при создании объекта.

В обоих режимах бюджет узлов один и тот же: `speculative_num_draft_tokens − 1` (за вычетом того, что отдано внешним корпусам через `--speculative-ngram-external-sam-budget`), а результат добивается нулями до фиксированной длины.

## Значения и формат

- `BFS` — значение по умолчанию и то, на котором построены примеры апстрима. Ставка на свежесть: недавно виденное продолжение считается более вероятным.
- `PROB` — ставка на частоту: продолжение, встречавшееся чаще, идёт первым, а форма дерева подстраивается под распределение (уверенная ветка вытянется в длинную цепочку, неуверенная — в куст).
- Значение проверяется дважды: argparse по `choices` и Python-обёртка FFI (`_MATCH_TYPE_MAP`) — она отвергает всё, кроме этих двух строк.
- На аргументы `--speculative-ngram-*` вне NGRAM ничего не влияет: `NGRAMWorker` создаётся только при `--speculative-algorithm NGRAM`.

## Когда использовать

- `BFS` — для интерактивного локального сервера, где кеш наполняется текущим диалогом: последние ответы важнее статистики за час.
- `PROB` — когда трафик однородный и повторяющийся (шаблонные ответы, structured output, длинные фиксированные преамбулы), а кеш успевает накопить статистику. Форма дерева тогда лучше отражает реальную неопределённость и меньше тратит бюджет на маловероятные ветки.
- Не переключаться на `PROB` в надежде «починить» низкий acceptance rate на неповторяющемся тексте: если n-gram-совпадений нет, никакой порядок обхода их не создаст.
- Помните, что при `PROB` изменение `--speculative-ngram-min-bfs-breadth` перестаёт влиять на что-либо.

## Влияние на производительность и память

- Память: не влияет — обе функции строят дерево того же фиксированного размера (`--speculative-num-draft-tokens` узлов) в тех же предвыделенных тензорах.
- CPU: `PROB` дороже. `BFS` идёт по готовому LRU-списку узла; `PROB` на каждом развороте суммирует частоты первых `max_bfs_breadth` детей из `std::multiset` и делает вставки в `std::priority_queue`. Работа выполняется на потоке планировщика при каждом decode-шаге для всего батча, поэтому на большом батче разница видна в latency шага.
- GPU: не влияет; предложенные токены и маска дерева передаются на устройство одинаково.
- Acceptance rate: собственно то, ради чего аргумент существует. Измерять по строкам `Decode batch, … accept len: …, accept rate: …`.

## Взаимодействие с другими аргументами

- `--speculative-ngram-min-bfs-breadth`: участвует только в `BFS`.
- `--speculative-ngram-max-bfs-breadth`: в `BFS` — верхняя граница ширины, в `PROB` — top-k детей на узел. И в обоих случаях этим же значением перезаписывается `--speculative-eagle-topk`.
- `--speculative-ngram-max-trie-depth`: задаёт знаменатель `max_match_depth` в формуле ширины `BFS` и глубину поиска якорей в обоих режимах.
- `--speculative-num-draft-tokens`: бюджет узлов дерева, общий для обоих режимов.
- `--speculative-ngram-capacity`: чем больше кеш, тем больше кандидатов у обоих алгоритмов.
- `--speculative-ngram-external-corpus-path`: тот же выбор применяется к внешним суффиксным автоматам.

## Типовые проблемы и диагностика

- `argument --speculative-ngram-match-type: invalid choice: 'bfs'` — регистр. Только `BFS` и `PROB`.
- `Unknown match_type: '…'. Must be 'BFS' or 'PROB'.` — та же ошибка, но из Python-обёртки FFI (возможна при программном запуске в обход CLI).
- Переключение на `PROB` не изменило поведение при `--speculative-ngram-max-bfs-breadth 1` — при ширине 1 оба алгоритма вырождаются в одну цепочку.
- Изменение `--speculative-ngram-min-bfs-breadth` «ничего не даёт» — проверьте, не стоит ли `PROB`.
- Чем подтвердить: дамп `server_args=` при старте (`sglang/python/sglang/srt/entrypoints/engine.py`) — поле `speculative_ngram_match_type`; эффект — по `accept len` / `accept rate` в строках `Decode batch`.

## Примеры

```bash
python -m sglang.launch_server --model-path Qwen/Qwen2.5-7B-Instruct --speculative-algorithm NGRAM --speculative-num-draft-tokens 16 --speculative-ngram-match-type PROB --speculative-ngram-max-bfs-breadth 8
```

```bash
python -m sglang.launch_server --model-path Qwen/Qwen2.5-7B-Instruct --speculative-algorithm NGRAM --speculative-num-draft-tokens 12 --speculative-ngram-match-type BFS --speculative-ngram-min-bfs-breadth 1 --speculative-ngram-max-bfs-breadth 10 --mem-fraction-static 0.7
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/speculative_hook.py`
- `sglang/python/sglang/srt/speculative/ngram_worker.py`
- `sglang/python/sglang/srt/speculative/cpp_ngram/ngram_corpus.py`
- `sglang/python/sglang/kernels/ops/speculative/ngram_corpus.py`
- `sglang/python/sglang/kernels/jit/csrc/ngram_corpus/ngram.cpp`
- `sglang/python/sglang/kernels/jit/csrc/ngram_corpus/trie.cpp`
- `sglang/python/sglang/kernels/jit/csrc/ngram_corpus/suffix_automaton.cpp`
- `sglang/docs/docs/advanced_features/speculative_decoding.mdx`
