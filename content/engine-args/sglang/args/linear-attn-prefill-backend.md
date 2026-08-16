---
schema: 1
engine: sglang
primaryName: "--linear-attn-prefill-backend"
title: "--linear-attn-prefill-backend"
summary: Переопределяет ядро линейного внимания для фазы prefill/extend, не трогая decode и стратегию кеша. Единственная фаза с автоподбором: на SM100 с CUDA 13 и bf16-состоянием GDN-prefill сам уходит на FlashInfer.
group: exec.mamba
related:
  - --linear-attn-backend
  - --linear-attn-decode-backend
  - --linear-attn-verify-backend
  - --mamba-ssm-dtype
  - --chunked-prefill-size
  - --enable-dynamic-chunking
  - --enable-page-major-kv-layout
  - --mamba-radix-cache-strategy
---

# --linear-attn-prefill-backend

## Кратко

Prefill и decode у линейного внимания — принципиально разные ядра: prefill выполняет чанковое сканирование по всей длине, decode — рекуррентный шаг на один токен. Этот флаг задает ядро только для prefill/extend. Его отдельная ценность в том, что он не меняет базовое значение `--linear-attn-backend`, а значит не выбивает архитектуру из числа поддерживающих стратегию `extra_buffer` — в отличие от смены базы.

Это единственная фаза, где движок может подставить backend сам: для GDN-моделей на Blackwell при выполнении девяти условий сразу prefill переключается на FlashInfer.

## Оригинальная справка

```text
Override the kernel backend for linear attention prefill/extend. If not set, uses --linear-attn-backend; compatible SM100 GDN models may automatically select FlashInfer.
```

## Паспорт аргумента

- Флаги: `--linear-attn-prefill-backend`
- Группа: `exec.mamba`
- Тип значения: строка с фиксированным списком (`Optional[str]`)
- Допустимые значения: `triton`, `cutedsl`, `flashinfer`, `flashkda`, `nvidia_kda`, `ptx_kda`, `helion` (общий список `LINEAR_ATTN_KERNEL_BACKEND_CHOICES`, расширяемый out-of-tree пакетами; `helion` — только KDA)
- Значение по умолчанию: `null` — берется `--linear-attn-backend`
- Эффективное значение: при незаданном значении и выполнении условий `flashinfer_gdn_prefill_default` подставляется `flashinfer`; это записывается в разрешенную конфигурацию через `get_context().override("gdn_backend.sm100_flashinfer_default", …)`
- Где объявлен: `ServerArgs.linear_attn_prefill_backend`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: `__post_init__` (`_handle_linear_attn_backend` — проверка CUDA-версии) → создание backend'а внимания (`attention_registry.py`) → каждый prefill/extend линейных слоев

## Что меняет в движке

### Автоподбор FlashInfer для GDN-prefill

`flashinfer_gdn_prefill_default` (`sglang/python/sglang/srt/layers/attention/linear/gdn_backend.py`) возвращает `"flashinfer"` только если выполнено всё сразу:

1. `--linear-attn-prefill-backend` не задан;
2. `--linear-attn-backend` равен `triton`;
3. не включен `--enable-page-major-kv-layout`;
4. платформа CUDA и `torch.cuda.get_device_capability()[0] == 10` (ровно SM100, не SM120);
5. major-версия CUDA не ниже 13;
6. не включен `--enable-dynamic-chunking`;
7. `--chunked-prefill-size` задан и лежит в диапазоне 1…8192;
8. `linear_key_head_dim` и `linear_value_head_dim` модели равны 128;
9. временнáя часть пула состояний уже в `bfloat16`;
10. FlashInfer-ядро GDN-prefill доступно в установленном пакете.

При успехе печатается `Defaulting SM100 GDN prefill backend to FlashInfer.` Обратите внимание на пункт 2: как только вы задаете базу отличной от `triton`, автоподбор молча отключается.

### Проверка на старте

`_handle_linear_attn_backend` проверяет разрешенный prefill (`linear_attn_prefill_backend or linear_attn_backend`):

```text
--linear-attn-prefill-backend flashinfer on SM100+ requires CUDA 13+, got CUDA <версия>
```

Проверка выполняется по `torch.version.cuda`, то есть по версии, с которой собран PyTorch, а не по драйверу.

### Что доступно в каждой семье

- **GDN**: `triton`, `cutedsl`, `flashinfer`. `helion` отвергается именной ошибкой `The Helion linear-attention backend supports KDA only, not GDN.`, остальное — `ValueError: Unsupported GDN prefill backend: …`. `cutedsl` prefill существует только на SM100+, на SM90 диспетчер откатывается на Triton с сообщением `CuTe DSL GDN prefill is not supported on this GPU (requires SM100+). Falling back to Triton for prefill.`
- **KDA**: `triton`, `helion`, `flashkda`, `cutedsl`, `nvidia_kda`, `ptx_kda`. `flashkda` — специализированное prefill-only ядро (обертка собирает непрерывную копию состояния слота, так что внешнее ядро самого пула не видит). `nvidia_kda` требует SM100, `ptx_kda` — SM103 (GB300); вне их обе откатываются на Triton с записью в лог. `helion` требует CUDA и пакет `helion` (`pip install helion==1.4.0`), prefill выполняет собственным chunk-ядром `chunk_kda`.

