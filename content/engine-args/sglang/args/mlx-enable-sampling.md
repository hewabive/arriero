---
schema: 1
engine: sglang
primaryName: "--mlx-enable-sampling"
title: "--mlx-enable-sampling"
summary: Включает настоящее сэмплирование внутри MLX-графа на Apple Silicon вместо жадного argmax, попутно открывая грамматики, logit_bias и logprobs. Вне MLX-пути не делает ничего.
group: device
related:
  - --device
  - --enable-deterministic-inference
  - --random-seed
  - --sampling-backend
  - --disable-overlap-schedule
---

# --mlx-enable-sampling

## Кратко

Аргумент относится только к MLX-пути (Apple Silicon, `SGLANG_USE_MLX=1` и устройство `mps`). Без него MLX-runner выдает жадный argmax независимо от `temperature`/`top_p` в запросе. С ним сэмплирование выполняется внутри ленивого MLX-графа — то есть совместимо с overlap-планировщиком — и попутно включается набор возможностей, которые на этом пути иначе недоступны: маски грамматики, пользовательские logit-процессоры, `logit_bias`, выходные logprobs и позапросное зерно. Штрафы (repetition/frequency/presence) не применяются ни при каком значении флага.

## Оригинальная справка

```text
MLX backend only: sample decode tokens (temperature / top-k / top-p / min-p) instead of greedy argmax. Sampling runs inside the lazy MLX graph, so it works with the overlap scheduler; first tokens from prefill/extend are sampled too. Greedy requests keep exact argmax behavior. Also enables on the MLX path: grammar vocab masks and custom logit processors (these break decode chaining per step; custom processors run on pure-decode steps only), logit_bias, output logprobs (sampled token / top-k / token_ids; prompt input logprobs are not computed), NaN sanitization (SGLANG_SANITIZE_NAN_LOGITS), and per-request sampling_seed under --enable-deterministic-inference (deterministic within MLX only). Penalties are not applied.
```

## Паспорт аргумента

- Флаги: `--mlx-enable-sampling`
- Группа: `device`
- Тип значения: bool (`store_true`)
- Допустимые значения: флаг без значения; парного отключающего флага нет
- Значение по умолчанию: `False`
- Эффективное значение: совпадает с заданным; ни один `_handle_*` его не переписывает. Практически он бездействует, если MLX-путь не активен: `use_mlx()` требует одновременно `SGLANG_USE_MLX=1` и импортируемый пакет `mlx`
- Где объявлен: `ServerArgs.mlx_enable_sampling`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, платформенно-специфичный (Apple Silicon / MLX)
- Этап применения: конструктор MLX-воркера (`MlxModelRunner(enable_sampling=…)`), затем каждый шаг цикла `event_loop_overlap_mlx` и проверка запроса в `Scheduler`

## Что меняет в движке

Значение читается в трех местах (`sglang/python/sglang/srt/hardware_backend/mlx/`):

- `tp_worker.py`: `MlxModelRunner(enable_sampling=get_device().mlx_enable_sampling, sampling_rng_seed=get_device().random_seed, deterministic_seeding=…)` — сэмплирование становится частью MLX-графа, туда же уходит глобальное зерно;
- `tp_worker.py`, предикат применения sampling_info к батчу — `get_device().mlx_enable_sampling and batch.sampling_info is not None`;
- `scheduler_mixin.py`, `_mlx_batch_chain_safe`: при включенном сэмплировании батч с грамматикой или пользовательским logit-процессором **не** может быть построен заранее (chained decode), потому что маска зависит от только что выданного токена. Такие батчи запускаются каждый шаг заново — это и есть упомянутая в справке потеря цепочки.

Отдельная проверка живет в `Scheduler` (`sglang/python/sglang/srt/managers/scheduler.py`): при включенном флаге запрос с `logprob_start_len` внутри промпта отклоняется с

```text
Prompt input logprobs (logprob_start_len) are not supported on the MLX sampling path; omit logprob_start_len to get output logprobs.
```

Это отказ конкретного запроса (`set_finish_with_abort`), а не отказ сервера.

Запросы с `temperature = 0` и на включенном флаге сохраняют точный argmax — переключение не меняет их результат.

## Значения и формат

