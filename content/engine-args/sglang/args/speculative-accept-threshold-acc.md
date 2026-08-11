---
schema: 1
engine: sglang
primaryName: "--speculative-accept-threshold-acc"
title: "--speculative-accept-threshold-acc"
summary: Делитель накопленной вероятности в вероятностном условии приёма: вероятность принять draft-токен поднимается с целевой `p` до `min(1, p / threshold_acc)`. `1.0` — честная выборка из target'а, меньшие значения покупают длину принятого куска ценой смещения распределения.
group: spec
related:
  - --speculative-accept-threshold-single
  - --speculative-use-rejection-sampling
  - --speculative-algorithm
  - --speculative-num-draft-tokens
  - --speculative-eagle-topk
  - --enable-deterministic-inference
---

# --speculative-accept-threshold-acc

## Кратко

Парный к `--speculative-accept-threshold-single` порог, но действует на вероятностную половину условия, а не на детерминированную. Ядро verify сравнивает случайную монету не с накопленной целевой вероятностью `prob_acc`, а с `prob_acc / threshold_acc`. При `1.0` это ровно стандартное target-only спекулятивное сэмплирование; при `0.5` каждый draft-токен принимается вдвое охотнее, и токен с целевой вероятностью 0.5 проходит всегда.

## Оригинальная справка

```text
The accept probability of a draft token is raised from its target probability p to min(1, p / threshold_acc).
```

## Паспорт аргумента

- Флаги: `--speculative-accept-threshold-acc`
- Группа: `spec`
- Тип значения: float
- Допустимые значения: argparse не ограничивает, CUDA-операция требует `0 <= threshold_acc <= 1`; ноль дополнительно поднимается до `1e-9` внутри ядра, чтобы не делить на ноль
- Значение по умолчанию: `1.0`
- Эффективное значение: совпадает с заданным; **изменяемо в runtime** через `POST /set_internal_state` (ключ `speculative_accept_threshold_acc`)
- Где объявлен: `ServerArgs.speculative_accept_threshold_acc`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: forward, фаза `target_verify` — читается на каждом шаге из runtime-контекста

## Что меняет в движке

Условие приёма кандидата в ядре `TreeSpeculativeSamplingTargetOnly` (и в chain-варианте DFLASH):

```text
prob_acc += target_prob_single                     # сумма целевых вероятностей уже перебранных братьев
accept if (coin <= prob_acc / threshold_acc) or (target_prob_single >= threshold_single)
```

`prob_acc` накапливается **в пределах одного уровня дерева**: если кандидат отвергнут, его целевая масса остаётся в сумме, и следующий брат оценивается с уже приподнятой планкой. После принятого токена сумма обнуляется, монета берётся новая. Деление на `threshold_acc` линейно масштабирует эту сумму, что и даёт формулу из справки: `p → min(1, p / threshold_acc)`.

Область действия та же, что у парного порога: ветка несжатых до argmax запросов на CUDA. Батч, где все запросы greedy (`temperature = 0`), а также CPU/NPU/ROCm/XPU идут через `verify_tree_greedy`, который порогов не читает. С `--speculative-use-rejection-sampling` любое значение ≠ `1.0` — `ValueError` на старте.

Отвергнутый хвост при этом всё равно обрабатывается корректно с точки зрения механики: финальный токен досэмплируется из `relu(target_probs − draft_probs)`, то есть остаточного распределения. Смещение вносится именно приёмом, а не заменой.

## Значения и формат

- Дробное число в `[0, 1]`. `1.0` — выключено (честная схема).
- `0.0` — принимать всё: после подъёма до `1e-9` частное `prob_acc / 1e-9` заведомо больше любой монеты. Verify перестаёт отбраковывать, выход становится выходом draft-модели.
- Значение вне `[0, 1]` argparse пропускает, ядро отвергает (`CHECK_GE`) на первом же спекулятивном шаге.
- Значение > 1 (если бы прошло проверку) означало бы «принимать реже» — такой режим не поддержан намеренно.
- Одно значение на весь сервер, per-request переопределения нет.

