---
schema: 1
engine: sglang
primaryName: "--mlx-enable-sampling"
title: "--mlx-enable-sampling"
summary: Включает настоящий sampling в MLX-runner вместо постоянного greedy argmax и проводит sampling внутри lazy MLX graph. Заодно активирует MLX-пути grammar masks, logit bias, custom processors и output logprobs, но penalties пока игнорируются.
group: device
related:
  - --device
  - --enable-deterministic-inference
  - --random-seed
  - --disable-overlap-schedule
---

# --mlx-enable-sampling

## Кратко

Без флага MLX backend выбирает токен точным `argmax`, даже если запрос передал temperature/top-k/top-p/min-p. Флаг включает request-level sampling внутри lazy MLX graph и сохраняет совместимость с overlap scheduler; токен после prefill/extend также сэмплируется, а не принудительно выбирается greedily.

Это opt-in для молодого MLX-пути. Greedy-запросы (`temperature=0`) остаются точным argmax. Frequency, presence и repetition penalties в текущей реализации не применяются.

## Оригинальная справка

```text
MLX backend only: sample decode tokens (temperature / top-k / top-p / min-p) instead of greedy argmax. Sampling runs inside the lazy MLX graph, so it works with the overlap scheduler; first tokens from prefill/extend are sampled too. Greedy requests keep exact argmax behavior. Also enables on the MLX path: grammar vocab masks and custom logit processors (these break decode chaining per step; custom processors run on pure-decode steps only), logit_bias, output logprobs (sampled token / top-k / token_ids; prompt input logprobs are not computed), NaN sanitization (SGLANG_SANITIZE_NAN_LOGITS), and per-request sampling_seed under --enable-deterministic-inference (deterministic within MLX only). Penalties are not applied.
```

## Паспорт аргумента

- Флаги: `--mlx-enable-sampling`
- Группа: `device`
- Тип значения: bool, флаг без значения
- Значение по умолчанию: `false`
- Где объявлен: `ServerArgs.mlx_enable_sampling`
- Этап применения: создание `MlxModelRunner` → регистрация sampling params при prefill → lazy graph каждого sampled шага → обработка output logprobs

## Что меняет в движке

`MlxTpModelWorker` передаёт `enable_sampling` в `MlxModelRunner`. При активном sampling runner строит для каждой строки temperature/top-k/top-p/min-p, применяет grammar mask и `logit_bias`, санитизирует NaN/Inf и выбирает токен MLX-операциями. Для batch с одними greedy-запросами остаётся быстрый argmax.

Grammar и custom logit processor зависят от предыдущего материализованного токена. Поэтому такие batch'и нельзя chained-decode'ить внутри overlap queue: scheduler запускает свежий шаг. Custom processor исполняется только на pure-decode, не на первом токене prefill/extend.

Output logprobs поддерживают sampled token, top-k и явно запрошенные token IDs. Prompt input logprobs не вычисляются: запрос с `return_logprob` и `logprob_start_len` внутри prompt завершается контролируемой ошибкой в scheduler.

## Значения и формат

- Флаг передаётся без значения и имеет смысл только для MLX backend.
- `temperature=0` в самом запросе сохраняет deterministic argmax.
- `top_k` до 1024 использует bounded candidate path; более широкий top-k переходит к full-vocab обработке.
- Penalties принимаются request schema, но игнорируются; один раз пишется warning.
- `sampling_seed` учитывается только вместе с `--enable-deterministic-inference`; без request seed применяется 42. Детерминизм ограничен MLX и не обещает совпадения с CUDA backend.

## Когда использовать

- Обязательно включайте, если MLX-сервер должен обслуживать ненулевую temperature или top-k/top-p/min-p.
- Включайте для grammar-constrained generation, `logit_bias`, custom logit processors или output logprobs на MLX.
- Не включайте ради greedy-only workload: argmax уже является стандартным поведением, а дополнительный sampling state пользы не даёт.
- Не используйте, если точная семантика repetition/frequency/presence penalties обязательна.

## Влияние на производительность и память

Sampling добавляет обработку logits и RNG state в lazy graph. Bounded top-k сокращает временные candidate tensors, но top-p/min-p и большой top-k могут работать по всему vocabulary. Grammar/custom processor запрещают decode chaining на каждом шаге и поэтому заметно увеличивают CPU↔MLX synchronization и latency. На KV-cache и объём весов флаг не влияет.

## Взаимодействие с другими аргументами

- `--device`: вне MLX флаг не выбирает backend и практического эффекта не имеет.
- `--enable-deterministic-inference`: включает per-request seed contract; воспроизводимость остаётся только внутри одной MLX-конфигурации.
- `--random-seed`: передаётся как seed базового sampling RNG runner'а.
- `--disable-overlap-schedule`: не требуется; обычные sampled batch'и совместимы с overlap, а grammar/custom processor точечно запрещают chaining сами.

## Типовые проблемы и диагностика

- Ответ всегда greedy при `temperature > 0` — проверьте `mlx_enable_sampling=True` в `server_args=` и что реально выбран MLX-runner.
- `MLX sampling ignores frequency/presence/repetition penalties` — это известное ограничение, а не незаметно применённая настройка.
- `Prompt input logprobs ... are not supported on the MLX sampling path` — уберите `logprob_start_len`; output logprobs можно оставить.
- Рост latency только с grammar/custom processor объясняется отключением decode chaining на каждый шаг.

## Примеры

```bash
SGLANG_USE_MLX=1 python -m sglang.launch_server --model-path /models/Qwen3-4B --disable-cuda-graph --mlx-enable-sampling
```

```bash
SGLANG_USE_MLX=1 python -m sglang.launch_server --model-path /models/Qwen3-4B --disable-cuda-graph --mlx-enable-sampling --enable-deterministic-inference --random-seed 7
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/hardware_backend/mlx/sampling.py`
- `sglang/python/sglang/srt/hardware_backend/mlx/model_runner.py`
- `sglang/python/sglang/srt/hardware_backend/mlx/tp_worker.py`
- `sglang/python/sglang/srt/hardware_backend/mlx/scheduler_mixin.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/docs/docs/hardware-platforms/apple_metal.mdx`