- Булев флаг без значения; «выключено» = не указывать.
- Флаг не включает сам MLX-путь. Тот активируется переменной `SGLANG_USE_MLX=1` при доступном пакете `mlx`; устройство при этом — `mps` (см. `_handle_mps_backends`).
- На CUDA/ROCm/NPU флаг принимается argparse и молча не делает ничего: на этих устройствах сэмплирование выполняет обычный `sampling_backend`.
- Смежные переменные окружения: `SGLANG_SANITIZE_NAN_LOGITS` (санитизация NaN в логитах — включается на MLX-пути этим же флагом).

## Когда использовать

- Работа на Apple Silicon через MLX, когда нужны не жадные ответы: любой сценарий с `temperature > 0`, `top_p`, `top_k`, `min_p`.
- Нужны структурированные ответы (JSON-схема, регулярка) или `logit_bias` на MLX — без флага соответствующие механизмы на этом пути не подключаются.
- Нужны выходные logprobs (по выданному токену, top-k, идентификаторы) — но не входные: их MLX-путь не считает.
- Не включать, если сервис заведомо работает только на `temperature 0` и важна максимальная скорость: цепочка decode-шагов остается целой, а лишней работы по сэмплированию нет.
- Не рассчитывать на штрафы повторов: `Penalties are not applied` — это ограничение реализации, а не настройка.

## Влияние на производительность и память

- Пропускная способность: сэмплирование выполняется внутри ленивого графа MLX, поэтому overlap-планировщик сохраняется и в обычном случае замедления почти нет.
- Заметная просадка появляется на запросах с грамматикой или пользовательскими logit-процессорами: `_mlx_batch_chain_safe` возвращает False, цепочка decode-шагов рвется, и каждый шаг строится заново. Пользовательские процессоры к тому же выполняются только на чисто-decode-шагах.
- Память: дополнительных пулов не создается; накладные расходы — буферы масок словаря при использовании грамматик.
- Время старта: не меняется.
- На CUDA-профиле (в том числе на профиле KTransformers в arriero) влияние отсутствует: код MLX не выполняется.

## Взаимодействие с другими аргументами

- `--device`: смысл появляется только на `mps` при активном MLX; `_handle_mps_backends` без MLX дополнительно включает `--disable-overlap-schedule`.
- `--random-seed`: значение уходит в MLX как `sampling_rng_seed`, то есть задает начальное состояние генератора сэмплирования.
- `--enable-deterministic-inference`: включает поддержку позапросного `sampling_seed` на MLX-пути; детерминизм гарантируется только внутри MLX.
- `--sampling-backend`: относится к обычному (torch) пути и на MLX не действует; путать их не следует.
- `--disable-overlap-schedule`: MLX-сэмплирование специально сделано совместимым с overlap-циклом, поэтому отключать его ради этого флага не требуется.

## Типовые проблемы и диагностика

- Ответы одинаковы при `temperature 0.8` на Apple Silicon — флаг не задан, работает argmax. Проверьте `mlx_enable_sampling=` в дампе `server_args=`.
- Запрос отклонен с `Prompt input logprobs (logprob_start_len) are not supported on the MLX sampling path…` — уберите `logprob_start_len` из запроса; выходные logprobs при этом продолжают работать.
- Флаг задан, а поведение не изменилось на CUDA-хосте — так и должно быть: аргумент относится только к MLX.
- Просадка throughput после включения грамматик — следствие разрыва цепочки decode-шагов (см. выше), а не дефект.
- Штрафы повторов не применяются — заявленное ограничение MLX-пути.
- Что смотреть в логе: `Initializing MlxModelRunner for end-to-end MLX inference` подтверждает, что MLX-путь активен; `mlx_enable_sampling=` в дампе `server_args=` — что флаг принят.

## Примеры

```bash
SGLANG_USE_MLX=1 python -m sglang.launch_server --model-path /models/Qwen3-8B --device mps --mlx-enable-sampling
```

```bash
SGLANG_USE_MLX=1 python -m sglang.launch_server --model-path /models/Qwen3-8B --device mps --mlx-enable-sampling --random-seed 42 --enable-deterministic-inference
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/hardware_backend/mlx/tp_worker.py`
- `sglang/python/sglang/srt/hardware_backend/mlx/scheduler_mixin.py`
- `sglang/python/sglang/srt/managers/scheduler.py`
- `sglang/python/sglang/srt/utils/tensor_bridge.py`
- `sglang/python/sglang/srt/environ.py`
