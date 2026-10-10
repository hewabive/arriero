---
schema: 1
engine: sglang
primaryName: "--enable-page-major-kv-layout"
title: "--enable-page-major-kv-layout"
summary: Страничная раскладка KV и состояния Mamba («страница снаружи, слои внутри страницы»). Сейчас работает только как следствие `--enable-unified-memory`; заданный отдельно флаг роняет старт ассертом «temporarily unsupported».
group: memory
related:
  - --enable-unified-memory
  - --attention-backend
  - --prefill-attention-backend
  - --decode-attention-backend
  - --linear-attn-backend
  - --mamba-backend
  - --page-size
  - --speculative-algorithm
  - --enable-mis
---

# --enable-page-major-kv-layout

## Кратко

По умолчанию KV-пул нарезан по слоям: внешняя ось — номер слоя, внутри — слоты. Страничная (page-major) раскладка переворачивает это: внешняя ось — страница, внутри страницы данные лежат послойно. В текущем checkout'е самостоятельного режима нет: статический page-major пул убран и ждет переписывания, поэтому флаг без `--enable-unified-memory` отвергается на старте. Под unified-пулом флаг включается автоматически, и задавать его руками не нужно. Справка в `--help` («Requires the Triton attention / linear-attn / Mamba backends») отстала от кода: под unified-пулом список допустимых backend'ов полного внимания заметно шире Triton.

## Оригинальная справка

```text
Enable the page-major KV layout: lay out the Mamba state and full/SWA KV caches in a page-granularity envelope (page is the outermost axis, layer-major within a page) instead of the default per-layer (layer-major) layout. Requires the Triton attention / linear-attn / Mamba backends.
```

## Паспорт аргумента

- Флаги: `--enable-page-major-kv-layout`
- Группа: `memory`
- Тип значения: булев флаг (`store_true`)
- Допустимые значения: не применимо, флаг без значения
- Значение по умолчанию: `false`
- Эффективное значение: принудительно становится `true` при `--enable-unified-memory` (`handle_page_major_kv_layout`, запись разрешения под именем `_handle_page_major_kv_layout`); без unified-пула поднятый флаг дает `AssertionError` на старте. Для draft-воркера спекуляции при unified-пуле построитель KV-пула (`KVCacheConfigurator._build_token_to_kv_pool`) флаг игнорирует — draft читает обычную пер-слойную раскладку
- Где объявлен: `python/sglang/srt/arg_groups/fields/memory.py:Memory.enable_page_major_kv_layout`
- Статус: в `--help` выглядит обычным флагом, но самостоятельно временно не поддерживается; фактически это внутренний переключатель раскладки unified-пула
- Этап применения: пайплайн разрешения аргументов (`arg_groups/pipeline.py`: `handle_cache_compatibility` → `handle_page_major_kv_layout` → `handle_unified_memory_pool`) → построение пулов в `KVCacheConfigurator._init_pools` → forward

## Что меняет в движке

### Проверки на старте

`handle_page_major_kv_layout` (`sglang/python/sglang/srt/arg_groups/kv_cache_hook.py`) по порядку:

1. При `--enable-unified-memory` выставляет флаг в `true`.
2. Если флаг поднят без unified-пула — `AssertionError` «--enable-page-major-kv-layout without --enable-unified-memory is temporarily unsupported: the strided MHA K/V views were removed and the static-pool page-major layout awaits its per-layer-view reimplementation. Run with --enable-unified-memory, or drop --enable-page-major-kv-layout.» Строгие 4-мерные K/V-представления статического пула удалены в upstream PR #34602; класс `PageMajorMHATokenToKVPool` (`mem_cache/memory_pool.py`) оставлен как заготовка и не конструируется: его `_create_buffers` бросает `NotImplementedError` «…the static-pool page-major layout is temporarily unsupported (ServerArgs rejects it at startup)…».
3. Модель должна иметь одинаковую ширину строк K и V: для не-MLA модели `has_asymmetric_kv` запрещен (`unified_memory_supported_for_model`), иначе «--enable-unified-memory requires uniform K/V rows (head_dim == v_head_dim)…».
4. Разрешенные attention-backend'ы полного внимания — по разрешенной паре prefill/decode (`attention_backends_of`):
   - MLA-модель под unified-пулом — `triton`, `fa3`, `trtllm_mla`, `flashinfer`, `cutedsl_mla`, `tokenspeed_mla`, `flashmla`;
   - MHA/SWA-модель под unified-пулом — `triton`, `fa3`, `fa4`, `flashinfer`, `trtllm_mha`;
   - без unified-пула в коде остался набор только из `triton`, но эта ветка недостижима из-за шага 2.