## Когда использовать

- Есть замер: `accept len` заметно меньше `--speculative-num-draft-tokens`, а нагрузка терпит приближённую выборку. `0.9`…`0.8` — разумный первый шаг, он поднимает вероятность приёма примерно на 10–25% там, где target колеблется.
- Нужно подкрутить агрессивность равномерно по всему распределению, а не только у уверенных токенов: в отличие от `--speculative-accept-threshold-single`, который работает порогом, этот аргумент масштабирует вероятность на всём диапазоне.
- Не использовать при требовании несмещённой выборки: значение < 1.0 систематически повышает шанс, что в ответ попадёт токен, который target выбрал бы реже. Формально выход перестаёт быть выборкой из целевого распределения.
- Не менять одновременно с `--speculative-accept-threshold-single`: условия объединены через `or`, и разделить вклад по метрикам потом невозможно.

## Влияние на производительность и память

- Память: нулевое, это скаляр в аргументах ядра.
- Latency/throughput: растёт средняя длина принятого куска, падает число forward'ов на выданный токен. Выигрыш тем больше, чем «размазаннее» целевое распределение (высокая температура, большой `top_p`).
- Качество: единственная цена. Приподнятая вероятность приёма означает, что решения draft'а чаще проходят без коррекции; при значениях порядка 0.5 и ниже текст заметно смещается к стилю и ошибкам draft-модели.

## Взаимодействие с другими аргументами

- `--speculative-accept-threshold-single`: второе слагаемое того же `or`-условия. Общее правило: `single` бьёт по уверенным позициям, `acc` — равномерно.
- `--speculative-use-rejection-sampling`: взаимно исключающие; rejection sampling требует обоих порогов равными `1.0`.
- `--speculative-eagle-topk`: при `topk > 1` накопление `prob_acc` идёт по братьям одного уровня, так что снижение порога сильнее увеличивает шанс принять хотя бы одну ветку.
- `--speculative-num-draft-tokens`: определяет, сколько уровней вообще проверяется; порог влияет на каждый.
- `--speculative-algorithm`: пороги читают EAGLE-семейство и DFLASH.
- `--enable-deterministic-inference`: воспроизводимости распределения смещённый приём не даёт.

## Типовые проблемы и диагностика

- `--speculative-use-rejection-sampling is incompatible with --speculative-accept-threshold-single / --speculative-accept-threshold-acc` — уберите один из двух режимов.
- Падение ядра с `CHECK_GE` — значение вне `[0, 1]`.
- Значение изменено, `accept len` тот же — трафик greedy или устройство не CUDA: в этих ветках порогов нет.
- Внезапно выросшая доля повторов и «залипаний» в ответах после правки — прямое следствие смещения; возвращайте к 1.0 и, если нужна скорость, ищите её в лучшем draft'е или в `--speculative-num-steps`.
- Что смотреть: `accept len` / `accept rate` в строках `Decode batch`, `avg_spec_accept_length=` после `POST /set_internal_state`, поле `speculative_accept_threshold_acc` в дампе `server_args=`.
- Безопасность: тот же `/set_internal_state` без аутентификации позволяет удалённо обнулить порог. Порт движка не должен быть доступен снаружи; публичный вход — прокси arriero.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-8B-Instruct --speculative-algorithm EAGLE3 --speculative-draft-model-path /models/EAGLE3-LLaMA3.1-Instruct-8B --speculative-accept-threshold-acc 0.9
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --speculative-algorithm EAGLE --speculative-num-steps 3 --speculative-eagle-topk 1 --speculative-num-draft-tokens 4 --speculative-accept-threshold-acc 0.8 --max-running-requests 4
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/speculative/eagle_utils.py`
- `sglang/python/sglang/srt/speculative/dflash_utils.py`
- `sglang/python/sglang/kernels/aot/csrc/speculative/speculative_sampling.cuh`
- `sglang/python/sglang/kernels/aot/csrc/speculative/speculative_sampling.cu`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/docs/docs/advanced_features/speculative_decoding.mdx`
