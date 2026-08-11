---
schema: 1
engine: sglang
primaryName: "--speculative-ngram-max-trie-depth"
title: "--speculative-ngram-max-trie-depth"
summary: Максимальная длина n-граммы, которую хранит и ищет черновик NGRAM. Задаёт и окно вставки, и глубину поиска совпадений, и знаменатель формулы ширины BFS; стоимость вставки растёт квадратично.
group: spec
related:
  - --speculative-algorithm
  - --speculative-ngram-capacity
  - --speculative-ngram-min-bfs-breadth
  - --speculative-ngram-max-bfs-breadth
  - --speculative-ngram-match-type
  - --speculative-num-draft-tokens
---

# --speculative-ngram-max-trie-depth

## Кратко

`--speculative-ngram-max-trie-depth` — единственный параметр, задающий «длину контекста» n-gram-черновика. Он ограничивает сразу четыре вещи: сколько последних токенов запроса попадает в кеш на каждом шаге, на какую глубину вставляется каждый суффикс этого окна, до какой длины ищется совпадение с текущим хвостом (и в дереве, и во внешних суффиксных автоматах) и как быстро сужается ширина обхода в режиме `BFS`. Значение по умолчанию — 18 токенов.

## Оригинальная справка

```text
The max trie depth for ngram speculative decoding.
```

## Паспорт аргумента

- Флаги: `--speculative-ngram-max-trie-depth`
- Группа: `spec`
- Тип значения: int
- Допустимые значения: `choices` нет; C++-конструктор требует значение строго больше `1`
- Значение по умолчанию: `18`
- Эффективное значение: не переопределяется
- Где объявлен: `ServerArgs.speculative_ngram_max_trie_depth`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный; читается **только** при `--speculative-algorithm NGRAM`
- Этап применения: конструктор `NGRAMWorker` → конструктор C++-объекта `Ngram` (валидация) → каждый decode-шаг: подготовка окна, вставка, поиск

## Что меняет в движке

Четыре независимых роли одного числа:

1. **Окно, попадающее в кеш.** `NGRAMWorker._update_ngram_corpus` и `_prepare_draft_tokens` собирают хвост запроса через `_efficient_concat_last_n(origin_input_ids, output_ids[-max_trie_depth:] + prev_tokens, max_trie_depth)` — то есть ровно последние `max_trie_depth` токенов. Всё, что старше, в кеш не попадает и в качестве контекста поиска не используется.
2. **Глубина вставки.** `Trie::insert` для каждой позиции `i` окна вставляет суффикс длиной `min(len − i, max_trie_depth)`. Значит одно окно порождает до `O(len · max_trie_depth)` операций с хеш-таблицами, а при `len = max_trie_depth` — до `max_trie_depth²/2` посещений узлов (при глубине 18 это 171 операция на запрос на шаг, на фоновом потоке вставки).
3. **Глубина поиска.** `Trie::rebuildMatchState_` строит якоря для всех длин `d = 1 … min(len, max_trie_depth)`: для каждой длины отдельный спуск от корня. Инкрементальное продвижение (`advanceMatchState_`) на следующем шаге дешевле — оно двигает уже закешированные якоря, — но полное перестроение стоит `O(max_trie_depth²)`. Та же величина ограничивает окно сопоставления во внешних суффиксных автоматах (`SuffixAutomaton::match(..., param.max_trie_depth)`).
4. **Знаменатель ширины BFS.** В `buildRecency` используется `max_match_depth = max(1, max_trie_depth − 1)` и `scale = (max_bfs_breadth − min_bfs_breadth) / max_match_depth`. Стартовая ширина для якоря глубины `d` равна `(max_match_depth − d) · scale + min_bfs_breadth`, а на каждом уровне вглубь уменьшается на `scale`. Поэтому увеличение глубины при неизменных `min`/`max` делает ширину более пологой: дерево дольше остаётся широким.

Соответствие «узел дерева ↔ уникальная n-грамма длиной до `max_trie_depth`» и определяет, насколько быстро расходуется `--speculative-ngram-capacity`.

## Значения и формат

- Целое > 1. Значение `1` и меньше отвергается уже в C++: `param_.max_trie_depth must be greater than 1, current value: …`.
- Осмысленный диапазон — от 8 до 32. Значение по умолчанию 18 — компромисс апстрима.
- Глубина не связана с `--speculative-num-draft-tokens`: первая ограничивает длину **совпадения**, вторая — размер **предложения**. Предложение может быть длиннее совпадения и наоборот.
- Апстрим-документация в таблице ngram-параметров пишет, что при незаданном `--speculative-num-draft-tokens` он равен `min(--speculative-ngram-max-trie-depth, 12)`; в коде checkout'а `_handle_ngram` подставляет просто `12`. Ориентируйтесь на код.

