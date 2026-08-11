---
schema: 1
engine: sglang
primaryName: "--enable-multi-layer-eagle"
title: "--enable-multi-layer-eagle"
summary: Переводит EAGLE на многослойный драфтер: вместо одной MTP-головы, прогоняемой N раз, поднимается N отдельных model runner'ов — по одному на каждый спекулятивный шаг, каждый со своими весами из чекпоинта. Для MiMoV2 и Step3p5/3p7 включается автоматически.
group: spec
related:
  - --speculative-algorithm
  - --speculative-num-steps
  - --speculative-eagle-topk
  - --speculative-num-draft-tokens
  - --speculative-adaptive
  - --speculative-use-rejection-sampling
  - --speculative-draft-model-path
  - --mem-fraction-static
---

# --enable-multi-layer-eagle

## Кратко

Обычный EAGLE прогоняет один и тот же draft-слой `--speculative-num-steps` раз подряд. Многослойный вариант берёт из чекпоинта столько MTP-слоёв, сколько шагов, и на каждом шаге работает **свой** слой со своими весами. Это точнее (каждый слой обучен на своей позиции), но и дороже: N наборов весов, N `ModelRunner`'ов и N наборов CUDA graph'ов. Флаг имеет смысл только для чекпоинтов, где такие слои вообще есть.

## Оригинальная справка

```text
Enable multi-layer Eagle speculative decoding.
```

## Паспорт аргумента

