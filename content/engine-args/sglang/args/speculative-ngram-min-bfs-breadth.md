---
schema: 1
engine: sglang
primaryName: "--speculative-ngram-min-bfs-breadth"
title: "--speculative-ngram-min-bfs-breadth"
summary: Нижняя граница ширины обхода в режиме `BFS`: столько продолжений берётся у самого длинного совпавшего суффикса. Значение по умолчанию `1` означает «на длинном совпадении строим цепочку, а не куст». В режиме `PROB` не используется.
group: spec
related:
  - --speculative-algorithm
  - --speculative-ngram-max-bfs-breadth
  - --speculative-ngram-match-type
  - --speculative-ngram-max-trie-depth
  - --speculative-num-draft-tokens
---

# --speculative-ngram-min-bfs-breadth

## Кратко

В режиме `--speculative-ngram-match-type BFS` ширина обхода не константа: она линейно интерполируется между `--speculative-ngram-min-bfs-breadth` и `--speculative-ngram-max-bfs-breadth` по длине совпавшего суффикса. Чем длиннее совпадение — тем ближе ширина к минимуму, потому что длинное совпадение считается уверенным и разветвлять его незачем. `--speculative-ngram-min-bfs-breadth` задаёт этот минимум и заодно нижнюю точку, к которой ширина сходится с каждым уровнем вглубь. При `--speculative-ngram-match-type PROB` аргумент не влияет ни на что, кроме проверки `0 < min ≤ max`.

## Оригинальная справка

```text
The minimum breadth for BFS (Breadth-First Search) in ngram speculative decoding.
```

## Паспорт аргумента

- Флаги: `--speculative-ngram-min-bfs-breadth`
- Группа: `spec`
- Тип значения: int
- Допустимые значения: `choices` нет; C++-конструктор требует `> 0` и `≤ --speculative-ngram-max-bfs-breadth`
- Значение по умолчанию: `1`
- Эффективное значение: не переопределяется
- Где объявлен: `ServerArgs.speculative_ngram_min_bfs_breadth`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный; читается **только** при `--speculative-algorithm NGRAM` и только в режиме `BFS`
- Этап применения: конструктор `NGRAMWorker` → конструктор C++-объекта `Ngram` (валидация) → каждый вызов `Trie::buildRecency` / `SuffixAutomaton::buildRecency` на decode-шаге

## Что меняет в движке

Формула из `Trie::buildRecency` (`sglang/python/sglang/kernels/jit/csrc/ngram_corpus/trie.cpp`), одинаковая для локального дерева и для внешних суффиксных автоматов:

```
max_match_depth = max(1, max_trie_depth − 1)
scale           = (max_bfs_breadth − min_bfs_breadth) / max_match_depth
breadth(d)      = (max_match_depth − d) · scale + min_bfs_breadth
```

`d` — длина совпавшего суффикса (якоря). При `d = max_match_depth` ширина равна ровно `min_bfs_breadth`; при `d = 1` она почти равна `max_bfs_breadth`. Дальше, спускаясь на каждый уровень дерева-предложения, значение уменьшается ещё на `scale`, а перед использованием берётся `max(1, (int)breadth)` — то есть округление вниз и жёсткий пол в один узел.

Практический смысл значения по умолчанию `1`: если совпал длинный контекст, черновик строит одну линейную цепочку продолжения (по LRU-порядку детей, то есть «как было в прошлый раз»), не тратя бюджет узлов на альтернативы. Поднимая минимум до 2–3, вы разрешаете ветвление даже на самых длинных совпадениях.

Якоря обходятся от самого глубокого к самому мелкому, и общий бюджет узлов (`--speculative-num-draft-tokens − 1` минус то, что отдано внешним корпусам) расходуется по порядку. То есть при большом минимуме глубокие якоря могут выесть весь бюджет, и до мелких дело не дойдёт.

## Значения и формат

