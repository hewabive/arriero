---
schema: 1
engine: sglang
primaryName: "--speculative-ngram-external-sam-budget"
title: "--speculative-ngram-external-sam-budget"
summary: Сколько узлов чернового дерева резервируется под предложения из внешних корпусов. Это прямое изъятие бюджета у локального префиксного дерева, поэтому значение подбирается измерением, а не «на глаз».
group: spec
related:
  - --speculative-algorithm
  - --speculative-ngram-external-corpus-path
  - --speculative-ngram-external-corpus-max-tokens
  - --speculative-num-draft-tokens
  - --speculative-ngram-match-type
---

# --speculative-ngram-external-sam-budget

## Кратко

Черновое дерево NGRAM имеет ровно `--speculative-num-draft-tokens − 1` узлов-предложений. `--speculative-ngram-external-sam-budget` говорит, сколько из них отдать суффиксным автоматам внешних корпусов; остальное достаётся локальному префиксному дереву, наполненному текущим трафиком. Значение по умолчанию `0` означает «внешние корпуса не участвуют» — и при заданном `--speculative-ngram-external-corpus-path` это условие явно отвергается на старте. Аргумент — чистый компромисс: каждый узел, отданный корпусу, потерян для дерева.

## Оригинальная справка

```text
Number of draft nodes reserved for the external SAM subtree in ngram speculative decoding.
```

## Паспорт аргумента

- Флаги: `--speculative-ngram-external-sam-budget`
- Группа: `spec`
- Тип значения: int (число узлов дерева)
- Допустимые значения: `choices` нет. При заданном `--speculative-ngram-external-corpus-path` требуется `> 0` и `≤ --speculative-num-draft-tokens − 1`
- Значение по умолчанию: `0`
- Эффективное значение: не переопределяется, но в момент построения дерева усекается: `min(external_sam_budget, num_draft_tokens − 1)`
- Где объявлен: `ServerArgs.speculative_ngram_external_sam_budget`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный; читается **только** при `--speculative-algorithm NGRAM`
- Этап применения: `handle_speculative_decoding` → `_handle_ngram` (валидация) → конструктор C++-объекта `Ngram` → каждый вызов `batchMatch` на decode-шаге

## Что меняет в движке

Арифметика бюджета в `Ngram::batchMatch` (`sglang/python/sglang/kernels/jit/csrc/ngram_corpus/ngram.cpp`), вычисляется один раз на батч:

```
total_draft_token_num = num_draft_tokens − 1
total_sam_budget      = число корпусов > 0 ? min(external_sam_budget, total_draft_token_num) : 0
per_sam_budget        = число корпусов > 0 ? total_sam_budget / число корпусов : 0
trie_budget           = total_draft_token_num − per_sam_budget · число корпусов
```

Деление целочисленное. Отсюда два неочевидных следствия:

- если корпусов больше, чем узлов бюджета (`per_sam_budget == 0`), внешние автоматы **полностью пропускаются**, и дерево получает весь бюджет — без предупреждения;
- остаток от деления достаётся дереву: при бюджете 5 и двух корпусах каждый получает 2 узла, а дерево — `total − 4`.

Дальше для каждого запроса сначала строится поддерево из локального дерева на `trie_budget` узлов, затем по одному поддереву на каждый автомат на `per_sam_budget` узлов, и всё сливается `combineRootResults_` в общее дерево длиной `num_draft_tokens` (с добивкой нулями, если узлов не хватило). Алгоритм построения в автомате тот же, что задан `--speculative-ngram-match-type`; окно сопоставления ограничено `--speculative-ngram-max-trie-depth`.

Валидация на старте (`_handle_ngram` в `sglang/python/sglang/srt/arg_groups/speculative_hook.py`) выполняется **только** при заданном `--speculative-ngram-external-corpus-path`: бюджет должен быть положительным и не превышать `num_draft_tokens − 1`. Если корпус подключается позже через `POST /add_external_corpus`, а бюджет остался нулевым, старт пройдёт, корпус загрузится — и не будет использован ни разу.

## Значения и формат

- Целое ≥ 0.
- `0` — внешние корпуса не получают ни одного узла. Это значение по умолчанию и единственно допустимое, когда корпуса нет.
- Верхняя граница — `--speculative-num-draft-tokens − 1`; при ней локальное дерево не получает ничего.
- Значение делится **между всеми** загруженными корпусами, включая добавленные на ходу. Добавив второй корпус к бюджету 3, вы получите по 1 узлу на корпус и 1 узел дереву — то есть добавление корпуса меняет геометрию для уже работающего.
- Разумный старт — 1/4…1/3 от `num_draft_tokens − 1`: например `4` при `--speculative-num-draft-tokens 16`.

