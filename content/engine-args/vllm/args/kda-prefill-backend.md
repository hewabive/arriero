---
schema: 1
engine: vllm
primaryName: "--kda-prefill-backend"
title: "--kda-prefill-backend"
summary: Выбор ядра prefill для слоев Kimi Delta Attention (семейство Kimi K3). В отличие от GDN-аналога, явный запрос `flashkda` на неподходящем железе не деградирует, а роняет старт с перечислением невыполненных условий.
group: null
related:
  - --gdn-prefill-backend
  - --additional-config
  - --dtype
---

# --kda-prefill-backend

## Кратко

`--kda-prefill-backend` — типизированная витрина над ключом `additional_config`: `create_engine_config()` при непустом значении выполняет `self.additional_config["kda_prefill_backend"] = value`, и дальше значение читает резолвер внутри слоя Kimi Delta Attention.

Аргумент применим только к моделям семейства Kimi K3 (`vllm/models/kimi_k3/`); на любой другой архитектуре он принимается и не читается.

Отличие от `--gdn-prefill-backend`, которое стоит запомнить: здесь есть режим `auto` прямо в перечне значений, и здесь явный запрос ускоренного ядра при невыполненных условиях **не** молча деградирует, а поднимает `RuntimeError`.

## Оригинальная справка

```text
Select KDA prefill backend.
```

## Паспорт аргумента

- Флаги: `--kda-prefill-backend`
- Группа argparse: без группы (объявлен напрямую в `EngineArgs.add_cli_args`)
- Тип значения: строка из фиксированного перечня argparse
- Допустимые значения: `auto`, `triton`, `flashkda`
- Значение по умолчанию: `None` — ключ в `additional_config` не создается, резолвер использует собственный дефолт `auto`
- Эффективное значение: определяется `resolve_kda_prefill_backend()`; `auto` разрешается в `flashkda` или `triton` по проверке железа, модели и типа данных
- Где объявлен: `vllm/engine/arg_utils.py:add_cli_args`
- Этап применения: `create_engine_config` (запись в `additional_config`) → построение слоя KDA при загрузке модели

## Что меняет в движке

Настоящий список того, что применимо, живет не в `choices`, а в двух функциях `vllm/models/kimi_k3/nvidia/kda.py`:

- `is_flashkda_supported(head_dim, dtype, lower_bound)` — предикат доступности;
- `resolve_kda_prefill_backend(backend, head_dim, dtype, lower_bound)` — собственно выбор.

Предикат требует одновременного выполнения четырех условий: платформа CUDA; мажорная compute capability из набора 9, 10 или 12 (Hopper, Blackwell, Ada-следующего поколения); `head_dim == 128`; `dtype == torch.bfloat16`; и заданная нижняя граница гейта KDA (`lower_bound is not None`).

Резолвер:

1. отвергает любое значение вне `("auto", "triton", "flashkda")` с `ValueError: Unsupported KDA prefill backend: <value>` — это дублирующая защита на случай вызова не из CLI;
2. при явном `flashkda` и невыполненном предикате поднимает `RuntimeError: FlashKDA requires CUDA SM90/SM10x/SM12x, bfloat16, head_dim=128, and a bounded KDA gate.`;
3. при выполненном предикате и любом значении, кроме `triton`, выбирает `flashkda` и печатает `Using FlashKDA KDA prefill backend.` (однократно);
4. иначе возвращает `triton`.

То есть `triton` — единственное значение, которое гарантированно работает везде и одновременно является способом принудительно отказаться от ускоренного ядра.

Есть параллельные точки чтения того же ключа: `vllm/models/kimi_k3/amd/kda.py` и `vllm/model_executor/layers/mamba/gdn/kimi_gdn_linear_attn.py` тоже берут `additional_config.get("kda_prefill_backend", "auto")`. Поэтому сверяться следует с кодом конкретного checkout'а, а не с перечнем из `--help`: набор поддерживаемых архитектур меняется от релиза к релизу.

Эквивалентная запись через общий словарь: `--additional-config '{"kda_prefill_backend": "triton"}'`. При одновременном использовании выигрывает специализированный флаг — присвоение в `create_engine_config()` идет после разбора JSON-аргумента.

## Значения и формат

