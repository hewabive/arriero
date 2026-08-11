---
schema: 1
engine: sglang
primaryName: "--speculative-adaptive"
title: "--speculative-adaptive"
summary: Включает подбор `--speculative-num-steps` в runtime по наблюдаемой длине принятого куска, отдельно для каждого диапазона batch size. Работает только с EAGLE/EAGLE3 при topk=1; в остальных конфигурациях молча отключается с указанием причины.
group: spec
related:
  - --speculative-adaptive-config
  - --speculative-algorithm
  - --speculative-num-steps
  - --speculative-eagle-topk
  - --speculative-num-draft-tokens
  - --enable-multi-layer-eagle
  - --enable-dp-attention
  - --enable-two-batch-overlap
  - --enable-pdmux
  - --cuda-graph-max-bs-decode
---

# --speculative-adaptive

## Кратко

Статический `--speculative-num-steps` — это ставка на один режим нагрузки. Adaptive-режим делает ставку динамической: после каждого verify считается среднее число принятых draft-токенов, сглаживается EMA, и глубина спекуляции переключается по лестнице кандидатов. Переключение — это подмена заранее захваченных CUDA graph'ов и backend'ов, а не перезахват, поэтому цена в памяти платится один раз на старте, зато сразу за все ступени.

## Оригинальная справка

```text
Enable adaptive speculative decoding that dynamically adjusts num_steps based on acceptance rate.
```

## Паспорт аргумента

- Флаги: `--speculative-adaptive`
- Группа: `spec`
- Тип значения: bool (`action="store_true"`, парного `--no-…` нет)
- Допустимые значения: флаг присутствует — включено, отсутствует — выключено
- Значение по умолчанию: `false`
- Эффективное значение: **может быть сброшено в `false`** самим движком в `_maybe_disable_adaptive`, если конфигурация не поддержана; в лог печатается `speculative_adaptive disabled: <причина>. Falling back to static speculative params.`
- Где объявлен: `ServerArgs.speculative_adaptive`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (`handle_speculative_decoding` → `_maybe_disable_adaptive` → `_init_adaptive_speculative_params`) → захват CUDA graph по всем ступеням лестницы → каждый decode-шаг (выбор ступени) и каждый verify (обновление EMA)

## Что меняет в движке

### На старте

`_init_adaptive_speculative_params` читает лестницу шагов из `--speculative-adaptive-config` (или из встроенного дефолта), после чего:

- `--speculative-eagle-topk` при `None` становится `1`;
- `--speculative-num-steps` при `None` становится средним элементом лестницы (`candidate_steps[len//2]`); если он задан и **не входит** в лестницу — `ValueError`;
- `--speculative-num-draft-tokens` жёстко приравнивается к `num_steps + 1`.

Далее буферы и графы размеряются не по текущей ступени, а по максимальной: `max_speculative_num_draft_tokens` для adaptive-режима возвращает `max(candidate_steps) + 1`, и eager-runner берёт именно это число токенов на запрос. Для каждой ступени захватывается свой набор графов (draft-decode, draft-extend, target-decode); ступени, недостижимые ни для одного диапазона BS, из захвата исключаются.

### В runtime

`AdaptiveController` перед draft-фазой спрашивает у политики ступень для текущего batch size, а после verify скармливает ей вектор принятых длин. Политика (`AdaptiveStepSlot`) держит отдельный EMA на каждый диапазон BS, применяет `warmup_batches`, `update_interval`, гистерезисы и опциональный потолок, и целится примерно в `round(ema_accept_len) + 1`. Смена ступени — это `apply_runtime_state`: подмена ссылок на графы и backend'ы плюс `get_context().override(...)`, чтобы `speculative_num_steps`/`num_draft_tokens` в контексте соответствовали активной ступени. Внутри раунда переключений не бывает.

### Когда режим отключается сам

`adaptive_unsupported_reason` возвращает причину, а хук выключает флаг, если: алгоритм не `EAGLE`/`EAGLE3`; `--speculative-eagle-topk` задан и не равен 1; включён `--enable-dp-attention` (решения по ступеням не синхронизированы между DP-рангами); включён `--enable-multi-layer-eagle` (его воркер adaptive не реализует); включён `--enable-two-batch-overlap`; включён `--enable-pdmux`.

## Значения и формат

- Булев флаг без значения. `--speculative-adaptive` включает, отсутствие выключает.
- Отключение движком не приводит к падению: сервер поднимется на статических параметрах, и единственный признак — предупреждение в логе.
- Взаимодействие с явными параметрами: `--speculative-num-steps` разрешено задавать, но только значением из лестницы — это стартовая ступень. `--speculative-num-draft-tokens` задавать бессмысленно, он будет перезаписан как `steps + 1`.
- Лестница может содержать `0`: нулевая ступень означает отключение драфтинга на этом диапазоне BS, политика периодически пробует подняться обратно.

