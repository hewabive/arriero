---
schema: 1
engine: sglang
primaryName: "--enable-attn-tp-input-scattered"
title: "--enable-attn-tp-input-scattered"
summary: Разрешает подавать во внимание уже разрезанный по TP вход, чтобы не считать qkv-latent на всех рангах одинаково. Включается только на чистом TP (без DP-attention и без a2a-backend) и на моделях с q_lora_rank.
group: parallel
related:
  - --tp-size
  - --enable-dp-attention
  - --moe-a2a-backend
  - --moe-dense-tp-size
  - --speculative-algorithm
  - --disable-attn-tp-gather
  - --enable-two-batch-overlap
---

# --enable-attn-tp-input-scattered

## Кратко

Флаг снимает дублирование вычислений на входе во внимание: вместо того чтобы каждый TP-ранг считал одну и ту же низкоранговую проекцию (`q_lora`/латентный qkv) над полным набором токенов, вход остается разрезанным по рангам, а собирается уже позже. Разрешение — не гарантия: движок проверяет девять условий и при любом несовпадении пишет в лог `attn_tp_input_scattered is not enabled while other conditions are not met` и работает по обычному пути. Значение по умолчанию `false`.

## Оригинальная справка

```text
Allow input of attention to be scattered when only using tensor parallelism, to reduce the computational load of operations such as qkv latent.
```

## Паспорт аргумента

- Флаги: `--enable-attn-tp-input-scattered`
- Группа: `parallel`
- Тип значения: bool (флаг без значения)
- Допустимые значения: присутствует / отсутствует; парного `--no-…` нет
- Значение по умолчанию: `false`
- Эффективное значение: само поле не переписывается ни одним `_handle_*`, но **фактическое включение** решается позже, уже в `AttnTpContext.init_context` по набору runtime-условий (см. ниже). Дамп `server_args=` покажет `True`, даже если оптимизация не активировалась
- Где объявлен: `ServerArgs.enable_attn_tp_input_scattered`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный, оптимизационный
- Этап применения: публикация в `ParallelState` → `AttnTpContext.init_context` при построении модели (там же строка в логе) → `use_input_scattered` на каждом forward

## Что меняет в движке

Единственная точка чтения — `layers/communicator.py`:

```python
self.allow_input_scattered = (
    get_parallel().enable_attn_tp_input_scattered
    and (_is_cuda or _is_npu)
    and q_lora_rank is not None
    and not is_dsa
    and get_parallel().tp_size > 1
    and not is_dp_attention_enabled()
    and get_moe_a2a_backend().is_none()
    and not enable_moe_dense_fully_dp()
    and not check_cuda_graph_backend(Phase.PREFILL, Backend.TC_PIECEWISE)
    and get_spec().speculative_algorithm != "EAGLE3"
)
```

Разбор условий:

- платформа CUDA или NPU;
- у модели есть `q_lora_rank` (низкоранговая проекция запроса — характерная черта MLA-архитектур);
- модель не DSA (DeepSeek Sparse Attention);
- `--tp-size > 1`;
- DP-attention **выключен**;
- `--moe-a2a-backend none`;
- `--moe-dense-tp-size` не равен `1` (`enable_moe_dense_fully_dp()` должно быть ложно);
- prefill CUDA graph не в режиме `TC_PIECEWISE`;
- `--speculative-algorithm` не `EAGLE3`.

Даже когда `allow_input_scattered` истинно, на конкретном батче путь берется не всегда: `use_input_scattered` дополнительно требует режим extend (prefill), не target-verify, наличие `input_ids` и отсутствие two-batch overlap у этого батча. Сборка обратно делается ленивым `tp_all_gather_hidden_states` при первом обращении к полным скрытым состояниям.

## Значения и формат

- Флаг без аргумента. «Не задан» = вход во внимание собирается на каждом ранге целиком.
- Валидации на старте нет: несовместимая конфигурация не падает, а деградирует до обычного пути с информационной строкой в логе.
- Влияет только на prefill/extend-батчи; decode идет обычным путем.

## Когда использовать

- Чистый TP (без DP-attention, без a2a-backend) на MLA-модели с `q_lora_rank`, где prefill упирается в дублированную латентную проекцию. Это единственная конфигурация, в которой флаг вообще включится.
- Не включайте вместе с `--enable-dp-attention` — условие прямо исключает этот случай.
- Не включайте вместе с `--moe-dense-tp-size 1` и с любым a2a-backend'ом, кроме `none`: не активируется.
- Не ждите эффекта на decode-нагрузке: оптимизация касается extend-фазы.

## Влияние на производительность и память

- **Вычисления prefill.** Основной эффект: qkv-latent считается над `1/tp_size` токенов вместо полного набора на каждом ранге.
- **Коммуникация.** Добавляется отложенный `all_gather` скрытых состояний, когда полный тензор действительно понадобился. Выигрыш положителен, пока экономия на GEMM больше стоимости этого коллектива, — то есть на длинных prefill'ах.
- **VRAM.** Незначительно: временные буферы меньше до момента сборки.
- **Decode-latency.** Не меняется.
- **Время старта.** Не меняется.

## Взаимодействие с другими аргументами

- `--tp-size`: обязан быть `> 1`.
- `--enable-dp-attention`: взаимоисключающе.
- `--moe-a2a-backend`: обязан быть `none`.
- `--moe-dense-tp-size`: значение `1` блокирует оптимизацию.
- `--speculative-algorithm EAGLE3`: блокирует.
- prefill CUDA graph в режиме `TC_PIECEWISE`: блокирует.
- `--enable-two-batch-overlap`: батчи с TBO идут обычным путем.
- `--disable-attn-tp-gather`: другой опт-аут того же стыка, но применимый в противоположных конфигурациях (там, где a2a-backend или `--moe-dense-tp-size` заданы).

## Типовые проблемы и диагностика

- В логе `attn_tp_input_scattered is not enabled while other conditions are not met` — флаг задан, но одно из девяти условий не выполнено. Сообщение не говорит, какое именно: проверяйте по списку выше, начиная с `--enable-dp-attention` и `--moe-a2a-backend`.
- В логе `attn_tp_input_scattered is enabled` — оптимизация активна.
- Флаг задан, в логе нет ни одной из двух строк — `AttnTpContext.init_context` для этой модели не вызывался; архитектура не использует этот путь.
- Ошибок на старте флаг не порождает: `server_args=` покажет `True` независимо от фактической активации, поэтому дамп здесь не доказательство.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V2-Lite --tensor-parallel-size 2 --enable-attn-tp-input-scattered --moe-a2a-backend none
```

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V2-Lite --tensor-parallel-size 4 --enable-attn-tp-input-scattered --chunked-prefill-size 8192
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/layers/communicator.py`
- `sglang/python/sglang/srt/layers/dp_attention.py`
- `sglang/python/sglang/srt/runtime_context.py`
- `sglang/python/sglang/srt/model_executor/cuda_graph_config.py`
