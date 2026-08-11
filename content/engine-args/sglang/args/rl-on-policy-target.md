---
schema: 1
engine: sglang
primaryName: "--rl-on-policy-target"
title: "--rl-on-policy-target"
summary: Подгоняет численность инференса под конкретный тренировочный стек, чтобы logprob'ы rollout'а совпадали с тренировочными. Включает детерминированный режим сам и дополнительно переводит RoPE, RMSNorm, активации и lm_head на «наивные» пути.
group: exec.deterministic
related:
  - --enable-deterministic-inference
  - --attention-backend
  - --sampling-backend
  - --disable-radix-cache
  - --tp-size
  - --enable-multimodal
  - --dtype
  - --enable-torch-compile
---

# --rl-on-policy-target

## Кратко

В RL-контуре rollout считает SGLang, а обучение — тренировочный фреймворк, и ядра у них разные. Даже при идентичных весах вероятности токенов расходятся, и предположение об on-policy тихо ломается. `--rl-on-policy-target` объявляет, под какой тренировочный стек нужно подстроить численность инференса: сегодня в списке ровно одно значение — `fsdp`.

Это более сильный режим, чем `--enable-deterministic-inference`: он включает его автоматически и вдобавок отказывается от целого ряда фьюзнутых ядер в пользу «наивных» torch-реализаций, чтобы порядок операций совпадал с тренировочным. Соответственно, и цена по скорости выше.

## Оригинальная справка

```text
The training system that SGLang needs to match for true on-policy.
```

## Паспорт аргумента

- Флаги: `--rl-on-policy-target`
- Группа: `exec.deterministic`
- Тип значения: строка с фиксированным списком (`Optional[str]`)
- Допустимые значения: `fsdp` (константа `RL_ON_POLICY_TARGET_CHOICES`; out-of-tree пакеты могут расширить список через `add_rl_on_policy_target_choices`, поэтому итоговый набор смотрите в `--help` установленной сборки)
- Значение по умолчанию: `null` — режим выключен
- Эффективное значение: совпадает с заданным, но **переписывает соседей**: `--enable-deterministic-inference` становится `true`, `SGLANG_VLM_CACHE_SIZE_MB` — `0`, `SGLANG_ENABLE_DETERMINISTIC_INFERENCE` — `True`
- Где объявлен: `ServerArgs.rl_on_policy_target`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (`_handle_deterministic_inference` — первым делом) → построение слоев модели (выбор реализаций) → каждый forward и sampling

## Что меняет в движке

### Первым делом — детерминированный режим

```python
if self.rl_on_policy_target is not None:
    logger.warning("Enable deterministic inference because of rl_on_policy_target.")
    self.enable_deterministic_inference = True
    envs.SGLANG_VLM_CACHE_SIZE_MB.set(0)
    envs.SGLANG_ENABLE_DETERMINISTIC_INFERENCE.set(True)
```

Дальше выполняется весь блок `--enable-deterministic-inference`: подмена batch-invariant ядер, `--sampling-backend pytorch`, ограничение списка `--attention-backend`, фиксированные split-тайлы, детерминированный NCCL при `--tp-size` больше 1. Все, что написано в справке того флага, действует и здесь.

### Что добавляется сверх детерминированного режима

- **RoPE** (`layers/rotary_embedding/base.py`): выбирается `forward_native` вместо фьюзнутого ядра, `apply_rotary_emb` оборачивается в `torch.compile(dynamic=True)`; таблица обратных частот считается **на CPU** и затем переносится на GPU — ровно так, как это делает референсная реализация HF.
- **Активации** (`layers/activation.py`): `SiluAndMul` переходит на `forward_native`.
- **RMSNorm** (`layers/layernorm.py`): при `fsdp` даже в batch-invariant режиме используется `forward_native` вместо `rms_norm_batch_invariant`. У Qwen2/Qwen3 нормы `q_norm`/`k_norm` дополнительно создаются с `weight_dtype=torch.float32` и `cast_x_before_out_mul=True`.
- **lm_head** (`layers/logits_processor.py`): логиты считаются как `hidden_states.bfloat16() @ lm_head.weight.T.bfloat16()` — явное приведение обеих сторон к bf16 вместо приведения к типу весов (из-за tie-weight тип весов менять нельзя).
- **Логпробы** (`layers/sampler.py`): `use_log_softmax_logprob = True`; логиты делятся на температуру в bf16 и проходят через `torch.log_softmax` — так же, как в тренере.
- **Мультимодальность**: fast image processor принудительно исполняется на CPU (`base_processor.py`), кеш VLM-фич обнуляется (`SGLANG_VLM_CACHE_SIZE_MB=0`), а mrope-позиции считаются по текстовой ветке даже при наличии мультимодального входа (`forward_batch_info.py`).