5. Linear-attention: decode — `triton` или `flashinfer`, prefill — `triton` или `flashkda`; у MLA-гибридов (KDA-семейство) дополнительно `cutedsl` и `helion`. Проверяется `--linear-attn-decode-backend` / `--linear-attn-prefill-backend`, а если они не заданы — `--linear-attn-backend`.
6. `--mamba-backend` — только `triton` (он же умолчание).

Остальные ограничения unified-пула (спекуляция, PD, DCP, TBO, LMCache) проверяет следующий шаг `handle_unified_memory_pool` — см. `--enable-unified-memory`.

### Раскладка

Целевой воркер под unified-пулом строит все пулы из одного `uint8`-буфера (`mem_cache/unified_memory_pool.py`), раскладку задает `mem_cache/layout/page_major.py`. Страница — это «конверт» вида `[L0_K × ps | L0_V × ps | L1_K × ps | L1_V × ps | …]`, страницы лежат подряд; при `page_size == 1` конверт вырождается в послотовый `[L0_K | L0_V | L1_K | …]`.

- KV полного внимания и SWA (`UnifiedMHATokenToKVPool`, `UnifiedMLATokenToKVPool`): каждому слою выдается обычное непрерывное 3-мерное представление над этим буфером, а ядра адресуют его через общую для всех слоев трансляцию — `kernel_id(t) = (t // ps) * (ps * 2 * layer_num) + t % ps` для MHA и `(t // ps) * (ps * layer_num) + t % ps` для MLA (одна латентная строка на слой). Поэтому backend'ы внимания, умеющие эту трансляцию, работают и без Triton.
- Состояние Mamba/KDA лежит в строковых (strided) представлениях (`build_page_major_mamba_views`), и читать его могут только ядра, прошедшие аудит на произвольные шаги, — отсюда списки шагов 5 и 6.

Побочные эффекты в ядрах: путь Mamba2 при поднятом флаге всегда берет Triton-реализацию causal-conv (`hybrid_linear_attn_backend.py`: CUDA `causal_conv1d` испортил бы строковое состояние); `flashinfer_gdn_prefill_default` (`layers/attention/linear/gdn_backend.py`) не выбирает FlashInfer для GDN-prefill; GDN multi-item scoring (`--enable-mis`) отвергается с `ValueError` «GDN multi-item scoring does not support page-major layout».

Ограничения пула: `UnifiedMHATokenToKVPool` создается с `enable_kv_cache_copy=False` (тайловое ядро копирования KV не используется, перемещение идет нативным путем), а запись prefix-valid (`set_kv_buffer_prefix_valid`) в нем бросает `NotImplementedError` «prefix-valid commit is unsupported under the unified layout…».

## Значения и формат

- Флаг без аргумента.
- Настроек раскладки нет — это бинарный выбор между пер-слойной и страничной формой; размер конверта задает `--page-size`.
- Не путайте с `--hicache-mem-layout`: тот описывает раскладку **host-пула** HiCache, а этот — раскладку пулов на устройстве.

## Когда использовать

- Отдельно — не используйте: в текущем checkout'е такой запуск падает на старте.
- Как следствие `--enable-unified-memory` — он включится сам; явное указание рядом с unified-пулом ничего не меняет и допустимо.
- Решение принимается на уровне `--enable-unified-memory`: если unified-пул не нужен, этот флаг тоже не нужен.

## Влияние на производительность и память