## Когда использовать

- Трафик неоднородный: чередуются короткие интерактивные запросы (высокий accept) и пакетные прогоны (низкий), а BS плавает. Одно статическое значение шагов там всегда компромисс.
- Модель с MTP-головой и `topk=1` — единственная конфигурация, где режим вообще применим без оговорок.
- Не включать при стабильной нагрузке с уже подобранным `--speculative-num-steps`: выигрыша не будет, а стартовая память вырастет на все лишние ступени.
- Не включать, если VRAM в обрез: каждая ступень лестницы — это отдельный набор CUDA graph'ов.
- Не включать вместе с `--enable-dp-attention`: флаг просто выключится, а вы будете думать, что режим работает.

## Влияние на производительность и память

- VRAM: растёт на старте — буферы размеряются по `max(candidate_steps) + 1` draft-токенов, и графы захватываются для каждой достижимой ступени. Узкая лестница (`[1, 3]`) дешевле широкой (`[0, 1, 3, 7]`).
- Время старта: пропорционально числу ступеней — каждый набор графов захватывается отдельно.
- Throughput/latency: выигрыш там, где статическая настройка была бы неверна для текущего BS; при высоких BS политика обычно уходит на маленькие шаги и экономит впустую потраченную draft-работу.
- Переключение ступени само по себе дешёвое: это подмена ссылок, без перезахвата графов.

## Взаимодействие с другими аргументами

- `--speculative-adaptive-config`: лестницы кандидатов и коэффициенты политики. Без него используется встроенный дефолт.
- `--speculative-num-steps`: стартовая ступень, обязана входить в лестницу.
- `--speculative-eagle-topk`: должен быть 1 (или не задан — тогда подставится 1).
- `--speculative-num-draft-tokens`: перезаписывается в `steps + 1`.
- `--speculative-algorithm`: только `EAGLE` и `EAGLE3`.
- `--enable-multi-layer-eagle`, `--enable-dp-attention`, `--enable-two-batch-overlap`, `--enable-pdmux`: каждый из них выключает adaptive.
- `--cuda-graph-max-bs-decode` и `--disable-cuda-graph`: определяют, для каких BS вообще есть графы; политика привязывает диапазоны BS к захваченным размерам.

## Типовые проблемы и диагностика

- `speculative_adaptive disabled: speculative_algorithm=DFLASH (only EAGLE/EAGLE3 are supported). Falling back to static speculative params.` — режим не включился; текст в скобках называет ровно ту причину, которую надо устранить.
- `--speculative-num-steps=5 is not in the adaptive config candidate_steps [1, 3, 7]. Pass one of those values.` — стартовая ступень вне лестницы.
- OOM на захвате графов сразу после включения флага — сузьте лестницу в конфиге или уменьшите `--cuda-graph-max-bs-decode`.
- Что смотреть: `AdaptiveSpeculativeParams initialized: steps=…, candidate_steps=[…]` на старте, `Adaptive spec params updated: steps A -> B (ema_accept_len=…)` при каждом переключении, `Switch adaptive runtime state: steps A -> B, draft_tokens X -> Y`. Текущая ступень видна в `GET /server_info` (`internal_states[0].speculative_num_steps`) рядом с `avg_spec_accept_length`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Llama-3.1-8B-Instruct --speculative-algorithm EAGLE --speculative-draft-model-path /models/EAGLE-LLaMA3.1-Instruct-8B --speculative-eagle-topk 1 --speculative-num-steps 3 --speculative-adaptive
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --speculative-algorithm EAGLE3 --speculative-draft-model-path /models/Qwen3-30B-A3B-EAGLE3 --speculative-eagle-topk 1 --speculative-adaptive --speculative-adaptive-config /etc/arriero/adaptive-spec.json --cuda-graph-max-bs-decode 32
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/speculative_hook.py`
- `sglang/python/sglang/srt/speculative/adaptive_spec_params.py`
- `sglang/python/sglang/srt/speculative/adaptive_runtime_state.py`
- `sglang/python/sglang/srt/speculative/eagle_worker_v2.py`
- `sglang/python/sglang/srt/runtime_context.py`
- `sglang/python/sglang/srt/model_executor/runner/eager_runner.py`
- `sglang/docs/docs/advanced_features/adaptive_speculative_decoding.mdx`
