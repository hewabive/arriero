---
schema: 1
engine: sglang
primaryName: "--speculative-ngram-max-bfs-breadth"
title: "--speculative-ngram-max-bfs-breadth"
summary: Верхняя граница ветвления n-gram-черновика: ширина обхода для коротких совпадений в `BFS` и top-k детей на узел в `PROB`. Этим же значением безусловно перезаписывается `--speculative-eagle-topk`, поэтому оно же решает вопрос совместимости с `--page-size` и attention-бэкендом.
group: spec
related:
  - --speculative-algorithm
  - --speculative-ngram-min-bfs-breadth
  - --speculative-ngram-match-type
  - --speculative-ngram-max-trie-depth
  - --speculative-eagle-topk
  - --speculative-num-steps
  - --speculative-num-draft-tokens
  - --page-size
  - --attention-backend
---

# --speculative-ngram-max-bfs-breadth

## Кратко

`--speculative-ngram-max-bfs-breadth` — главный параметр формы чернового дерева под `--speculative-algorithm NGRAM`. В режиме `BFS` он задаёт ширину обхода для самых коротких (наименее уверенных) совпадений; в режиме `PROB` — сколько детей узла вообще рассматривается. И у него есть третья, неочевидная роль: `_handle_ngram` безусловно присваивает `speculative_eagle_topk = speculative_ngram_max_bfs_breadth`, без предупреждения в логе. Из-за этого именно этот аргумент решает, попадёте ли вы под ограничение «`topk > 1` вместе с `--page-size` больше единицы работает только на `--attention-backend flashinfer`».

## Оригинальная справка

```text
The maximum breadth for BFS (Breadth-First Search) in ngram speculative decoding.
```

## Паспорт аргумента

- Флаги: `--speculative-ngram-max-bfs-breadth`
- Группа: `spec`
- Тип значения: int
- Допустимые значения: `choices` нет; C++-конструктор требует `≥ --speculative-ngram-min-bfs-breadth`
- Значение по умолчанию: `10`
- Эффективное значение: не переопределяется, но само переопределяет `--speculative-eagle-topk` и (косвенно) `--speculative-num-steps`
- Где объявлен: `ServerArgs.speculative_ngram_max_bfs_breadth`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный; читается **только** при `--speculative-algorithm NGRAM`
- Этап применения: `handle_speculative_decoding` → `_handle_ngram` (перезапись `speculative_eagle_topk`, проверки page_size/backend) → конструктор C++-объекта `Ngram` → построение дерева на каждом decode-шаге

## Что меняет в движке

**Роль 1 — ширина `BFS`.** В `Trie::buildRecency` ширина обхода для якоря глубины `d` равна `(max_match_depth − d) · scale + min_bfs_breadth`, где `max_match_depth = max(1, max_trie_depth − 1)` и `scale = (max_bfs_breadth − min_bfs_breadth) / max_match_depth`. При `d = 1` (совпал только последний токен) ширина близка к максимуму. С каждым уровнем вглубь она уменьшается на `scale`, но не ниже `1`. Дети узла берутся из его LRU-списка, самый недавно виденный первым.

**Роль 2 — top-k в `PROB`.** В `Trie::buildFrequency` значение используется как `top_k`: у каждого разворачиваемого узла берутся первые `max_bfs_breadth` детей из `sorted_children` (упорядочены по убыванию частоты), их частоты нормируются на сумму по этой же верхушке, и произведение вдоль пути кладётся в общую max-кучу. `--speculative-ngram-min-bfs-breadth` в этом режиме не участвует.

**Роль 3 — перезапись `--speculative-eagle-topk`.** В `_handle_ngram` (`sglang/python/sglang/srt/arg_groups/speculative_hook.py`) стоит `server_args.speculative_eagle_topk = server_args.speculative_ngram_max_bfs_breadth`. Отсюда каскад:

- если `--speculative-num-steps` не задан, он вычисляется как `speculative_num_draft_tokens // speculative_eagle_topk` — при значениях по умолчанию `12 // 10 = 1`;
- `get_alloc_len_per_decode` считает `max(num_steps · topk, num_draft_tokens)`; для NGRAM `has_draft_kv()` ложно, поэтому постраничное дублирование веток не применяется, но само произведение `num_steps · topk` в формуле остаётся;
- срабатывает проверка: при `topk > 1` и `--page-size` больше единицы допустим только `--attention-backend flashinfer`, иначе `ValueError` на старте.

Общий бюджет узлов дерева-предложения во всех режимах один: `--speculative-num-draft-tokens − 1` минус доля, отданная внешним корпусам через `--speculative-ngram-external-sam-budget`. Недостроенное дерево добивается нулями до фиксированной длины, так что ширина влияет на состав предложения, но не на стоимость верификации.

## Значения и формат

