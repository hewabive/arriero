---
schema: 1
engine: vllm
primaryName: "--gdn-prefill-backend"
title: "--gdn-prefill-backend"
summary: Пожелание, какое ядро использовать на prefill в слоях Gated Delta Net (Qwen3-Next и родственные). Настоящий выбор делает резолвер по compute capability и размерности головы; на карте, где нужное ядро недоступно, значение молча деградирует до Triton.
group: null
related:
  - --kda-prefill-backend
  - --additional-config
---

# --gdn-prefill-backend

## Кратко

`--gdn-prefill-backend` — типизированная витрина над одним ключом `additional_config`. `create_engine_config()` при непустом значении делает ровно `self.additional_config["gdn_prefill_backend"] = value`, и на этом роль аргумента заканчивается: дальше значение читает резолвер в слое линейного внимания.

Аргумент применим только к моделям с блоками Gated Delta Net — в этом checkout'е это Qwen3-Next и родственные архитектуры (`qwen3_next.py`, `qwen3_5.py`, `bailing_moe_v3.py`, `interns2_mobius.py`). На обычной модели с полным вниманием значение не читается вообще.

Ключевое свойство: **это пожелание, а не решение**. Резолвер сверяет запрос с возможностями железа и при несовпадении тихо возвращает Triton.

## Оригинальная справка

```text
Select GDN prefill backend.
```

## Паспорт аргумента

- Флаги: `--gdn-prefill-backend`
- Группа argparse: без группы (объявлен напрямую в `EngineArgs.add_cli_args`)
- Тип значения: строка из фиксированного перечня argparse
- Допустимые значения: `flashinfer`, `triton`, `cutedsl`. Значение `auto` в перечне **отсутствует**, хотя именно оно является внутренним дефолтом резолвера — вернуть автоматический режим можно только убрав аргумент
- Значение по умолчанию: `None` — ключ в `additional_config` не создается, резолвер работает в режиме `auto`
- Эффективное значение: определяется `_resolve_gdn_prefill_backend()`; запрошенное значение может быть заменено на `triton`
- Где объявлен: `vllm/engine/arg_utils.py:add_cli_args`
- Этап применения: `create_engine_config` (запись в `additional_config`) → построение слоев модели и `GDNAttentionMetadataBuilder`

## Что меняет в движке

Где на самом деле живет решение — важнее перечня значений, поэтому смотреть надо не в `--help`, а в две точки кода:

- `_resolve_gdn_prefill_backend(vllm_config)` в `vllm/model_executor/layers/mamba/gdn/qwen_gdn_linear_attn.py` — единственный источник истины;
- `vllm/v1/attention/backends/gdn_attn.py`, который вызывает тот же резолвер при построении метаданных внимания.

Логика резолвера:

1. читает `additional_config.get("gdn_prefill_backend", "auto")`, приводит к нижнему регистру;
2. если платформа не CUDA — сразу `triton`;
3. берет `head_k_dim` из `hf_text_config.linear_key_head_dim` конкретной модели;
4. FlashInfer доступен на Hopper (SM90) без дополнительных условий и на Blackwell (семейство SM10.x) при `head_k_dim == 128` и мажорной версии CUDA runtime не ниже 13;
5. CuteDSL доступен только на Blackwell при тех же условиях и только по явному запросу — в режиме `auto` он не выбирается никогда;
6. `flashinfer` или `auto` при доступном FlashInfer → `flashinfer`; явный `cutedsl` при доступном CuteDSL → `cutedsl`; во всех остальных случаях → `triton`.

Практическое следствие для типичного одиночного GPU уровня Ampere (SM86, например RTX A5000 из квалифицированного профиля arriero): ни FlashInfer, ни CuteDSL недоступны, и любой запрос сводится к `triton`. Ошибки при этом не будет — только строка в логе.

`_log_gdn_backend_decision` печатает решение один раз: `Using <FlashInfer|CuteDSL|Triton/FLA> GDN prefill kernel (requested=<...>, head_k_dim=<...>).` При выборе FlashInfer на Hopper добавляется предупреждение `FlashInfer GDN prefill is JIT-compiled; first run may take a while. Set --gdn-prefill-backend triton to skip JIT.`

Так как значение попадает в `additional_config`, тот же эффект достигается через `--additional-config '{"gdn_prefill_backend": "triton"}'`. При одновременном использовании обоих способов выигрывает специализированный флаг: присвоение в `create_engine_config()` выполняется после разбора JSON-аргумента.

## Значения и формат