- Суммарный объем VRAM определяет unified-пул, а не раскладка: тот же KV, другая адресация.
- Локальность доступа сдвигается в пользу постраничных операций: все слои одной страницы лежат рядом, что упрощает перемещение и передачу целых страниц.
- Отказ от тайлового копирования KV и принудительный Triton causal-conv на Mamba2 могут стоить производительности по сравнению со штатной раскладкой.
- Ограничение backend'ов (особенно для linear-attn и Mamba) — главный практический риск: если разрешенные ядра на вашей модели медленнее штатных, раскладка съест выигрыш unified-пула.
- На время старта заметно не влияет.

## Взаимодействие с другими аргументами

- `--enable-unified-memory`: обязательный партнер; включает этот флаг принудительно, а от него зависит, какие attention-backend'ы разрешены.
- `--attention-backend`, `--prefill-attention-backend`, `--decode-attention-backend`: разрешенная пара должна попасть в список шага 4, иначе ассерт.
- `--linear-attn-backend` и его prefill/decode-варианты: наборы допустимых значений для prefill и decode различаются.
- `--mamba-backend`: допустим только `triton`.
- `--page-size`: определяет размер конверта; при `page_size 1` страничная раскладка вырождается в послотовую.
- `--speculative-algorithm`: под unified-пулом допустим только линейный `DSPARK`; draft-воркер получает обычную пер-слойную раскладку, а запись prefix-valid в целевой unified MHA-пул не поддержана.
- `--enable-mis`: для GDN-моделей несовместим.

## Типовые проблемы и диагностика

- Ассерт «--enable-page-major-kv-layout without --enable-unified-memory is temporarily unsupported…» — флаг задан сам по себе. Уберите его или включите `--enable-unified-memory`.
- Ассерт «--enable-unified-memory requires uniform K/V rows (head_dim == v_head_dim)…» — у модели разная ширина K и V; unified-пул и страничная раскладка для нее недоступны.
- Ассерт «--enable-page-major-kv-layout: the resolved attention backends [...] are not in the allowed set [...] for this configuration … Pass a compatible --attention-backend.» — смените attention-backend на допустимый для вашей модели.
- Ассерт «--enable-page-major-kv-layout: linear-attention DECODE backend must be one of [...] for the strided conv/SSM state; got …» / «… PREFILL backend must be one of [...]» — неподдерживаемый linear-attn backend.
- Ассерт «--enable-page-major-kv-layout requires the Triton Mamba kernels for the strided conv/SSM state; got …. Pass --mamba-backend triton.» — неверный mamba-backend.
- `NotImplementedError` из `PageMajorMHATokenToKVPool` возможен, только если проверку на старте обошли; штатный запуск до этого класса не доходит.
- Флаг «включился сам» — вы задали `--enable-unified-memory`; в дампе `server_args=` при старте это видно напрямую.

## Примеры

```bash
python -m sglang.launch_server --model-path /models/qwen3-next-hybrid --enable-unified-memory --attention-backend triton --linear-attn-backend triton --mamba-backend triton
```

```bash
python -m sglang.launch_server --model-path /models/qwen3-next-hybrid --enable-unified-memory --enable-page-major-kv-layout --attention-backend triton --mamba-backend triton --page-size 64
```

## Источники

- `sglang/python/sglang/srt/arg_groups/fields/memory.py`
- `sglang/python/sglang/srt/arg_groups/kv_cache_hook.py`
- `sglang/python/sglang/srt/arg_groups/pipeline.py`
- `sglang/python/sglang/srt/arg_groups/model_override_base.py`
- `sglang/python/sglang/srt/mem_cache/unified_memory_pool.py`
- `sglang/python/sglang/srt/mem_cache/layout/page_major.py`
- `sglang/python/sglang/srt/mem_cache/memory_pool.py`
- `sglang/python/sglang/srt/mem_cache/kv_cache_configurator.py`
- `sglang/python/sglang/srt/layers/attention/hybrid_linear_attn_backend.py`
- `sglang/python/sglang/srt/layers/attention/linear/gdn_backend.py`
- `sglang/docs/docs/advanced_features/server_arguments.mdx`
- upstream PR #34602 «feat(unified-memory): dense KV views for uniform-row MHA/SWA models» (коммит `4bea51d885` в checkout)
