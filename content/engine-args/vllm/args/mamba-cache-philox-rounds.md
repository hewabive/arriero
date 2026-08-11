---
schema: 1
engine: vllm
primaryName: "--mamba-cache-philox-rounds"
title: "--mamba-cache-philox-rounds"
summary: Число раундов генератора Philox, из которого берутся случайные биты для стохастического округления состояния SSM. Имеет смысл только вместе с `--enable-mamba-cache-stochastic-rounding`; `0` означает дефолт ядра.
group: MambaConfig
related:
  - --enable-mamba-cache-stochastic-rounding
  - --mamba-backend
  - --mamba-ssm-cache-dtype
  - --mamba-ssu-algorithm
  - --use-replayssm
---

# --mamba-cache-philox-rounds

## Кратко

Стохастическое округление состояния SSM требует случайных битов на каждый элемент состояния. Их даёт счётчиковый генератор Philox: чем больше раундов перемешивания, тем «случайнее» результат и тем дороже вычисление.

Аргумент задаёт это число. Он вторичен по отношению к `--enable-mamba-cache-stochastic-rounding` — без включённого округления значение никуда не доходит, потому что генерация случайных чисел в ядре выполняется только под флагом `USE_RS_ROUNDING`.

## Оригинальная справка

```text
Number of Philox PRNG rounds for stochastic rounding random number
generation. 0 uses the Triton default. Higher values improve randomness
quality at the cost of compute.
```

## Паспорт аргумента

- Флаги: `--mamba-cache-philox-rounds`
- Группа argparse: `MambaConfig`
- Тип значения: int
- Допустимые значения: не ограничены ни `choices`, ни валидатором конфига; вменяемые значения — от `0` (дефолт ядра) до примерно `10`
- Значение по умолчанию: `0`
- Эффективное значение: зависит от backend'а. Триггер переноса значения в `MambaConfig` — обычная проверка на истинность (`if self.mamba_cache_philox_rounds:`), поэтому `0` в `create_engine_config` не переносится вовсе. На Triton-пути `0` уходит в ядро как есть и означает «дефолт `tl.randint`»; на FlashInfer-пути `0` подменяется на `10` (`stochastic_rounding_philox_rounds or 10`)
- Где объявлен: `vllm/config/mamba.py:MambaConfig.stochastic_rounding_philox_rounds`
- Этап применения: каждый decode-шаг Mamba-слоя, внутри ядра записи состояния

## Что меняет в движке

**Triton.** Значение приходит в `_selective_scan_update_kernel` как constexpr `PHILOX_ROUNDS`. Ветка генерации:

```
if PHILOX_ROUNDS > 0:
    rand = tl.randint(rand_seed, rand_offsets, PHILOX_ROUNDS)
else:
    rand = tl.randint(rand_seed, rand_offsets)
```

То есть ноль — это не «ноль раундов», а «не передавать параметр, пусть Triton возьмёт своё значение». Полученные биты идут в `cvt.rs.f16x2.f32` — аппаратное стохастическое округление fp32 → fp16.

Поскольку `PHILOX_ROUNDS` объявлен как `tl.constexpr`, каждое различное значение порождает отдельную специализацию ядра при JIT-компиляции.

**FlashInfer.** `FlashInferSSUBackend` передаёт `philox_rounds=self._mamba_config.stochastic_rounding_philox_rounds or 10` в `flashinfer.mamba.selective_state_update`. Здесь `0` уже никогда не доходит до библиотеки.

**ReplaySSM.** `mamba_mixer2.py` передаёт `cache_philox_rounds` напрямую в `selective_state_update_replayssm_output_only` (там дефолт параметра тоже `0`), минуя диспетчер SSU.

Вне этих путей значение не читается: при выключенном стохастическом округлении ветка генерации случайных чисел в ядро не компилируется.

## Значения и формат

- Целое число. `0` — дефолт ядра (для Triton — внутренний дефолт `tl.randint`, для FlashInfer — принудительная десятка).
- Отрицательные значения формально пройдут разбор — ни pydantic-ограничения, ни проверки в конфиге у поля нет. На Triton-пути ветка `PHILOX_ROUNDS > 0` их не выберет, то есть эффект будет как у нуля; на FlashInfer-пути отрицательное значение уйдёт в библиотеку как есть. Задавать их незачем.
- Ориентир для «полного» перемешивания — 10 раундов: это и значение, которое FlashInfer-путь подставляет вместо нуля, и классический контрольный параметр Philox 4×32.
- Отдельной формы записи через контейнерный JSON-аргумент у `MambaConfig` в этом commit'е нет — задаётся только этим флагом.