- `flashinfer` — просить ядро GDN prefill из FlashInfer. JIT-компилируется при первом запуске.
- `triton` — гарантированно доступное ядро на базе Triton/FLA; единственный способ **запретить** JIT-компиляцию FlashInfer на Hopper.
- `cutedsl` — встроенное CuteDSL-ядро; исключительно opt-in и только на Blackwell при `head_k_dim == 128`.
- Не задан — режим `auto`: FlashInfer, если доступен, иначе Triton.
- Любое другое значение отвергает argparse на разборе строки.

## Когда использовать

- Задавайте `triton` на Hopper, если первый запрос после старта не должен упираться в JIT-компиляцию FlashInfer — движок сам подсказывает это в предупреждении.
- Задавайте `cutedsl` на Blackwell, если замеры показывают выигрыш: в `auto` это ядро не включится никогда.
- Не задавайте `flashinfer` «на всякий случай» на картах ниже Hopper: значение будет проигнорировано, а конфигурация станет вводить в заблуждение.
- Не трогайте вовсе, если модель не использует Gated Delta Net: аргумент примется, попадет в `additional_config` и ни на что не повлияет.

## Влияние на производительность и память

- **VRAM.** Выбор ядра prefill сам по себе бюджет памяти не меняет.
- **Prefill.** Единственная затронутая фаза — вычисление gated delta rule на длинных последовательностях. Decode-путь этим аргументом не управляется.
- **Время первого запроса.** FlashInfer-ядро JIT-компилируется; на Hopper это заметная разовая задержка после старта, о которой движок предупреждает явно.
- **Latency и throughput.** Разница между ядрами измеряется на конкретной модели и длине промпта; универсального «быстрее» здесь нет, и подтверждать выбор следует замером, а не ожиданием.

## Взаимодействие с другими аргументами

- `--kda-prefill-backend`: аналог для Kimi Delta Attention. Аргументы независимы, относятся к разным семействам моделей и ведут себя по-разному при недоступном ядре: GDN тихо деградирует, KDA при явном `flashkda` падает.
- `--additional-config`: тот же ключ в общем словаре; специализированный флаг перезаписывает значение из JSON.
- Аргументы памяти и планировщика на выбор ядра не влияют и им не управляются.

## Типовые проблемы и диагностика

- **Симптом:** задан `flashinfer`, а в логе `Using Triton/FLA GDN prefill kernel (requested=flashinfer, ...)`. **Причина:** карта не Hopper/Blackwell либо не выполнено условие по `head_k_dim`/версии CUDA runtime. **Лечение:** ничего не требуется — это штатная деградация; уберите аргумент, чтобы конфигурация отражала реальность.
- **Симптом:** задан `cutedsl`, а активен `triton`. **Причина:** CuteDSL доступен только на Blackwell при `head_k_dim == 128` и CUDA runtime не ниже 13.
- **Симптом:** первый запрос после старта выполняется десятки секунд. **Причина:** JIT-компиляция FlashInfer-ядра. **Проверка:** предупреждение `FlashInfer GDN prefill is JIT-compiled; ...` **Лечение:** `--gdn-prefill-backend triton`.
- **Симптом:** аргумент задан, но строки о выборе ядра в логе нет. **Причина:** модель не содержит слоев GDN. **Лечение:** аргумент лишний.
- **Подтверждение принятого значения:** строка `Using <ядро> GDN prefill kernel (requested=<...>, head_k_dim=<...>).` — в ней видно и что запрошено, и что реально выбрано.
- **Проверка доступности в вашей сборке:** перечень значений возьмите из `vllm serve --help` установленной версии, а условия применимости — из `_resolve_gdn_prefill_backend` соответствующего checkout'а; перечислять их по памяти бессмысленно, они меняются с каждым новым поколением карт.

## Примеры

```bash
vllm serve /models/Qwen3-Next-80B-A3B-Instruct --gdn-prefill-backend triton --max-model-len 8192
```

```bash
vllm serve /models/Qwen3-Next-80B-A3B-Instruct --additional-config '{"gdn_prefill_backend": "flashinfer"}'
```

## Источники

- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/model_executor/layers/mamba/gdn/qwen_gdn_linear_attn.py`
- `vllm/vllm/v1/attention/backends/gdn_attn.py`
- `vllm/vllm/config/vllm.py`
- `vllm/vllm/model_executor/models/qwen3_next.py`
- `vllm/tests/kernels/mamba/test_gdn_forward_core_split.py`
- `docs/VLLM_OPERATIONS.md` (arriero)