## Значения и формат

- Строка из списка; сегодня практически это `fsdp`.
- Не задан — режим выключен; это единственный способ его выключить.
- Задать `--rl-on-policy-target` и одновременно `--enable-deterministic-inference` не запрещено, второе просто избыточно.
- Часть эффектов реализована как ветки в конкретных моделях (Qwen2, Qwen3, SDAR, Step3.5, MossVL, Kimi K2.5): на модели без такой ветки подгонка будет частичной. Проверять нужно поиском `rl_on_policy_target` в файле своей модели в `sglang/python/sglang/srt/models/`.

## Когда использовать

- В RL-контуре, где rollout от SGLang сравнивается с логпробами тренера на FSDP, и расхождение ломает on-policy-предположение. Апстрим отмечает, что одного детерминированного режима недостаточно: тренер тоже нужно перевести на те же ядра.
- Для диагностики training–inference mismatch: включить, сравнить логпробы, увидеть, осталось ли расхождение.
- Не использовать в обычном обслуживании: режим отказывается от фьюзнутых RoPE, активаций и норм, а на мультимодальных моделях еще и переносит препроцессинг изображений на CPU.
- Не ожидать, что режим сам по себе сделает обучение on-policy: он подгоняет только сторону инференса.

## Влияние на производительность и память

- VRAM: наследует эффекты детерминированного режима (workspace FlashInfer 2 ГиБ, отсутствие piecewise-графа); дополнительно обнуляется кеш мультимодальных фич.
- RAM хоста: препроцессинг изображений на CPU нагружает хост и добавляет копирование.
- Время старта: `torch.compile` для `apply_rotary_emb` компилируется при первом использовании; таблица частот считается на CPU.
- Throughput: заметно ниже, чем у чистого `--enable-deterministic-inference`: наивные RoPE, SiLU и RMSNorm — это отказ от фьюзнутых ядер в самых частых точках.
- Latency: следует за throughput; на мультимодальных запросах дополнительно растет TTFT из-за CPU-препроцессинга.
- Точность: цель режима — совпадение с тренером, а не максимальная точность как таковая.

## Взаимодействие с другими аргументами

- `--enable-deterministic-inference`: включается автоматически со всеми своими переписываниями (`--sampling-backend`, `--attention-backend`, split-тайлы, radix-кеш, NCCL).
- `--attention-backend`: ограничен списком детерминированного режима; для DeepSeek-моделей `flashinfer` исключен.
- `--sampling-backend`: переписывается на `pytorch`.
- `--disable-radix-cache`: включается принудительно на backend'ах вне списка поддержки radix-кеша в детерминированном режиме.
- `--tp-size`: значение больше 1 включает детерминированный NCCL-путь.
- `--enable-multimodal`: препроцессинг изображений уходит на CPU, кеш VLM-фич обнуляется, mrope считается по текстовой ветке.
- `--dtype`: логиты lm_head в этом режиме считаются в bf16 независимо от типа весов.
- `--enable-torch-compile`: RoPE компилируется через `torch.compile` независимо от этого флага.

## Типовые проблемы и диагностика

- `argparse: invalid choice` — значение вне `RL_ON_POLICY_TARGET_CHOICES`; на сегодня допустим `fsdp`.
- Все ошибки детерминированного режима применимы и здесь: ограничение `--attention-backend`, несовместимость с `--speculative-use-rejection-sampling` и прочее.
- Резкое падение скорости на мультимодальных запросах — препроцессинг изображений переехал на CPU; это ожидаемо.
- Логпробы все равно расходятся с тренером — проверьте, есть ли в файле вашей модели ветки `rl_on_policy_target`; без них подгонка неполная, и вторую половину работы нужно делать на стороне тренера.
- Что смотреть в логе: `Enable deterministic inference because of rl_on_policy_target.` — первая строка режима, а дальше все строки детерминированного режима (`Sampling backend is set to pytorch …` и остальные) и итоговый дамп `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --rl-on-policy-target fsdp --attention-backend fa3
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-8B --rl-on-policy-target fsdp --attention-backend triton --tp-size 2
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/rotary_embedding/base.py`
- `sglang/python/sglang/srt/layers/activation.py`
- `sglang/python/sglang/srt/layers/layernorm.py`
- `sglang/python/sglang/srt/layers/logits_processor.py`
- `sglang/python/sglang/srt/layers/sampler.py`
- `sglang/python/sglang/srt/models/qwen3.py`
- `sglang/python/sglang/srt/multimodal/processors/base_processor.py`
- `sglang/python/sglang/srt/model_executor/forward_batch_info.py`
- `sglang/docs/docs/advanced_features/sglang_for_rl.mdx`