## Когда использовать

- Только вместе с `--speculative-ngram-external-corpus-path` (или с планом подключить корпус через HTTP).
- Повышать, если измерения показывают, что предложения из корпуса принимаются чаще, чем локальные: признак — рост `accept len` при увеличении бюджета.
- Понижать до 1–2, если корпус помогает лишь изредка: узлы полезнее локальному дереву, которое видит текущий контекст.
- Не выставлять близко к `num_draft_tokens − 1`: локальное дерево — обычно более сильный источник, потому что оно знает именно текущий диалог.
- Всегда пересматривать значение после подключения второго и последующих корпусов: делитель меняется.

## Влияние на производительность и память

- Память: не влияет ни на VRAM, ни на RAM хоста. Размер дерева-предложения фиксирован `--speculative-num-draft-tokens`, память автоматов определяется объёмом корпусов и ограничена `--speculative-ngram-external-corpus-max-tokens`.
- CPU: при ненулевом бюджете на каждый decode-шаг добавляется поиск и построение в каждом автомате плюс слияние результатов. При `per_sam_budget == 0` автоматы не опрашиваются вовсе — это самый дешёвый путь.
- Compute GPU: не влияет — верификация всегда `num_draft_tokens` позиций на запрос независимо от того, чьими предложениями они заполнены.
- Acceptance rate: единственный измеримый эффект. Меняйте значение по одному шагу и сравнивайте `accept len` / `accept rate` на одинаковой нагрузке.

## Взаимодействие с другими аргументами

- `--speculative-ngram-external-corpus-path`: при заданном пути бюджет обязателен и должен быть положительным.
- `--speculative-ngram-external-corpus-max-tokens`: вторая обязательная половина связки; отвечает за объём корпусов, а не за их долю в дереве.
- `--speculative-num-draft-tokens`: задаёт общий бюджет `num_draft_tokens − 1`, из которого вычитается эта доля.
- `--speculative-ngram-match-type`: определяет, как автомат строит свою часть дерева.
- `--speculative-ngram-max-trie-depth`: ограничивает окно сопоставления и в дереве, и в автоматах.
- `--speculative-ngram-min-bfs-breadth` / `--speculative-ngram-max-bfs-breadth`: формула ширины применяется к автомату так же, как к дереву.
- `--speculative-algorithm`: вне `NGRAM` аргумент не читается.

## Типовые проблемы и диагностика

- `--speculative-ngram-external-sam-budget must be positive when --speculative-ngram-external-corpus-path is set.` — задан корпус, но не бюджет.
- `speculative_ngram_external_sam_budget must be less than or equal to speculative_num_draft_tokens - 1 (N).` — бюджет больше размера дерева.
- Корпус загружен (виден в `GET /list_external_corpora`), но acceptance rate не изменился — вероятнее всего `per_sam_budget` оказался нулём: бюджет меньше числа корпусов. Увеличьте бюджет или удалите лишние корпуса.
- Acceptance rate упал после подключения второго корпуса при неизменном бюджете — доля на корпус уменьшилась, а у дерева всё равно отобрали узлы. Пересчитайте бюджет под новое число корпусов.
- `accept len` падает по мере роста бюджета — корпус проигрывает локальному дереву; уменьшайте.
- Чем подтвердить: дамп `server_args=` при старте, `GET /list_external_corpora` (сколько корпусов и сколько в них токенов), строки `Decode batch, … accept len: …, accept rate: …`.

## Примеры

```bash
python -m sglang.launch_server --model-path Qwen/Qwen2.5-7B-Instruct --speculative-algorithm NGRAM --speculative-num-draft-tokens 16 --speculative-ngram-external-corpus-path /srv/corpora/templates.jsonl --speculative-ngram-external-sam-budget 4 --speculative-ngram-external-corpus-max-tokens 200000
```

```bash
python -m sglang.launch_server --model-path Qwen/Qwen2.5-7B-Instruct --speculative-algorithm NGRAM --speculative-num-draft-tokens 12 --speculative-ngram-external-corpus-path /srv/corpora/handbook.jsonl --speculative-ngram-external-sam-budget 2 --speculative-ngram-match-type PROB
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/speculative_hook.py`
- `sglang/python/sglang/srt/speculative/ngram_worker.py`
- `sglang/python/sglang/srt/speculative/cpp_ngram/ngram_corpus.py`
- `sglang/python/sglang/kernels/jit/csrc/ngram_corpus/ngram.cpp`
- `sglang/python/sglang/kernels/jit/csrc/ngram_corpus/result.cpp`
- `sglang/python/sglang/kernels/jit/csrc/ngram_corpus/suffix_automaton.cpp`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
