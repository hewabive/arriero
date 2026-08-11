---
schema: 1
engine: sglang
primaryName: "--speculative-accept-threshold-single"
title: "--speculative-accept-threshold-single"
summary: Порог безусловного принятия draft-токена: если целевая модель дала ему вероятность не ниже этого значения, токен принимается без броска монеты. Значение по умолчанию 1.0 сохраняет распределение target'а; любое меньшее — обмен качества выборки на скорость.
group: spec
related:
  - --speculative-accept-threshold-acc
  - --speculative-use-rejection-sampling
  - --speculative-algorithm
  - --speculative-num-draft-tokens
  - --speculative-eagle-topk
  - --enable-deterministic-inference
---

# --speculative-accept-threshold-single

## Кратко

В стандартной схеме verify draft-токен принимается вероятностно: бросается монета, и токен проходит тем чаще, чем выше его вероятность **в целевой модели**. Этот аргумент добавляет второе, детерминированное условие: `target_prob >= threshold_single` — принять сразу. При `1.0` условие практически никогда не срабатывает (кроме вырожденных one-hot распределений), и схема остаётся математически эквивалентной обычной выборке из target'а. Всё, что меньше, — сознательная потеря точности выборки ради длины принятого куска.

## Оригинальная справка

```text
Accept a draft token if its probability in the target model is greater than this threshold.
```

## Паспорт аргумента

- Флаги: `--speculative-accept-threshold-single`
- Группа: `spec`
- Тип значения: float
- Допустимые значения: argparse не ограничивает, но CUDA-операция проверяет `0 <= threshold_single <= 1` и падает на значении вне отрезка
- Значение по умолчанию: `1.0`
- Эффективное значение: совпадает с заданным; **изменяемо в runtime** через `POST /set_internal_state` (ключ `speculative_accept_threshold_single` в объекте `server_args`) — это один из немногих серверных аргументов в белом списке обновляемых
- Где объявлен: `ServerArgs.speculative_accept_threshold_single`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: forward, фаза `target_verify` — значение читается из runtime-контекста на каждом шаге, а не фиксируется на старте

## Что меняет в движке

Значение уходит параметром `threshold_single` в ядро verify (`tree_speculative_sampling_target_only` для EAGLE-семейства, chain-вариант для DFLASH). Условие принятия кандидата на каждом уровне дерева выглядит так:

```text
prob_acc += target_prob_single                     # накопленная вероятность братьев этого уровня
accept if (coin <= prob_acc / threshold_acc) or (target_prob_single >= threshold_single)
```

`target_prob_single` — это вероятность draft-токена **в целевом распределении** после применения температуры, `top_k` и `top_p` конкретного запроса. То есть сравнение идёт не с уверенностью draft'а и не с логитом, а с той самой вероятностью, из которой target и сэмплировал бы сам.

Два важных ограничения области действия:

- **Только для несжатых до argmax запросов.** Если у батча `sampling_info.is_all_greedy` (все запросы с `temperature = 0`), либо устройство — CPU/NPU/ROCm/XPU, verify идёт через `verify_tree_greedy`, где порогов нет вовсе. На чисто greedy-трафике аргумент не делает ничего.
- **Несовместим с `--speculative-use-rejection-sampling`.** При включённой rejection sampling любое значение порогов, отличное от `1.0`, — `ValueError` на старте: то ядро игнорирует пороги по построению.

## Значения и формат

- Дробное число в `[0, 1]`. `1.0` — выключено (условие требует вероятности ≥ 1.0, что бывает только у вырожденного распределения, например при `top_k 1`).
- `0.0` — принимать **любой** draft-токен: условие `p >= 0` истинно всегда, и verify перестаёт быть проверкой. Выход становится выходом draft-модели.
- Значение вне `[0, 1]` argparse пропустит, а ядро отвергнет (`CHECK_GE`) уже на первом спекулятивном шаге — сервер стартует и падает под нагрузкой.
- Значение общее на весь сервер, per-request переопределения нет.

## Когда использовать