- Целое ≥ 1 и ≥ `--speculative-ngram-min-bfs-breadth`.
- `1` — черновик всегда строит линейную цепочку, а `--speculative-eagle-topk` становится `1`: снимаются все ограничения по `--page-size` и attention-бэкенду, и `--speculative-num-steps` при незаданном значении становится равным `--speculative-num-draft-tokens`.
- `10` (по умолчанию) вместе с `--speculative-num-draft-tokens 12` даёт `num_steps = 1`; это широкое и мелкое дерево.
- Верхняя граница практическая: ширина больше числа доступных узлов бюджета бессмысленна.
- Апстрим-документация отдельно предупреждает: при `--speculative-ngram-max-bfs-breadth > 1` и `page_size > 1` нужен `--attention-backend flashinfer`, иначе сервер откажется стартовать.

## Когда использовать

- Уменьшать до 1–4 на генерации, где повторы точные и длинные (код, structured output, цитирование входа): узкое дерево тратит бюджет на глубину, а не на альтернативы, и снимает ограничения по attention-бэкенду.
- Оставлять около значения по умолчанию, когда совпадения короткие и ненадёжные: широкий куст даёт больше шансов, что хоть одна ветка совпадёт.
- Всегда проверять, что получилось с `--speculative-eagle-topk` и `--speculative-num-steps`, после изменения этого аргумента — они пересчитываются молча.
- Не задавать `--speculative-eagle-topk` вручную под NGRAM: значение будет перезаписано.

## Влияние на производительность и память

- Память GPU: не влияет. Предвыделенные тензоры `NGRAMWorker` (`draft_tokens`, `tree_mask` размера `max_batch_size · draft_token_num²` булей и три индексных тензора) зависят только от `--speculative-num-draft-tokens` и `--max-running-requests`.
- Память хоста: не влияет напрямую; расход узлов дерева определяется `--speculative-ngram-capacity` и `--speculative-ngram-max-trie-depth`.
- CPU: шире обход — больше узлов в очереди/куче на каждом построении; работа делается синхронно на шаге планировщика для всего батча.
- Compute GPU: не зависит от ширины — верификация всегда `--speculative-num-draft-tokens` позиций на запрос.
- Acceptance rate: главный эффект. Широкое мелкое дерево принимает мало токенов за раз, узкое глубокое — много, но реже.

## Взаимодействие с другими аргументами

- `--speculative-ngram-min-bfs-breadth`: нижняя точка той же интерполяции; должно выполняться `min ≤ max`.
- `--speculative-ngram-match-type`: в `BFS` — ширина по уровням, в `PROB` — top-k детей.
- `--speculative-ngram-max-trie-depth`: задаёт наклон интерполяции; при большей глубине ширина убывает медленнее.
- `--speculative-eagle-topk`: полностью перезаписывается этим значением под NGRAM.
- `--speculative-num-steps`: при незаданном значении вычисляется как `num_draft_tokens // max_bfs_breadth`.
- `--speculative-num-draft-tokens`: общий бюджет узлов дерева.
- `--page-size` и `--attention-backend`: при значении больше `1` и `page_size > 1` требуется `flashinfer`.
- `--speculative-algorithm`: вне `NGRAM` аргумент не читается.

## Типовые проблемы и диагностика

- `speculative_eagle_topk(N) > 1 with page_size(M) > 1 is unstable and produces incorrect results for paged attention backends. This combination is only supported for the 'flashinfer' backend.` — уменьшите ширину до `1`, поставьте `--page-size 1` или смените backend на `flashinfer`.
- `std::runtime_error: min_bfs_breadth must be less than or equal to max_bfs_breadth, …` — границы переставлены.
- Заданный вручную `--speculative-eagle-topk` «не применился» — под NGRAM он всегда замещается этим аргументом.
- `--speculative-num-steps` неожиданно равен 1 — так и есть при значениях по умолчанию (`12 // 10`). Задайте шаги явно, если нужна другая геометрия.
- `accept len` около `1.0` при широком дереве — совпадений нет вообще; ширина тут не поможет, проверьте, есть ли в трафике повторы.
- Чем подтвердить: дамп `server_args=` при старте — там уже перезаписанный `speculative_eagle_topk` и вычисленный `speculative_num_steps`; эффект — по `accept len` / `accept rate` в строках `Decode batch`.

## Примеры

```bash
python -m sglang.launch_server --model-path Qwen/Qwen2.5-7B-Instruct --speculative-algorithm NGRAM --speculative-num-draft-tokens 16 --speculative-ngram-max-bfs-breadth 10 --mem-fraction-static 0.7 --cuda-graph-max-bs-decode 8
```

```bash
python -m sglang.launch_server --model-path Qwen/Qwen2.5-7B-Instruct --speculative-algorithm NGRAM --speculative-num-draft-tokens 8 --speculative-ngram-max-bfs-breadth 1 --speculative-ngram-max-trie-depth 24 --page-size 64
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/speculative_hook.py`
- `sglang/python/sglang/srt/speculative/ngram_worker.py`
- `sglang/python/sglang/srt/mem_cache/allocation_sizing.py`
- `sglang/python/sglang/kernels/jit/csrc/ngram_corpus/trie.cpp`
- `sglang/python/sglang/kernels/jit/csrc/ngram_corpus/ngram.cpp`
- `sglang/docs/docs/advanced_features/speculative_decoding.mdx`
