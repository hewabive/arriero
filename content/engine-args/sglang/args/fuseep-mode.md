---
schema: 1
engine: sglang
primaryName: "--fuseep-mode"
title: "--fuseep-mode"
summary: Выбирает вариант слитого dispatch+GEMM+combine ядра Ascend FuseEP: `1` — путь под decode, `2` — путь, допускающий гибридное развертывание. Читается только на NPU при `--moe-a2a-backend ascend_fuseep` и меняет в том числе раскладку весов после загрузки.
group: exec.moe
related:
  - --moe-a2a-backend
  - --deepep-mode
  - --ep-size
  - --tp-size
---

# --fuseep-mode

## Кратко

FuseEP — путь Ascend, в котором dispatch, групповой GEMM экспертов и combine выполняются одним вызовом NPU-ядра вместо цепочки отдельных операций. Ядро принимает параметр режима, и этот аргумент его задает. Режим влияет не только на forward: раскладка весов экспертов после загрузки готовится по-разному, поэтому сменить режим на живом процессе нельзя, только перезапуском.

## Оригинальная справка

```text
Select the mode when enable Ascend FuseEP MoE, 1 -> dispatch_gmm_combine_decode is executed；2 -> dispatch_ffn_combine is executed (support hybrid deployment when 2).
```

## Паспорт аргумента

- Флаги: `--fuseep-mode`
- Группа: `exec.moe`
- Тип значения: int
- Допустимые значения: `1`, `2`
- Значение по умолчанию: `2`
- Эффективное значение: перед созданием `ServerArgs` функция `_apply_fuseep_mode_env_compat` подставляет значение устаревшей переменной окружения `SGLANG_NPU_FUSED_MOE_MODE`, если она выставлена **и** флага нет в командной строке. Переменная принимает только 1 и 2, иначе `ValueError: Wrong value of SGLANG_NPU_FUSED_MOE_MODE=..., the NPU only supports 1 or 2.`; при подстановке печатается предупреждение об устаревании. Подстановка живет в `prepare_server_args`, то есть работает на пути `python -m sglang.launch_server` / `sglang serve`, а не при программном создании `ServerArgs`
- Где объявлен: `ServerArgs.fuseep_mode`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, но платформо-специфичный: за пределами Ascend NPU не читается
- Этап применения: разбор CLI (совместимость с переменной окружения) → `process_weights_after_loading` (раскладка весов) → каждый forward MoE

## Что меняет в движке

Читается в двух местах `sglang/python/sglang/srt/hardware_backend/npu/moe/fuseep.py`:

1. **Forward.** `forward_fuseep` вызывает `buf.fused_deep_moe(..., fuse_mode=<значение>)` на буфере DeepEP, переведенном в low-latency-режим. Буфер выделяется под bf16 (`_PARAMS_BYTES = 2` с явным примечанием, что Ascend Dispatch & Combine не поддерживает fp16) и под `SGLANG_DEEPEP_NUM_MAX_DISPATCH_TOKENS_PER_RANK` токенов на ранг.
2. **Подготовка весов.** `process_fuseep_weights` вызывается NPU-методами квантизации из `process_weights_after_loading` и раскладывает `w13`/`w2` по-разному:
   - режим `1` переносит `w13` на CPU, транспонирует и переупаковывает чанками по 64, переставляет шкалу `w13` тайлами по 128 и приводит формат тензоров под NPU;
   - режим `2` освобождает промежуточные копии через `resize_(0)`, сжимает шкалу `w13` в двумерный вид и конвертирует шкалы `w13` и `w2` в int64-представление.

Сам путь FuseEP включается не этим аргументом, а `--moe-a2a-backend ascend_fuseep`: `FusedMoE.forward` тогда обходит абстракцию диспетчера и уходит в `forward_fuseep`, а `ascend_fuseep` входит в набор бэкендов, для которых `--ep-size` принудительно приравнивается к `--tp-size`.

## Значения и формат

- `2` (по умолчанию) — `dispatch_ffn_combine`; согласно справке, именно этот режим поддерживает гибридное развертывание.
- `1` — `dispatch_gmm_combine_decode`, вариант, ориентированный на decode.
- Другие значения argparse отвергает по `choices`. Значение хранится как int, а не строка.
- Вне NPU аргумент принимается, попадает в `server_args`, но не читается ни на одном пути.

## Когда использовать

- Развертывание на Ascend NPU с `--moe-a2a-backend ascend_fuseep`, где вы сравниваете два варианта ядра на своем профиле нагрузки.
- Миграция со старой конфигурации, где режим задавался переменной `SGLANG_NPU_FUSED_MOE_MODE`: перенесите значение во флаг и уберите переменную.
- Не трогайте на GPU-развертке: значение не будет прочитано, а конфигурация станет вводить в заблуждение.
- Не рассчитывайте подобрать режим на живом сервере: раскладка весов готовится один раз после загрузки.

## Влияние на производительность и память

- **Форма весов.** Оба режима переупаковывают веса экспертов, но по-разному; режим `2` дополнительно освобождает исходные копии `resize_(0)`, что снижает пик хостовой и устройственной памяти при подготовке.
- **Время старта.** Режим `1` для `w13` уходит на CPU (`.cpu()` → перестановка → `.npu()`), то есть добавляет пересылку весов туда-обратно при загрузке.
- **Latency forward.** Разница между `dispatch_gmm_combine_decode` и `dispatch_ffn_combine` — это разные схемы слияния внутри NPU-ядра; какая быстрее на конкретной модели и батче, определяется замером.
- **Буферы.** Оба режима используют один и тот же low-latency-буфер DeepEP, размер которого задается `SGLANG_DEEPEP_NUM_MAX_DISPATCH_TOKENS_PER_RANK` и числом экспертов, а не этим аргументом.

## Взаимодействие с другими аргументами

- `--moe-a2a-backend`: аргумент имеет смысл только при `ascend_fuseep`.
- `--ep-size` и `--tp-size`: при `ascend_fuseep` первый принудительно приравнивается ко второму.
- `--deepep-mode`: FuseEP всегда переводит буфер в low-latency-режим независимо от значения этого аргумента.
- `--dtype`: буфер FuseEP рассчитан на bf16; fp16 путь Ascend Dispatch & Combine не поддерживает.

## Типовые проблемы и диагностика

- `ValueError: Wrong value of SGLANG_NPU_FUSED_MOE_MODE=3, the NPU only supports 1 or 2.` — некорректная устаревшая переменная окружения.
- Предупреждение `The env variable SGLANG_NPU_FUSED_MOE_MODE is deprecated and will be removed in a future release. Please use --fuseep-mode instead.` — сигнал перенести значение во флаг.
- Флаг задан, а переменная окружения проигнорирована — так и задумано: явный флаг имеет приоритет.
- Ошибки формы весов в NPU-ядре сразу после загрузки — режим не совпадает с тем, под который готовились веса; убедитесь, что процесс перезапущен, а не переконфигурирован.
- Ошибки вида «неподдерживаемый dtype» в dispatch — модель загружена не в bf16.
- Итоговое значение видно в дампе `server_args=` при старте.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --moe-a2a-backend ascend_fuseep --fuseep-mode 2
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tp-size 8 --ep-size 8 --moe-a2a-backend ascend_fuseep --fuseep-mode 1
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/hardware_backend/npu/moe/fuseep.py`
- `sglang/python/sglang/srt/hardware_backend/npu/quantization/moe_methods.py`
- `sglang/python/sglang/srt/layers/moe/fused_moe_triton/layer.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/launch_server.py`
