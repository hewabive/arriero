---
schema: 1
engine: sglang
primaryName: "--deepep-v2-mode"
title: "--deepep-v2-mode"
summary: "Выбирает топологию обмена DeepEP v2 при старте: внутри узла или между узлами. Не переключает режим prefill/decode."
group: exec.moe
related:
  - --moe-a2a-backend
  - --moe-runner-backend
  - --deepep-mode
  - --tp-size
---

# --deepep-v2-mode

## Кратко

Выбирает топологию обмена DeepEP v2 при старте: внутри узла или между узлами. Не переключает режим prefill/decode.

Новый аргумент checkout; наличие в установленном окружении проверяйте через `python -m sglang.launch_server --help`.

## Оригинальная справка

```text
DeepEP v2 ElasticBuffer communication topology, fixed at server init: `direct` (single-node NVLink) or `hybrid` (multi-node scale-out). Layout/grouped-GEMM and the decode CUDA graph are chosen per batch by inference phase, independent of this knob; not equivalent to DeepEP v1 normal/low_latency.
```

## Паспорт аргумента

- Флаг: `--deepep-v2-mode`
- Группа: `exec.moe`
- Тип: `enum`
- Декларативный default: `"direct"`
- Объявление: `ServerArgs.deepep_v2_mode` в `sglang/python/sglang/srt/server_args.py`
- Этап применения: разбор CLI и инициализация соответствующей подсистемы; исполнение описано ниже.

## Что меняет в движке

При `--moe-a2a-backend deepep_v2` значение фиксирует топологию `ElasticBuffer`: `direct` для одного узла с NVLink, `hybrid` для нескольких узлов. Формат grouped GEMM и masked decode выбирается отдельно для каждого батча. Проверка допускает архитектуры DeepseekV3ForCausalLM, DeepseekV4ForCausalLM и Qwen3MoeForCausalLM; instance connector не поддерживается. `auto` MoE runner разрешается в `deep_gemm`, другой явный runner отвергается.

## Значения и формат

`direct` по умолчанию; `hybrid` для scale-out. Это другой параметр, чем `--deepep-mode normal/low_latency` из DeepEP v1.

## Когда использовать

Для явно настроенного DeepEP v2 с установленной поддержкой ElasticBuffer и соответствующей межсоединительной сетью.

## Влияние на производительность и память

Меняет коммуникационные буферы и стоимость all-to-all. Prefill CUDA graph отключается; masked decode допускает CUDA graph. Ёмкость dispatch на rank задаёт `SGLANG_DEEPEP_V2_NUM_MAX_DISPATCH_TOKENS_PER_RANK` и должна покрывать prefill.

## Взаимодействие с другими аргументами

Требует `--moe-a2a-backend deepep_v2`; несовместим с deterministic inference, TBO/SBO и `--enforce-shared-experts-fusion`. EP приводится к TP.

## Типовые проблемы и диагностика

Лог `DeepEP v2 MoE is using deepep_v2_mode=...` подтверждает топологию. Ошибки про runner, архитектуру и overlap означают неподдерживаемую конфигурацию.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/Qwen3-30B-A3B --tp-size 8 --moe-a2a-backend deepep_v2 --deepep-v2-mode direct
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/arg_groups/moe_hook.py`
- `sglang/python/sglang/srt/layers/moe/token_dispatcher/deepep_v2.py`