## Когда использовать

- **Практически никогда.** Дефолт ядра подобран под задачу; это ручка для экспериментов с численной устойчивостью, а не эксплуатационная настройка.
- **Если стохастическое округление включено и подозревается, что дрейф состояния всё равно остался смещённым** — поднять значение (например до 10) и сравнить поведение на длинном контексте.
- **Если decode-шаг заметно подорожал после включения округления** — снизить до `0` и убедиться, что дело именно в генерации случайных чисел.
- **Не задавайте без `--enable-mamba-cache-stochastic-rounding`.** Ошибки не будет, эффекта тоже.

## Влияние на производительность и память

- **Latency decode.** Единственная точка приложения: раунды Philox выполняются на каждый элемент состояния при каждой записи в кеш. Рост стоимости линеен по числу раундов и наиболее заметен у моделей с крупным состоянием SSM.
- **VRAM.** Не влияет: ни размер состояния, ни размер кеша не меняются.
- **Время старта.** Косвенно: изменение constexpr-значения порождает новую специализацию Triton-ядра, то есть один дополнительный JIT-прогон.
- **Численность.** Больше раундов — лучше статистические свойства случайных битов, то есть более честная несмещённость ошибки округления. Воспроизводимость от этого не появляется: зерно всё равно случайное на каждый вызов.

## Взаимодействие с другими аргументами

- `--enable-mamba-cache-stochastic-rounding`: обязательное условие. Без него значение в ядро не попадает.
- `--mamba-backend`: определяет трактовку нуля — Triton оставляет дефолт ядра, FlashInfer подставляет `10`. На CPU-backend'е стохастическое округление недоступно вовсе.
- `--mamba-ssm-cache-dtype`: округление (а с ним и этот аргумент) работает только при `float16`.
- `--mamba-ssu-algorithm`: соседний параметр того же вызова FlashInfer-ядра; сочетается свободно.
- `--use-replayssm`: путь replay получает значение напрямую из `mamba_mixer2` и требует Triton-backend.

## Типовые проблемы и диагностика

- **Симптом:** задали значение, ничего не изменилось. **Причина:** не включён `--enable-mamba-cache-stochastic-rounding` — ветка генерации случайных чисел в ядре просто не активна. **Лечение:** включить округление.
- **Симптом:** decode стал медленнее после подъёма значения. **Причина:** ожидаемая цена дополнительных раундов. **Лечение:** вернуть `0`.
- **Симптом:** старт стал длиннее после смены значения. **Причина:** новая специализация Triton-ядра компилируется заново. Разово.
- **Симптом:** на FlashInfer-backend'е `0` и `10` ведут себя одинаково. **Причина:** так и есть — `or 10` подменяет ноль.
- **Подтверждение принятого значения:** отдельной строки в логе нет; косвенно значение видно в стартовой строке конфига как `stochastic_rounding_philox_rounds` внутри `MambaConfig`.

## Примеры

```bash
vllm serve /models/Nemotron-H-8B --enable-mamba-cache-stochastic-rounding --mamba-ssm-cache-dtype float16 --mamba-cache-philox-rounds 10
```

```bash
vllm serve /models/Nemotron-H-8B --enable-mamba-cache-stochastic-rounding --mamba-ssm-cache-dtype float16 --mamba-backend flashinfer --mamba-cache-philox-rounds 4
```

## Источники

- `vllm/vllm/config/mamba.py`
- `vllm/vllm/model_executor/layers/mamba/ops/mamba_ssm.py`
- `vllm/vllm/model_executor/layers/mamba/ops/ssu_dispatch.py`
- `vllm/vllm/model_executor/layers/mamba/ops/selective_state_update_replayssm_output_only.py`
- `vllm/vllm/model_executor/layers/mamba/mamba_mixer2.py`
- `vllm/vllm/engine/arg_utils.py`
