---
schema: 1
engine: vllm
primaryName: "--enable-mamba-cache-stochastic-rounding"
title: "--enable-mamba-cache-stochastic-rounding"
summary: Включает стохастическое округление при записи состояния SSM в fp16-кеш, чтобы ошибка округления не накапливалась систематически на длинных последовательностях. Требует fp16-кеша, CUDA, а с Triton-backend'ом — карты SM 10.x.
group: MambaConfig
related:
  - --mamba-cache-philox-rounds
  - --mamba-backend
  - --mamba-ssm-cache-dtype
  - --mamba-ssu-algorithm
  - --use-replayssm
---

# --enable-mamba-cache-stochastic-rounding

## Кратко

Состояние SSM считается в fp32, а хранится в кеше в fp16. Обычное округление «к ближайшему» систематически смещает результат в одну сторону, и на длинной последовательности decode-шагов это смещение накапливается. Стохастическое округление подмешивает случайные биты, так что ошибка становится несмещённой.

Ручка численной устойчивости, а не производительности. Условия применимости жёсткие: кеш состояния обязан быть `float16`, платформа — CUDA, а с Triton-backend'ом ещё и карта семейства SM 10.0 (data center Blackwell), потому что округление реализовано PTX-инструкцией `cvt.rs`.

## Оригинальная справка

```text
Enable stochastic rounding when writing SSM state to fp16 cache.
Uses random bits to unbias the rounding error, which can improve
numerical stability for long sequences.
```

## Паспорт аргумента

- Флаги: `--enable-mamba-cache-stochastic-rounding`, `--no-enable-mamba-cache-stochastic-rounding`
- Группа argparse: `MambaConfig`
- Тип значения: bool (`argparse.BooleanOptionalAction`)
- Допустимые значения: флаг ⇒ `True`, `--no-…` ⇒ `False`, не задан ⇒ `False`
- Значение по умолчанию: `False`
- Эффективное значение: не переопределяется, но обвешано тремя проверками, каждая из которых отказывает в старте. `MambaConfig.__post_init__` требует CUDA-платформу и — при `--mamba-backend triton` — `is_device_capability_family(100)`. `VllmConfig.__post_init__` дополнительно требует `mamba_ssm_cache_dtype == "float16"`. Кроме того, в Triton-ядре округление применяется только на не-спекулятивной ветке записи состояния
- Где объявлен: `vllm/config/mamba.py:MambaConfig.enable_stochastic_rounding`
- Этап применения: сборка `VllmConfig` (валидация) → каждый decode-шаг Mamba-слоя при записи состояния в кеш

## Что меняет в движке

Флаг доходит до ядра двумя путями.

**Triton (`vllm/model_executor/layers/mamba/ops/mamba_ssm.py`).** `selective_state_update` генерирует случайное зерно (`torch.randint(0, 2**32, (1,), device=state.device)`) и передаёт его в ядро вместе с `USE_RS_ROUNDING=True`. Внутри ядра, на ветке `not IS_SPEC_DECODING`, для каждого элемента состояния вычисляется случайное 32-битное число `tl.randint(rand_seed, rand_offsets[, PHILOX_ROUNDS])`, после чего fp32-значение конвертируется в fp16 инструкцией

```
cvt.rs.f16x2.f32
```

Это и есть аппаратное стохастическое округление; инструкции нет на картах вне семейства SM 10.x, отсюда и ограничение по compute capability. Без флага на той же ветке выполняется обычное `state.to(dtype)`.

**FlashInfer (`ssu_dispatch.py`).** Зерно генерируется так же, но передаётся в `flashinfer.mamba.selective_state_update` параметром `rand_seed`; аппаратного ограничения по SM здесь нет, поэтому `--mamba-backend flashinfer` — штатный способ получить округление вне data center Blackwell (это прямо сказано в тексте ошибки vLLM).

**ReplaySSM.** Ядро `selective_state_update_replayssm_output_only` не проходит через диспетчер SSU, поэтому `mamba_mixer2.py` передаёт ему `enable_stochastic_rounding` и `cache_philox_rounds` напрямую.

Зерно берётся из `torch.randint` без привязки к `--seed`, поэтому включение округления делает вывод невоспроизводимым от запуска к запуску даже при нулевой температуре.

## Значения и формат

- Булев флаг без значения; парный `--no-…` явно подтверждает выключение.
- «Не задан» = `False` = обычное округление к ближайшему.
- Флаг бессмысленно включать при `--mamba-ssm-cache-dtype`, отличном от `float16`: это отказ на старте, а не тихое игнорирование. Значение `auto` тоже не подходит — требуется именно явный `float16`.
- Качество случайных чисел настраивается отдельным аргументом `--mamba-cache-philox-rounds`.
- На модели без Mamba1/Mamba2-групп флаг проходит валидацию (проверки смотрят только на платформу, backend и dtype кеша), но ни одно ядро его не прочитает.

## Когда использовать