- Целое ≥ 1.
- Должно быть `≤ --speculative-ngram-max-bfs-breadth`, иначе C++-конструктор бросает исключение при старте.
- `min == max` убирает интерполяцию: ширина становится константой на всех глубинах и на всех уровнях (с точностью до пола в 1).
- Значение не имеет эффекта при `--speculative-ngram-match-type PROB`: там перебираются top-`max_bfs_breadth` детей по частоте, а порядок разворота задаёт глобальная куча.

## Когда использовать

- Поднимать до 2–3, когда трафик содержит длинные повторяющиеся контексты, но с расходящимися продолжениями (например одинаковая преамбула и разные ответы): одной цепочки мало, нужно предложить альтернативу.
- Оставлять `1` в типовом случае: на длинном совпадении вероятность «как в прошлый раз» высока, и бюджет узлов полезнее отдать более мелким якорям.
- Не поднимать вместе с уменьшением `--speculative-num-draft-tokens`: бюджет узлов один, и широкий старт на глубоких якорях просто вытеснит остальные гипотезы.
- Не трогать при `PROB`.

## Влияние на производительность и память

- Память: не влияет — размер дерева-предложения фиксирован `--speculative-num-draft-tokens`, тензоры предвыделены.
- CPU: слегка увеличивает работу построения (больше узлов в очереди BFS), но бюджет всё равно ограничен сверху.
- GPU: не влияет.
- Acceptance rate: собственно цель. Больший минимум даёт больше вариантов на глубоких совпадениях, но каждый вариант отбирает узел у других якорей — эффект нужно измерять, а не предполагать.

## Взаимодействие с другими аргументами

- `--speculative-ngram-max-bfs-breadth`: верхняя точка той же интерполяции; должно выполняться `min ≤ max`. Кроме того, максимум перезаписывает `--speculative-eagle-topk`, а минимум — нет.
- `--speculative-ngram-max-trie-depth`: знаменатель `max_match_depth`; изменение глубины меняет наклон интерполяции при неизменных границах.
- `--speculative-ngram-match-type`: значение читается только в `BFS`.
- `--speculative-num-draft-tokens`: общий бюджет узлов, за который конкурируют все якоря.
- `--speculative-ngram-external-sam-budget`: уменьшает бюджет, доступный локальному дереву.
- `--speculative-algorithm`: вне `NGRAM` аргумент не читается.

## Типовые проблемы и диагностика

- `std::runtime_error: min_bfs_breadth must be greater than 0, current value: 0` — задан ноль.
- `std::runtime_error: min_bfs_breadth must be less than or equal to max_bfs_breadth, current min_bfs_breadth: …, max_bfs_breadth: …` — границы переставлены местами.
- Изменение значения ничего не дало — проверьте `--speculative-ngram-match-type`: в `PROB` оно не используется.
- `accept rate` упал после подъёма минимума — бюджет узлов перераспределился в пользу глубоких якорей; верните `1` или увеличьте `--speculative-num-draft-tokens`.
- Чем подтвердить: дамп `server_args=` при старте; эффект — по `accept len` / `accept rate` в строках `Decode batch, …`.

## Примеры

```bash
python -m sglang.launch_server --model-path Qwen/Qwen2.5-7B-Instruct --speculative-algorithm NGRAM --speculative-num-draft-tokens 16 --speculative-ngram-match-type BFS --speculative-ngram-min-bfs-breadth 2 --speculative-ngram-max-bfs-breadth 8
```

```bash
python -m sglang.launch_server --model-path Qwen/Qwen2.5-7B-Instruct --speculative-algorithm NGRAM --speculative-num-draft-tokens 12 --speculative-ngram-min-bfs-breadth 4 --speculative-ngram-max-bfs-breadth 4 --speculative-ngram-max-trie-depth 18
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/speculative/ngram_worker.py`
- `sglang/python/sglang/srt/speculative/cpp_ngram/ngram_corpus.py`
- `sglang/python/sglang/kernels/jit/csrc/ngram_corpus/ngram.cpp`
- `sglang/python/sglang/kernels/jit/csrc/ngram_corpus/trie.cpp`
- `sglang/python/sglang/kernels/jit/csrc/ngram_corpus/suffix_automaton.cpp`
- `sglang/docs/docs/advanced_features/speculative_decoding.mdx`
