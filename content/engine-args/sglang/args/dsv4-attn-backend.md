---
schema: 1
engine: sglang
primaryName: "--dsv4-attn-backend"
title: "--dsv4-attn-backend"
summary: Выбирает backend внимания DeepSeek V4. Режим `trtllm` требует Blackwell и меняет формат KV, поэтому влияет на совместимость процессов.
group: exec.kernel
related:
  - --kv-cache-dtype
  - --disaggregation-mode
---

# --dsv4-attn-backend

## Кратко

Выбирает backend внимания DeepSeek V4. Режим `trtllm` требует Blackwell и меняет формат KV, поэтому влияет на совместимость процессов.

## Оригинальная справка

```text
DeepSeek V4 attention backend. 'auto' (default) resolves to 'flashmla'. 'trtllm' (opt-in, SM100/SM103 with FP8 KV cache) switches the SWA/compressed KV pools to a uniform 512-dim FP8 layout and runs decode and sparse prefill through the flashinfer trtllm-gen sparse MLA kernel. The backend choice is shared by prefill and decode.
```

## Паспорт аргумента

- Флаги: `--dsv4-attn-backend`
- Группа: `exec.kernel`
- Тип: `str`
- Значение в декларации по умолчанию: `auto`
- Объявление: `ServerArgs.dsv4_attn_backend` в `sglang/python/sglang/srt/arg_groups/fields/exec_.py`
- Этап применения: разбор CLI → разрешение параметров сервера → инициализация подсистемы

## Что меняет в движке

После разбора CLI обработчик DeepSeek V4 проверяет GPU, формат KV и режим сервера. `trtllm` использует uniform FP8 KV layout и kernel FlashInfer TRTLLM для decode и sparse prefill; `auto` разрешается в `flashmla`.

## Значения и формат

`auto` оставляет штатный выбор. `flashmla` фиксирует обычный путь; `trtllm` допускается только на CUDA SM100/SM103 с `fp8_e4m3` KV.

## Когда использовать

Задавайте `trtllm` лишь при проверенном профиле DeepSeek V4 на Blackwell. Для прочих систем оставьте `auto`.

## Влияние на производительность и память

Выбор меняет kernel внимания и расположение KV в памяти; размер и скорость зависят от модели и нагрузки, поэтому сравните throughput и VRAM на одинаковом профиле.

## Взаимодействие с другими аргументами

`trtllm` несовместим с `--enable-hisparse`, context parallelism и PD disaggregation: формат KV пока не согласуется в PD handshake. Проверяйте `--kv-cache-dtype`.

## Типовые проблемы и диагностика

При несовместимой карте или режиме запуск прерывается assertion из `deepseek_v4_hook.py`. Сверьте итоговые `server_args` и выбранный attention backend в журнале старта.

## Примеры

```bash
python -m sglang.launch_server --model-path <path> --dsv4-attn-backend trtllm
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/exec_.py`
- `sglang/python/sglang/srt/arg_groups/deepseek_v4_hook.py`
- `sglang/python/sglang/srt/layers/attention/deepseek_v4_trtllm_backend.py`