## Когда использовать

- Увеличивать, когда трафик содержит длинные дословные повторы: код, JSON/структурированный вывод, цитирование входа, повторяющиеся преамбулы. Более длинное совпадение — более узкий и точный старт BFS, выше acceptance rate.
- Уменьшать, когда текст разнообразный: длинные суффиксы всё равно не совпадают, а вставка платит квадратично и быстрее выедает ёмкость.
- Не менять в отрыве от `--speculative-ngram-min-bfs-breadth` / `--speculative-ngram-max-bfs-breadth`: глубина входит в формулу ширины, и после её изменения прежние границы ведут себя иначе.
- Не рассчитывать, что глубина увеличит длину предложения — за это отвечает `--speculative-num-draft-tokens`.

## Влияние на производительность и память

- RAM хоста: напрямую не выделяет ничего, но определяет скорость расходования пула из `--speculative-ngram-capacity`: чем глубже, тем больше уникальных узлов на тот же поток токенов и тем чаще вытеснение.
- CPU, вставка: `O(окно × глубина)` операций на запрос на decode-шаг, выполняется на отдельном фоновом потоке (`Ngram::insertWorker`), но под общим мьютексом с поиском — то есть конкурирует с ним.
- CPU, поиск: полное перестроение состояния — `O(глубина²)` спусков; в установившемся режиме работает инкрементальное продвижение `O(добавленных токенов × глубина)`. Поиск идёт синхронно в шаге планировщика, на весь батч сразу.
- GPU: не влияет — ни размер верификационного батча, ни маска дерева от глубины не зависят.
- Latency: рост глубины виден как удорожание CPU-части decode-шага; на большом батче это может съесть выигрыш от спекуляции.

## Взаимодействие с другими аргументами

- `--speculative-ngram-capacity`: глубина определяет расход узлов; увеличивая одно, обычно приходится увеличивать и другое.
- `--speculative-ngram-min-bfs-breadth` / `--speculative-ngram-max-bfs-breadth`: вместе с глубиной задают линейную интерполяцию ширины BFS.
- `--speculative-ngram-match-type`: в `PROB` глубина влияет только на поиск якорей, формула ширины там не используется.
- `--speculative-num-draft-tokens`: независимый параметр — бюджет узлов предложения.
- `--speculative-ngram-external-corpus-path`: та же глубина ограничивает окно сопоставления во внешних суффиксных автоматах.
- `--speculative-algorithm`: вне `NGRAM` аргумент не читается.

## Типовые проблемы и диагностика

- `std::runtime_error: param_.max_trie_depth must be greater than 1, current value: 1` — значение слишком мало.
- Резкий рост потребления узлов и учащение вытеснения после увеличения глубины — ожидаемо; поднимите `--speculative-ngram-capacity`.
- Latency шага выросла, `accept len` не изменился — глубина увеличена там, где длинных повторов нет. Верните прежнее значение.
- Ширина дерева «изменилась сама» после правки глубины — так и есть: `scale` зависит от глубины. Перепроверьте `--speculative-ngram-min-bfs-breadth` / `--speculative-ngram-max-bfs-breadth`.
- Чем подтвердить: дамп `server_args=` при старте; эффект — `accept len` / `accept rate` в строках `Decode batch` и время decode-шага.

## Примеры

```bash
python -m sglang.launch_server --model-path Qwen/Qwen2.5-7B-Instruct --speculative-algorithm NGRAM --speculative-num-draft-tokens 16 --speculative-ngram-max-trie-depth 24 --speculative-ngram-capacity 2000000
```

```bash
python -m sglang.launch_server --model-path Qwen/Qwen2.5-7B-Instruct --speculative-algorithm NGRAM --speculative-num-draft-tokens 12 --speculative-ngram-max-trie-depth 12 --speculative-ngram-max-bfs-breadth 6 --speculative-ngram-capacity 500000
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/speculative/ngram_worker.py`
- `sglang/python/sglang/srt/speculative/cpp_ngram/ngram_corpus.py`
- `sglang/python/sglang/kernels/jit/csrc/ngram_corpus/ngram.cpp`
- `sglang/python/sglang/kernels/jit/csrc/ngram_corpus/trie.cpp`
- `sglang/python/sglang/kernels/jit/csrc/ngram_corpus/suffix_automaton.cpp`
- `sglang/docs/docs/advanced_features/speculative_decoding.mdx`