- **Длинный контекст на гибридной SSM-модели с fp16-состоянием.** Систематический дрейф состояния — реальная проблема на десятках тысяч токенов; несмещённая ошибка растёт как случайное блуждание, а не линейно.
- **Диагностика деградации качества на длинных последовательностях.** Если ответы «расползаются» ближе к концу длинного контекста, это дешёвая проверка гипотезы: включить округление и сравнить.
- **Не включайте ради скорости.** Эффект строго противоположный: ядро дополнительно генерирует случайные числа на каждый элемент состояния.
- **Не включайте, если нужна воспроизводимость.** Зерно случайное на каждый вызов и не связано с `--seed`.
- **Не используйте как замену fp32-состоянию.** Если карта позволяет, `--mamba-ssm-cache-dtype float32` устраняет проблему прямо, ценой вдвое большего кеша состояний.

## Влияние на производительность и память

- **VRAM.** Не меняет: состояние по-прежнему fp16, размер кеша тот же. Именно в этом смысл — сохранить экономию fp16 без систематического смещения.
- **Latency decode.** Небольшая, но реальная надбавка: генерация случайного 32-битного числа на каждый элемент состояния плюс конверсия через `cvt.rs`. Величина зависит от `--mamba-cache-philox-rounds`.
- **Время старта.** Не влияет.
- **Численность.** Меняет её намеренно: ошибка округления становится несмещённой, но результат перестаёт быть детерминированным между запусками.

## Взаимодействие с другими аргументами

- `--mamba-ssm-cache-dtype`: обязателен `float16`, иначе `ValueError: Stochastic rounding for Mamba cache requires the SSM cache to be float16. Please set it explicitly, by specifying --mamba-ssm-cache-dtype float16, or disable stochastic rounding ...`
- `--mamba-backend`: с `triton` требуется SM 10.x; с `flashinfer` ограничения по compute capability нет; с `cpu` округление недоступно (валидация требует CUDA-платформу).
- `--mamba-cache-philox-rounds`: число раундов Philox для генератора. На Triton-пути `0` означает дефолт Triton, на FlashInfer-пути `0` подменяется на `10`.
- `--mamba-ssu-algorithm`: независимая настройка того же FlashInfer-ядра; сочетается свободно.
- `--use-replayssm`: путь replay получает флаг напрямую из `mamba_mixer2`, минуя диспетчер; при этом `--use-replayssm` сам по себе требует Triton-backend, а значит и SM 10.x для округления.
- `--seed`: на зерно округления не влияет — оно берётся из `torch.randint` на каждый вызов ядра.

## Типовые проблемы и диагностика

- **Симптом:** `ValueError: Stochastic rounding for Mamba cache with triton backend requires compute capability 10.0 (data center Blackwell). The cvt.rs PTX instruction is not supported on your GPU. Please do not specify --enable-mamba-cache-stochastic-rounding, or set --mamba-backend flashinfer.` **Причина:** карта вне семейства SM 10.x. **Лечение:** ровно то, что предлагает сообщение.
- **Симптом:** `ValueError: Stochastic rounding for Mamba cache is only supported on NVIDIA CUDA platforms.` **Причина:** ROCm/CPU/XPU-инстанс. **Лечение:** снять флаг.
- **Симптом:** `ValueError: Stochastic rounding for Mamba cache requires the SSM cache to be float16.` **Лечение:** добавить `--mamba-ssm-cache-dtype float16` либо снять флаг.
- **Симптом:** флаг включён, ответы перестали быть воспроизводимыми при temperature 0. **Причина:** случайное зерно на каждый вызов ядра — ожидаемое поведение. **Лечение:** выключить округление, если нужна побитовая воспроизводимость.
- **Симптом:** включили, а на качестве длинного контекста никак не сказалось. **Причина:** возможно, у модели нет Mamba1/Mamba2-групп (флаг валидируется независимо от состава модели) либо путь спекулятивного декодирования, где Triton-ядро округление не применяет. **Проверка:** состав групп KV-cache в стартовом логе.
- **Подтверждение принятого значения:** отдельной строки в логе нет — движок лишь не падает на трёх валидациях. Косвенно: стартовая строка конфига содержит `enable_stochastic_rounding=True` в `MambaConfig`.

## Примеры

```bash
vllm serve /models/Nemotron-H-8B --enable-mamba-cache-stochastic-rounding --mamba-ssm-cache-dtype float16 --mamba-backend flashinfer
```

```bash
vllm serve /models/Nemotron-H-8B --enable-mamba-cache-stochastic-rounding --mamba-ssm-cache-dtype float16 --mamba-cache-philox-rounds 7 --max-model-len 65536
```

## Источники

- `vllm/vllm/config/mamba.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/model_executor/layers/mamba/ops/mamba_ssm.py`
- `vllm/vllm/model_executor/layers/mamba/ops/ssu_dispatch.py`
- `vllm/vllm/model_executor/layers/mamba/mamba_mixer2.py`
- `vllm/vllm/platforms/interface.py`