## Значения и формат

- Значение вне списка отвергает argparse.
- Не задан — берется база, но только после того, как отработал автоподбор GDN.
- `flashkda` осмысленно задавать именно здесь: это его единственная роль. В decode он запрещен явной ошибкой.
- `flashinfer` для prefill на SM100+ жестко требует CUDA 13+.
- На модели без линейного внимания значение принимается и не используется.

## Когда использовать

- Задавать `flashkda` на KDA-моделях (Kimi Linear, Kimi K3), когда prefill длинный: decode при этом остается на Triton, и стратегия кеша не меняется.
- Задавать `flashinfer` вручную, если автоподбор не сработал из-за одного невыполненного условия (например, вы задали `--chunked-prefill-size 16384`), но вы уверены в остальных.
- Не задавать, если вы просто хотите «побыстрее»: на большинстве конфигураций автоподбор уже сделал верный выбор, а ручное значение его отключает.
- Не переносить значение между машинами разных поколений: `nvidia_kda`/`ptx_kda`/`cutedsl` вне своих SM тихо деградируют до Triton, и «оптимизированный» запуск окажется обычным.

## Влияние на производительность и память

- VRAM: буферы prefill-ядра, но не пул состояний. Существенно только на очень больших чанках.
- RAM хоста: не влияет.
- Время старта: FlashInfer- и CuTe DSL-ядра компилируются JIT перед первым prefill'ом — первый длинный запрос после старта дороже.
- TTFT: главный эффект. Prefill линейных слоев — это чанковое сканирование, и разница между Triton и специализированным ядром на длинном промпте измеряется десятками процентов.
- Throughput decode: не меняется вовсе — decode обслуживает другое ядро.

## Взаимодействие с другими аргументами

- `--linear-attn-backend`: источник значения при незаданном флаге и одновременно условие автоподбора (`triton`).
- `--linear-attn-decode-backend`: независимая фаза; `flashkda` здесь и `triton` там — рабочая комбинация.
- `--mamba-ssm-dtype bfloat16`: одно из условий автоподбора (проверяется уже разрешенный тип пула состояний).
- `--chunked-prefill-size`: условие автоподбора (1…8192) и одновременно размер окна, которое обрабатывает ядро.
- `--enable-dynamic-chunking`: отключает автоподбор.
- `--enable-page-major-kv-layout`: отключает автоподбор и сужает допустимые значения до `triton`/`flashkda` (плюс `cutedsl` и `helion` для MLA-гибридов).
- `--mamba-radix-cache-strategy`: не зависит от этого флага — в этом и смысл per-phase переопределения.

## Типовые проблемы и диагностика

- `ValueError: --linear-attn-prefill-backend flashinfer on SM100+ requires CUDA 13+, got CUDA 12.8` — сборка PyTorch с CUDA 12.
- `ValueError: Unsupported GDN prefill backend: LinearAttnKernelBackend.FLASHKDA` — KDA-ядро на GDN-модели; `helion` на GDN дает `The Helion linear-attention backend supports KDA only, not GDN.`
- `ImportError: The Helion package is required when a KDA backend is set to Helion. Install it with: pip install helion==1.4.0` — `helion` задан без установленного пакета.
- В логе `PTX KDA prefill needs SM103 (GB300); falling back to Triton extend.` или `NVIDIA KDA prefill needs SM100; falling back to Triton extend.` — значение принято, но ядро не применилось. Это info-строка, а не ошибка.
- Ожидали автоматический FlashInfer на Blackwell, а его нет — сверьте все десять условий; чаще всего мешает `--chunked-prefill-size` вне диапазона или незаданный `--mamba-ssm-dtype bfloat16`.
- Что смотреть в логе: `Defaulting SM100 GDN prefill backend to FlashInfer.` (если автоподбор сработал), `Linear attention kernel backend: decode=…, prefill=…, verify=…` и строку диспетчера с реальными классами ядер.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Kimi-Linear-48B-A3B-Instruct --linear-attn-prefill-backend flashkda
```

```bash
python -m sglang.launch_server --model-path /models/Qwen3-Next-80B-A3B-Instruct --linear-attn-prefill-backend flashinfer --linear-attn-decode-backend flashinfer --mamba-ssm-dtype bfloat16
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/attention/linear/gdn_backend.py`
- `sglang/python/sglang/srt/layers/attention/linear/kda_backend.py`
- `sglang/python/sglang/srt/layers/attention/linear/kernels/kda_helion.py`
- `sglang/python/sglang/srt/layers/attention/linear/utils.py`
- `sglang/python/sglang/srt/layers/attention/attention_registry.py`
- upstream PR: sgl-project/sglang#32593 ([Kernel] Enable Helion backend for Kimi Delta-Attention)