- Флаги: `--enable-multi-layer-eagle`
- Группа: `spec`
- Тип значения: bool (`action="store_true"`, парного `--no-…` нет)
- Допустимые значения: флаг присутствует — включено, отсутствует — выключено
- Значение по умолчанию: `false`
- Эффективное значение: поле помечено `resolvable=True` и **включается реестром модельных override'ов**: для `MiMoV2ForCausalLM` / `MiMoV2FlashForCausalLM` и для `Step3p5ForCausalLM` / `Step3p7ForConditionalGeneration` при `--speculative-algorithm EAGLE` (в логе `Enable multi-layer EAGLE speculative decoding for … model.`)
- Где объявлен: `ServerArgs.enable_multi_layer_eagle`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (модельные override'ы) → выбор класса воркера в `SpeculativeAlgorithm.create_worker` → создание `speculative_num_steps` model runner'ов → захват CUDA graph → forward

## Что меняет в движке

- **Класс воркера.** `create_worker` возвращает `MultiLayerEagleWorkerV2` вместо `EAGLEWorkerV2` — но только если алгоритм из EAGLE-семейства.
- **Число runner'ов.** `TpModelWorker(is_multi_layer_eagle=True)` создаёт список из `speculative_num_steps` `ModelRunner`'ов; каждый получает `draft_model_idx=i`. Индекс уходит в `LoadConfig`, и загрузчик через `_filter_mtp_weights` оставляет только веса `model.mtp.layers.<i>.*`, переименовывая их в `layers.0`. То есть N runner'ов — это N **разных** MTP-слоёв одного чекпоинта, а не N копий одного.
- **Инвариант параметров.** Воркер ассертит `speculative_num_draft_tokens == speculative_num_steps + 1`; дерева здесь нет, цепочка линейная.
- **Передача hidden states.** `spec_need_hidden_states()` возвращает `False`: многослойный драфтер не ретранслирует hidden states через `FutureMap`, каждый слой берёт вход у предыдущего.
- **Размерность буферов.** В eager-runner'е у draft-воркера ширина на запрос считается как `max(topk, num_draft_tokens, 2 × speculative_num_steps)` — множитель на шаги появляется именно из-за этого флага.
- **PD-disaggregation.** В `build_eagle_disagg_draft_input` число передаваемых состояний умножается на `speculative_num_steps`.

Для драфтеров с собственными конволюционными слоями (Inkling) многослойный режим — единственный поддержанный: обычный многошаговый draft-decode backend не умеет нести conv-sidecar и падает с `NotImplementedError: … Use --enable-multi-layer-eagle.`

## Значения и формат

- Булев флаг без значения.
- «Не задан» не означает «выключено» на MiMoV2/Step3p5/Step3p7 + EAGLE: там его включает реестр override'ов, и увидеть это можно только по логу и по дампу `server_args=`.
- Для алгоритмов вне EAGLE-семейства (`NGRAM`, `DFLASH`, `DSPARK`, `STANDALONE`) флаг не читается при выборе воркера, но продолжает влиять на `ModelConfig.is_multi_layer_eagle` и на проверки adaptive-режима — задавать его там незачем.
- Явно выключить автоматическое включение через CLI нельзя: парного `--no-enable-multi-layer-eagle` нет.

## Когда использовать

- Чекпоинт содержит несколько MTP-слоёв (`model.mtp.layers.0..N`) и вы хотите спекулировать глубже одного шага с сохранением качества предложений.
- Драфтер Inkling-семейства с conv-слоями — иначе старт падает с прямым указанием на этот флаг.
- Не включать на чекпоинте с одной MTP-головой: загрузчик отфильтрует веса по индексам, которых нет, и вы получите либо пустой слой, либо падение на загрузке.
- Не включать вместе с `--speculative-adaptive`: adaptive выключится с сообщением `enable_multi_layer_eagle=True is not supported (MultiLayerEagleWorkerV2 does not implement adaptive)`.
- Не включать, когда VRAM в обрез: цена линейна по `--speculative-num-steps`.

## Влияние на производительность и память

- VRAM: главный эффект. Веса каждого MTP-слоя резидентны отдельно, у каждого runner'а свои графы; при `--speculative-num-steps 3` это три набора вместо одного.
- Время старта: N проходов загрузчика по чекпоинту (с фильтрацией) плюс N наборов CUDA graph.
- Качество предложений: обычно выше, чем у одного слоя, прогнанного N раз, — это и есть смысл режима; итоговый выигрыш измеряется по `accept len`.
- Скорость одного draft-шага не меняется: на шаге по-прежнему работает один слой.

## Взаимодействие с другими аргументами

- `--speculative-algorithm`: воркер подменяется только для EAGLE-семейства.
- `--speculative-num-steps`: определяет число runner'ов и, соответственно, всю стоимость режима.
- `--speculative-num-draft-tokens`: обязан быть равен `steps + 1` (ассерт воркера).
- `--speculative-eagle-topk`: с `--speculative-use-rejection-sampling` многослойный режим требует `topk = 1` (rejection sampling реализован только для линейной цепочки).
- `--speculative-adaptive`: взаимно исключающие (adaptive отключается сам).
- `--speculative-draft-model-path`: для MTP-чекпоинтов подставляется `--model-path`; фильтрация по `draft_model_idx` идёт по весам того же файла.
- `--mem-fraction-static`: под N наборов весов и графов резерв нужно пересчитывать.

## Типовые проблемы и диагностика

- `multi-layer EAGLE requires speculative_num_draft_tokens == speculative_num_steps + 1, got X and Y` — приведите параметры к линейной цепочке.
- `speculative_adaptive disabled: enable_multi_layer_eagle=True is not supported …` — ожидаемо, выберите один из двух режимов.
- `--speculative-use-rejection-sampling with multi-layer EAGLE (--enable-multi-layer-eagle) requires --speculative-eagle-topk 1` — сузьте до цепочки.
- `Inkling's draft model runs its own short convs … Use --enable-multi-layer-eagle.` — обратный случай: флаг обязателен.
- OOM на старте после включения — умножьте объём draft-весов на `--speculative-num-steps`, это и есть новая заявка; понижайте шаги или `--mem-fraction-static`.
- Что смотреть: `Enable multi-layer EAGLE speculative decoding for … model.` (автовключение), поле `enable_multi_layer_eagle` в дампе `server_args=`, число проходов загрузчика весов на старте.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/MiMo-V2-Base --trust-remote-code --speculative-algorithm EAGLE --speculative-num-steps 2 --speculative-eagle-topk 1 --speculative-num-draft-tokens 3 --enable-multi-layer-eagle
```

```bash
python -m sglang.launch_server --model-path /models/MiMo-V2-Base --trust-remote-code --speculative-algorithm EAGLE --speculative-num-steps 3 --speculative-eagle-topk 1 --speculative-num-draft-tokens 4 --enable-multi-layer-eagle --mem-fraction-static 0.78 --max-running-requests 8
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/speculative/spec_info.py`
- `sglang/python/sglang/srt/speculative/multi_layer_eagle_worker_v2.py`
- `sglang/python/sglang/srt/speculative/spec_utils.py`
- `sglang/python/sglang/srt/managers/tp_worker.py`
- `sglang/python/sglang/srt/model_loader/loader.py`
- `sglang/python/sglang/srt/model_executor/runner/eager_runner.py`
- `sglang/python/sglang/srt/speculative/adaptive_spec_params.py`