- Когда измерен `accept len` и он заметно ниже `--speculative-num-draft-tokens`, а бизнес-задача терпит приближённую выборку (черновые ответы, автодополнение, внутренние инструменты). Начинайте с `0.9`: практически это означает «там, где target и так согласен на 90%, не бросаем монету».
- Как временный эксперимент через `POST /set_internal_state` — менять значение и наблюдать `accept len`, не перезапуская сервер.
- Не использовать там, где требуется воспроизводимая или несмещённая выборка: любая величина < 1.0 меняет распределение выхода в сторону предложений draft'а. Это не «чуть менее аккуратно», а другая модель распределения.
- Не крутить, если трафик greedy (`temperature = 0`): эффекта не будет вообще, и вы потратите итерацию впустую.

## Влияние на производительность и память

- Память: нулевое — это скаляр, передаваемый в ядро.
- Latency/throughput: растёт средняя длина принятого куска, то есть падает число forward'ов на токен. Порядок выигрыша определяется тем, насколько часто у draft-токенов вероятность попадает в интервал `[threshold, 1)`.
- Качество: единственная реальная цена. Чем ниже порог, тем ближе выход к выходу draft-модели: сначала пропадает хвост распределения (текст становится «уверенным» и более повторяющимся), при значениях порядка 0.3 и ниже target фактически перестаёт корректировать draft.

## Взаимодействие с другими аргументами

- `--speculative-accept-threshold-acc`: второе слагаемое того же условия, работает через накопленную вероятность. Их эффекты складываются; менять оба сразу — верный способ не понять, что именно повлияло.
- `--speculative-use-rejection-sampling`: взаимно исключающие; при включении rejection sampling пороги обязаны быть `1.0`.
- `--speculative-algorithm`: пороги читают EAGLE/EAGLE3/STANDALONE-путь (`eagle_utils`) и DFLASH-путь (`dflash_utils`). У `NGRAM` verify тоже проходит через дерево EAGLE-типа, у DSPARK — через собственный планировщик.
- `--speculative-eagle-topk`: при `topk > 1` пороги применяются на каждом уровне дерева к каждому брату по очереди, поэтому эффект сильнее, чем на линейной цепочке.
- `--enable-deterministic-inference`: детерминированный режим ограничивает ядра сэмплирования; сочетание с ненулевой правкой порогов не даёт никаких гарантий воспроизводимости распределения.

## Типовые проблемы и диагностика

- `--speculative-use-rejection-sampling is incompatible with --speculative-accept-threshold-single / --speculative-accept-threshold-acc; rejection sampling ignores the accept thresholds` — уберите одно из двух.
- Падение в ядре verify с `CHECK_GE` — значение вне `[0, 1]`.
- Поменяли порог, `accept len` не изменился — трафик greedy или устройство не CUDA: verify идёт по ветке без порогов.
- Ответы стали заметно более шаблонными после правки — это ожидаемое следствие; поднимайте порог обратно к 1.0.
- Что смотреть: `accept len` и `accept rate` в строках `Decode batch, #running-req: …`, накопленное `avg_spec_accept_length=` в логе после `POST /set_internal_state`, поле `speculative_accept_threshold_single` в дампе `server_args=`.
- Безопасность: `/set_internal_state` — незащищённый эндпоинт SGLang. Сервер, доступный не только с localhost, позволяет любому клиенту обнулить оба порога и молча деградировать качество ответов; закрывайте порт движка и ходите через прокси arriero.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-8B-Instruct --speculative-algorithm EAGLE3 --speculative-draft-model-path /models/EAGLE3-LLaMA3.1-Instruct-8B --speculative-accept-threshold-single 0.9
```

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-8B-Instruct --speculative-algorithm EAGLE3 --speculative-draft-model-path /models/EAGLE3-LLaMA3.1-Instruct-8B --speculative-accept-threshold-single 0.85 --speculative-accept-threshold-acc 0.9 --max-running-requests 8
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/speculative/eagle_utils.py`
- `sglang/python/sglang/srt/speculative/dflash_utils.py`
- `sglang/python/sglang/kernels/aot/csrc/speculative/speculative_sampling.cuh`
- `sglang/python/sglang/kernels/aot/csrc/speculative/speculative_sampling.cu`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/entrypoints/http_server.py`
- `sglang/docs/docs/advanced_features/speculative_decoding.mdx`
