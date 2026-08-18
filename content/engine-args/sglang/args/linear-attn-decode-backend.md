---
schema: 1
engine: sglang
primaryName: "--linear-attn-decode-backend"
title: "--linear-attn-decode-backend"
summary: Переопределяет ядро линейного внимания для decode — самой горячей фазы гибридной модели. На SM100+ при явном `--mamba-ssm-dtype bfloat16` движок сам ставит здесь `flashinfer`, а унаследованный `flashkda` молча заменяет на `triton`.
group: exec.mamba
related:
  - --linear-attn-backend
  - --linear-attn-prefill-backend
  - --linear-attn-verify-backend
  - --mamba-ssm-dtype
  - --enable-linear-replayssm
  - --enable-linear-replayssm-spec
  - --enable-page-major-kv-layout
  - --mamba-radix-cache-strategy
---

# --linear-attn-decode-backend

## Кратко

Decode линейного внимания выполняется на каждом токене каждым линейным слоем и упирается в трафик рекуррентного состояния через HBM, а не в арифметику. Поэтому именно эта фаза чаще всего и требует специализированного ядра. Флаг переопределяет ядро только для нее, не трогая ни prefill, ни базу `--linear-attn-backend` (а значит, и стратегию кеша).

Два автоматических действия, о которых нужно знать: на SM100+ с явно заданным `--mamba-ssm-dtype bfloat16` незаданный decode-backend становится `flashinfer`; а если в decode пришло значение `flashkda` (например, унаследованное из базы), оно заменяется на `triton`, потому что у FlashKDA decode-ядра не существует.

## Оригинальная справка

```text
Override the kernel backend for linear attention decode. If not set, uses --linear-attn-backend.
```

## Паспорт аргумента

- Флаги: `--linear-attn-decode-backend`
- Группа: `exec.mamba`
- Тип значения: строка с фиксированным списком (`Optional[str]`)
- Допустимые значения: `triton`, `cutedsl`, `flashinfer`, `flashkda`, `nvidia_kda`, `ptx_kda` (общий список; фактически decode-ядра есть только у `triton`/`cutedsl`/`flashinfer`, в обеих семьях)
- Значение по умолчанию: `null` — берется `--linear-attn-backend`
- Эффективное значение: `_handle_linear_attn_backend` может записать `flashinfer` (SM100+ и `--mamba-ssm-dtype bfloat16`) либо `triton` (при унаследованном `flashkda`); обе подстановки печатают info-строку
- Где объявлен: `ServerArgs.linear_attn_decode_backend`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (`_handle_linear_attn_backend`) → создание backend'а внимания → каждый decode-шаг линейных слоев

## Что меняет в движке

### Автоподстановка FlashInfer

```python
if (self.linear_attn_decode_backend is None
        and is_sm100_supported()
        and self.mamba_ssm_dtype == "bfloat16"):
    self.linear_attn_decode_backend = "flashinfer"
```

Проверяется поле `ServerArgs`, то есть **явно заданный** `--mamba-ssm-dtype bfloat16`. Тот же bf16, унаследованный из конфига модели, автоподстановку не включает. В логе: `SM100+ detected with mamba-ssm-dtype=bfloat16, defaulting --linear-attn-decode-backend to flashinfer.`

### Замена FlashKDA

FlashKDA — prefill-only ядро. Если оно оказалось в decode:

- заданное явно (`--linear-attn-decode-backend flashkda`) → `ValueError: --linear-attn-decode-backend flashkda is not supported: FlashKDA is prefill-only. Use --linear-attn-prefill-backend flashkda (decode stays on triton).`
- унаследованное из базы → тихая замена на `triton` с info-строкой `FlashKDA is prefill-only; using triton for KDA decode (FlashKDA stays on prefill).`

### Проверка типа состояния

`flashinfer` в роли decode на карте с capability major ≥ 10 требует `--mamba-ssm-dtype bfloat16`, иначе `ValueError: --linear-attn-decode-backend flashinfer on SM100+ requires --mamba-ssm-dtype bfloat16, got …`. Та же проверка отдельно применяется к verify-backend'у, который по умолчанию наследует decode.

### Что доступно в каждой семье

- **GDN**: `triton`, `cutedsl`, `flashinfer`. Прочее — `ValueError: Unsupported GDN decode backend: …`.
- **KDA**: `triton`, `cutedsl`, `flashinfer`. Прочее — `ValueError: Unsupported KDA decode backend: …. KDA supports 'triton', 'cutedsl', or 'flashinfer'.`

