---
schema: 1
engine: sglang
primaryName: "--mamba-ssm-dtype"
title: "--mamba-ssm-dtype"
summary: Тип рекуррентного (SSM) состояния гибридных моделей — прямой множитель размера слота в пуле mamba-состояний. Задается только для гибридов; переключение fp32 → bf16 ровно вдвое удешевляет слот и вдвое увеличивает емкость пула при том же бюджете.
group: exec.mamba
related:
  - --max-mamba-cache-size
  - --mamba-full-memory-ratio
  - --mem-fraction-static
  - --linear-attn-decode-backend
  - --linear-attn-verify-backend
  - --enable-mamba-cache-stochastic-rounding
  - --enable-linear-replayssm-spec
  - --enable-int8-mamba-checkpoint
  - --mamba-backend
---

# --mamba-ssm-dtype

## Кратко

Гибридные архитектуры (mamba2, gated delta net, KDA, lightning attention) держат на каждую последовательность не KV, а рекуррентное состояние фиксированного размера. `--mamba-ssm-dtype` задает тип временнóй (temporal) части этого состояния и тем самым напрямую определяет, сколько байт стоит один слот пула. Это отдельный от KV-пула объем памяти: он вычитается из бюджета до расчета `max_total_num_tokens` (см. `--mamba-full-memory-ratio` и `--max-mamba-cache-size`). Кроме памяти аргумент работает переключателем совместимости: половина ускоренных linear-attn ядер требует именно `bfloat16`, стохастическое округление — именно `float16`, а точная спекулятивная сверка ReplaySSM — `float32`.

## Оригинальная справка

```text
The data type of the SSM states in mamba cache. If not set, will be read from model config (mamba_ssm_dtype).
```

## Паспорт аргумента

- Флаги: `--mamba-ssm-dtype`
- Группа: `exec.mamba`
- Тип значения: строка с фиксированным списком (`Optional[str]`)
- Допустимые значения: `float32`, `bfloat16`, `float16`
- Значение по умолчанию: `null` — берется из конфига модели (`mamba_ssm_dtype`, у VL-моделей — из `text_config`), а если и там нет, то `float32`
- Эффективное значение: заданное CLI значение переносится в переменную окружения `SGLANG_MAMBA_SSM_DTYPE` (`_handle_environment_variables`), а в `mamba2_state_dtype` переменная окружения имеет **высший** приоритет — то есть CLI перекрывает конфиг модели. Обратное направление тоже есть: `--enable-linear-replayssm-spec` при незаданном аргументе принудительно ставит `float32`
- Где объявлен: `ServerArgs.mamba_ssm_dtype`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (проверки в `_handle_mamba_backend` и `_handle_linear_attn_backend`, запись переменной окружения) → построение `Mamba2CacheParams` при чтении конфига модели → выделение пула состояний (`MambaPool`) до расчета KV-пула

## Что меняет в движке

### Приоритет источников

`mamba2_state_dtype(config)` (`sglang/python/sglang/srt/configs/mamba_utils.py`) собирает тип в три шага: значение по умолчанию `float32` → `config.mamba_ssm_dtype` из HF-конфига модели → переменная окружения `SGLANG_MAMBA_SSM_DTYPE`, которую и пишет этот аргумент. Неизвестная строка в конфиге модели не роняет старт, а печатает warning `Invalid mamba_ssm_dtype '…' in config.` и откатывается на `float32`; из CLI неизвестное значение отвергает argparse.

Тип conv-части состояния этим аргументом **не** управляется: она берется из отдельной переменной окружения `SGLANG_MAMBA_CONV_DTYPE` со значением по умолчанию `bfloat16`, CLI-флага у нее нет.

### Сколько это стоит в байтах

Размер одного слота считает `BaseLinearStateParams.mamba_cache_per_req`:

```python
(conv_numel * conv_dtype.itemsize + ssm_numel * ssm_dtype.itemsize) * len(layers)
```

где `ssm_numel = HV * V * K` (число value-голов на ранг × размер value-головы × размер состояния), а `conv_numel` — сумма по conv-тензорам. Численно на Qwen3-Next-80B-A3B при `--tp-size 1`: temporal-форма `(32, 128, 128)` = 524 288 элементов на слой, conv — `(8192, 3)` = 24 576 элементов; линейных слоев 36 из 48. Итог на один слот пула:

| `--mamba-ssm-dtype` | temporal на слой | conv на слой | всего на слот |
| --- | --- | --- | --- |
| `float32` | 2 MiB | 48 KiB | 73.7 MiB |
| `bfloat16` / `float16` | 1 MiB | 48 KiB | 37.7 MiB |

При включенном radix-кеше на один запрос приходится от 3 до 5 слотов (`--max-mamba-cache-size`), так что разница в 36 MiB на слот превращается в 110–180 MiB на запрос. На карте 24 ГиБ это единицы одновременных запросов.

## Значения и формат