- `auto` — попытаться использовать FlashKDA, при невыполнении условий тихо взять Triton. В отличие от `--gdn-prefill-backend`, это значение можно задать явно.
- `triton` — принудительно Triton, без проверок и без ошибок.
- `flashkda` — требовать FlashKDA. Если условия не выполнены, старт падает с явным перечислением требований.
- Не задан — то же, что `auto`.
- Любое другое значение отвергает argparse на разборе строки.

## Когда использовать

- `flashkda` — когда ускоренное ядро является частью проверенного профиля и его тихая подмена на Triton была бы регрессией, которую лучше поймать при старте, чем в продакшене. Явное значение здесь работает как assert на конфигурацию железа.
- `triton` — когда нужен воспроизводимый эталон для сравнения или когда ускоренное ядро подозревается в некорректном результате.
- Не задавайте `flashkda` на карте ниже Hopper: старт гарантированно упадет. Для той же цели «использовать, если можно» есть `auto`.
- Не трогайте вовсе, если не запускаете модель семейства Kimi K3.

## Влияние на производительность и память

- **VRAM.** Выбор ядра сам по себе бюджет памяти не меняет.
- **Prefill.** Затрагивается только вычисление KDA на этапе prefill; decode идет другим путем.
- **Время старта.** FlashKDA использует скомпилированное расширение `vllm._flashkda_C`, а не JIT, поэтому разовой компиляции при первом запросе — в отличие от FlashInfer-ядра GDN — здесь нет.
- **Latency и throughput.** Разница измеряется на конкретной модели и длине промпта; выбор следует подтверждать замером.

## Взаимодействие с другими аргументами

- `--gdn-prefill-backend`: аналог для Gated Delta Net. Разные семейства моделей и разное поведение при недоступности ядра: GDN деградирует молча, KDA при явном `flashkda` падает.
- `--additional-config`: тот же ключ в общем словаре; специализированный флаг перезаписывает JSON.
- `--dtype`: FlashKDA требует `bfloat16`. Запуск той же модели в `float16` (в том числе через приведение по `--dtype`) выключает ускоренное ядро в режиме `auto` и роняет старт при явном `flashkda`.

## Типовые проблемы и диагностика

- **Симптом:** `RuntimeError: FlashKDA requires CUDA SM90/SM10x/SM12x, bfloat16, head_dim=128, and a bounded KDA gate.` **Причина:** явный `flashkda` при невыполненном условии — чаще всего это compute capability карты или `dtype`, отличный от bfloat16. **Лечение:** перейти на `auto`, если тихая деградация допустима, или на `triton`, если нужен предсказуемый путь.
- **Симптом:** `ValueError: Unsupported KDA prefill backend: <value>`. **Причина:** значение пришло не через CLI (например, напрямую в `--additional-config` с опечаткой) — argparse такую строку отверг бы сам. **Лечение:** исправить значение в JSON.
- **Симптом:** задан `auto`, а строки `Using FlashKDA KDA prefill backend.` в логе нет. **Причина:** предикат не выполнен, активен Triton. **Лечение:** проверить `--dtype`, compute capability карты и размерность головы модели.
- **Симптом:** аргумент задан, но никакого эффекта. **Причина:** модель не из семейства Kimi K3, ключ никем не читается.
- **Подтверждение принятого значения:** однократная строка `Using FlashKDA KDA prefill backend.` — ее отсутствие означает Triton.
- **Проверка доступности в вашей сборке:** перечень значений — `vllm serve --help` установленной версии; фактические условия применимости — `is_flashkda_supported` в соответствующем checkout'е, поскольку набор поддерживаемых архитектур меняется между релизами.

## Примеры

```bash
vllm serve /models/Kimi-K3 --kda-prefill-backend triton --dtype bfloat16
```

```bash
vllm serve /models/Kimi-K3 --kda-prefill-backend flashkda --dtype bfloat16 --gpu-memory-utilization 0.9
```

## Источники

- `vllm/vllm/engine/arg_utils.py`
- `vllm/vllm/models/kimi_k3/nvidia/kda.py`
- `vllm/vllm/models/kimi_k3/amd/kda.py`
- `vllm/vllm/model_executor/layers/mamba/gdn/kimi_gdn_linear_attn.py`
- `vllm/vllm/config/vllm.py`