Выбор decode-ядра тянет за собой verify: при незаданном `--linear-attn-verify-backend` verify равен `flashinfer`, если decode `flashinfer`, и `triton` во всех остальных случаях.

## Значения и формат

- Значение вне списка отвергает argparse.
- Не задан — берется база, но только после автоподстановки FlashInfer.
- `flashkda` здесь запрещен явно; его место — `--linear-attn-prefill-backend`.
- `nvidia_kda` и `ptx_kda` в decode приведут к `Unsupported … decode backend` в обеих семьях: у них есть только prefill-ядра.
- На модели без линейного внимания значение принимается и не используется.

## Когда использовать

- Задавать `flashinfer` вместе с `--mamba-ssm-dtype bfloat16` на Blackwell, если автоподстановка почему-то не сработала (например, тип состояния приходит из конфига модели, а не из CLI).
- Оставлять `triton`, если включен `--enable-linear-replayssm`: кольцевой decode-путь ReplaySSM принимает только его и отвергает старт с любым другим backend'ом.
- Задавать `cutedsl` на KDA-гибридах (Kimi Linear, Kimi K3) при page-major-раскладке: это единственная не-Triton/не-FlashInfer опция, разрешенная ассертом page-major для decode, и только для MLA-гибридов.
- Не менять базу ради decode: перенос базы на `flashinfer` заодно переведет туда prefill и выключит `extra_buffer`.

## Влияние на производительность и память

- VRAM: пул состояний не меняется; отличаются только рабочие буферы ядра.
- RAM хоста: не влияет.
- Время старта: FlashInfer и CuTe DSL компилируются JIT перед первым decode-шагом.
- Latency decode и throughput при большом батче: главный эффект. Ядро выполняется `число_линейных_слоев × число_токенов` раз, поэтому разница накапливается.
- Спекуляция: через наследование verify-backend'а выбор decode влияет и на стоимость сверки черновых токенов.

## Взаимодействие с другими аргументами

- `--linear-attn-backend`: источник значения при незаданном флаге.
- `--mamba-ssm-dtype`: `bfloat16` включает автоподстановку и является обязательным условием для FlashInfer на SM100+.
- `--linear-attn-verify-backend`: по умолчанию следует за decode.
- `--linear-attn-prefill-backend`: независимая фаза; типичная пара для KDA — `flashkda` в prefill и `triton` в decode.
- `--enable-linear-replayssm`: требует `triton`, иначе `ValueError: --enable-linear-replayssm requires the Triton linear-attn decode backend, got …`.
- `--enable-linear-replayssm-spec`: требует `triton` или `flashinfer`.
- `--enable-page-major-kv-layout`: decode-backend должен быть из `{triton, flashinfer}` (плюс `cutedsl` для MLA-гибридов).
- `--mamba-radix-cache-strategy`: не зависит от этого флага (зависит от базы).

## Типовые проблемы и диагностика

- `ValueError: --linear-attn-decode-backend flashkda is not supported: FlashKDA is prefill-only.`
- `ValueError: --linear-attn-decode-backend flashinfer on SM100+ requires --mamba-ssm-dtype bfloat16, got 'float32'`
- `ValueError: --enable-linear-replayssm requires the Triton linear-attn decode backend, got --linear-attn-decode-backend='flashinfer'.`
- `ValueError: Unsupported KDA decode backend: LinearAttnKernelBackend.NVIDIA_KDA. KDA supports 'triton', 'cutedsl', or 'flashinfer'.`
- Задали базу `flashkda`, а в логе decode оказался `triton` — это ожидаемая тихая замена, ищите строку `FlashKDA is prefill-only; using triton for KDA decode …`.
- Что смотреть в логе: `SM100+ detected with mamba-ssm-dtype=bfloat16, defaulting --linear-attn-decode-backend to flashinfer.`, `Linear attention kernel backend: decode=…, prefill=…, verify=…` и строку диспетчера с классами ядер.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-Next-80B-A3B-Instruct --linear-attn-decode-backend flashinfer --mamba-ssm-dtype bfloat16
```

```bash
python -m sglang.launch_server --model-path /models/Kimi-Linear-48B-A3B-Instruct --linear-attn-decode-backend triton --linear-attn-prefill-backend flashkda
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/attention/linear/utils.py`
- `sglang/python/sglang/srt/layers/attention/linear/gdn_backend.py`
- `sglang/python/sglang/srt/layers/attention/linear/kda_backend.py`
- `sglang/python/sglang/srt/layers/attention/attention_registry.py`