- `float32` — эталон точности и единственный тип, при котором закрытый пересчет ReplaySSM бит-в-бит совпадает с рекуррентной базой.
- `bfloat16` — вдвое дешевле и обязателен для FlashInfer-ядер линейного внимания на SM100+ (decode и verify).
- `float16` — вдвое дешевле, и это единственный тип, при котором работает `--enable-mamba-cache-stochastic-rounding`. Без округления накопление в fp16 на длинных последовательностях смещено систематически, именно от этого округление и защищает.
- Значение действует на все mamba/linear слои модели одинаково; per-layer настройки нет.
- На не-гибридной модели значение принимается и просто не используется.

## Когда использовать

- Задавать `bfloat16` осознанно, когда нужен FlashInfer-декод GDN на Blackwell: автоподстановка `--linear-attn-decode-backend flashinfer` на SM100+ срабатывает **только** при явно заданном `--mamba-ssm-dtype bfloat16` (проверяется поле `ServerArgs`, а не разрешенный тип из конфига модели).
- Задавать `bfloat16`, когда упирается емкость пула состояний: это самый дешевый способ удвоить число слотов, не забирая память у KV-пула.
- Не понижать до `float16` без `--enable-mamba-cache-stochastic-rounding`: выигрыш по памяти тот же, что у `bfloat16`, а динамический диапазон хуже.
- Не задавать вручную, если модель уже объявила `mamba_ssm_dtype` в своем конфиге и он вас устраивает: CLI перекроет объявление автора модели молча.

## Влияние на производительность и память

- VRAM: линейно определяет temporal-часть слота, то есть примерно 98 % его объема на GDN-моделях. Это отдельная от KV-пула статья, вычитаемая из бюджета первой.
- RAM хоста: не влияет напрямую; при `--enable-hierarchical-cache` host-пул состояний масштабируется вместе с device-пулом.
- Время старта: не меняет.
- Latency/throughput: `bfloat16`/`float16` уменьшают трафик HBM на чтение-запись состояния на каждом decode-шаге — эффект заметен на больших батчах, где decode упирается в пропускную способность памяти.
- Точность: понижение типа копится по шагам рекуррентности, а не по токенам контекста, поэтому деградация проявляется на длинных генерациях, а не на длинном промпте.

## Взаимодействие с другими аргументами

- `--max-mamba-cache-size` / `--mamba-full-memory-ratio`: делят бюджет; этот аргумент определяет цену одного слота, они — их количество.
- `--mem-fraction-static`: задает общий бюджет, из которого пул состояний вычитается до KV-пула.
- `--linear-attn-decode-backend flashinfer` и `--linear-attn-verify-backend flashinfer` на SM100+ требуют `bfloat16`, иначе `ValueError: --linear-attn-decode-backend flashinfer on SM100+ requires --mamba-ssm-dtype bfloat16, got …`.
- `--enable-mamba-cache-stochastic-rounding` требует ровно `float16`, иначе `ValueError` с текстом про `--mamba-ssm-dtype float16`.
- `--enable-linear-replayssm-spec`: при незаданном аргументе ставит `float32` (с info-строкой в логе); при любом другом значении печатает warning о возможном дрейфе состояния.
- `--enable-int8-mamba-checkpoint`: масштабы квантованных чекпоинтов хранятся в этом же типе, то есть `bfloat16` уменьшает и их.
- `--mamba-backend`: определяет ядро, работающее с состоянием этого типа.

## Типовые проблемы и диагностика

- `ValueError: --linear-attn-decode-backend flashinfer on SM100+ requires --mamba-ssm-dtype bfloat16, got None` — вы задали backend, но не тип состояния. Добавьте `--mamba-ssm-dtype bfloat16`.
- `ValueError: Stochastic rounding for the Mamba SSM cache requires --mamba-ssm-dtype float16, got 'bfloat16'.`
- В логе появилось `--enable-linear-replayssm-spec: setting --mamba-ssm-dtype float32 …` — движок сам поднял тип; учтите удвоение размера слота при планировании памяти.
- `RuntimeError: Not enough GPU memory for hybrid (mamba/linear-attention) state cache.` с большим `mamba_cache_per_req` в тексте — слот слишком дорог для оставшегося бюджета; `bfloat16` уменьшает `mamba_cache_per_req` вдвое.
- Что смотреть в логе: строку `Mamba Cache is allocated. max_mamba_cache_size: N, conv_state size: … GB, ssm_state size: … GB` — соотношение этих двух чисел прямо показывает, какой тип реально применился, и итоговый дамп `server_args=`.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-Next-80B-A3B-Instruct --mamba-ssm-dtype bfloat16
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-Next-80B-A3B-Instruct --mamba-ssm-dtype float16 --mamba-backend flashinfer --enable-mamba-cache-stochastic-rounding
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/configs/mamba_utils.py`
- `sglang/python/sglang/srt/configs/qwen3_next.py`
- `sglang/python/sglang/srt/mem_cache/memory_pool.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_configurator.py`
- `sglang/python/sglang/srt/environ.py`
