---
schema: 1
engine: sglang
primaryName: "--dcp-replicate-q-proj"
title: "--dcp-replicate-q-proj"
summary: Убирает пооперационный all-gather Q в MLA-decode под DCP: каждый ранг считает полноголовый Q локально из заранее собранных весов. Меняет один коллектив на слой на немного лишнего GEMM.
group: parallel
related:
  - --dcp-size
  - --dcp-comm-backend
  - --quantization
  - --kv-cache-dtype
  - --tp-size
---

# --dcp-replicate-q-proj

## Кратко

В MLA-decode под DCP с backend'ами `a2a`/`fi_a2a` каждый ранг обязан иметь Q по всем головам — иначе не с чем обмениваться частичными выходами. По умолчанию Q собирают all-gather'ом на каждом слое. `--dcp-replicate-q-proj` вместо этого один раз, до захвата графов, собирает сами веса (`q_b_proj` и `w_kc`) в полноголовые буферы, и дальше каждый ранг считает полный Q сам. Обмен уменьшается на один коллектив на слой ценой избыточного GEMM. Это парный флаг (`--no-dcp-replicate-q-proj`) с трехзначным умолчанием `null`: «не задано» означает «решает модель».

## Оригинальная справка

```text
For MLA decode context parallelism with the a2a/fi_a2a backend: replicate the Q projection so each DCP rank computes the full-head query locally (redundant projection compute), eliminating the per-layer head-dim all-gather of Q. Trades a small amount of extra GEMM for one fewer collective per layer. Use --no-dcp-replicate-q-proj to disable the model-specific default.
```

## Паспорт аргумента

- Флаги: `--dcp-replicate-q-proj`, `--no-dcp-replicate-q-proj` (`argparse.BooleanOptionalAction`)
- Группа: `parallel`
- Тип значения: bool (`Optional[bool]` — три состояния)
- Допустимые значения: флаг без значения либо его отрицающая половина
- Значение по умолчанию: `null` — «не задано»
- Эффективное значение: поле `resolvable=True`. Для Kimi-K3 с DCP `arg_groups/overrides.py` при `null` подставляет `True` со строкой `Kimi-K3 DCP enables replicated Q projection by default.` Явно заданный `--no-dcp-replicate-q-proj` эту подстановку отменяет — ради этого и существует отрицающая половина. Для прочих моделей `null` означает «выключено»
- Где объявлен: `ServerArgs.dcp_replicate_q_proj`, файл — `sglang/python/sglang/srt/server_args.py`
- Статус: обычный
- Этап применения: валидация в `_handle_dcp_validation` → подготовка полноголовых весов в model runner до захвата CUDA graph (`_prepare_replicated_q_proj`) → forward на decode

## Что меняет в движке

### Подготовка весов

`ModelRunner._prepare_replicated_q_proj` (`sglang/python/sglang/srt/model_executor/model_runner.py`) выполняется один раз, после построения attention-backend'ов и **до** захвата графов. Для каждого модуля `DeepseekV2AttentionMLA`:

```python
m.w_kc_qrep = dcp_group.all_gather(m.w_kc.contiguous(), dim=0)
m.q_b_proj_qrep_weight = dcp_group.all_gather(qp.weight.data.contiguous(), dim=0)
```

Слои, где это невозможно, тихо пропускаются с предупреждением `dcp_replicate_q_proj: skipping quantized q-proj/w_kc (bf16/fp16 only); this layer keeps the Q all-gather.` — путь поддерживает только неквантованный absorb с весами bf16/fp16. Итог печатается как `dcp_replicate_q_proj: prepared full-head Q weights for <N> MLA layers`. Число `N` — прямой способ убедиться, что оптимизация действительно применилась, а не пропустила все слои.

### Forward

В `forward_mla.py` (и его ROCm-аналоге) флаг участвует в предикате:

```python
q_replicate_active = (
    get_parallel().dcp_replicate_q_proj
    and is_dcp_mla_decode_phase(forward_batch)
    and not self.use_deep_gemm_bmm
    and self.w_kc_qrep is not None
    and self.q_b_proj_qrep_weight is not None
)
```

При активном режиме принудительно выбирается стандартный absorb-путь (`fuse_bmm_attention = False`), чтобы выполнить bmm по полноголовому `w_kc`. То есть флаг не только убирает коллектив, но и запрещает слияние bmm в внимание на этих шагах.

## Значения и формат

- Три состояния: задан (`True`), задан отрицающий флаг (`False`), не задан (`null` — «решает модель»).
- Требует `--dcp-size > 1`: иначе `ValueError: --dcp-replicate-q-proj requires --dcp-size > 1.`
- Требует `--dcp-comm-backend` из `a2a`/`fi_a2a`: иначе `ValueError: --dcp-replicate-q-proj only applies to the a2a/fi_a2a DCP communication backend (it removes the head-dim Q all-gather); got --dcp-comm-backend=…`
- Эффект возможен только на неквантованных bf16/fp16-слоях MLA. На квантованной модели флаг примут, а слои будут пропущены по одному.
- Относится только к MLA-архитектурам DeepSeek-семейства: подготовка обходит модули `DeepseekV2AttentionMLA`.

## Когда использовать

- MLA-модель в bf16/fp16 под DCP с `a2a`/`fi_a2a`, где decode упирается в коммуникацию: минус один коллектив на слой обычно окупает лишний GEMM.
- Наоборот, `--no-dcp-replicate-q-proj` нужен на Kimi-K3, где значение подставляется автоматически, а вы измерили, что на вашей конфигурации выигрыша нет (например, вычислительная часть уже насыщена, а межранговый обмен дешев).
- Не включать на квантованной модели: предупреждения будут по каждому слою, а выигрыша не будет.
- Не включать без DCP или на backend'е `ag_rs` — запуск не состоится.

## Влияние на производительность и память

- Latency decode: минус один коллектив на слой, плюс полноголовый GEMM проекции Q вместо шардированного. Баланс зависит от того, что дороже на вашей топологии.
- VRAM: собранные полноголовые копии `q_b_proj.weight` и `w_kc` хранятся дополнительно к исходным шардам. Расход растет с `dcp_size` и числом MLA-слоев — это единственный флаг из DCP-семейства, у которого есть заметная постоянная плата по памяти.
- Время старта: один all-gather весов на каждый MLA-слой до захвата графов.
- Prefill: не затрагивается — предикат требует фазу decode.

## Взаимодействие с другими аргументами

- `--dcp-size`: обязательно `> 1`.
- `--dcp-comm-backend`: обязательно `a2a` или `fi_a2a`; на `ag_rs` смысл отсутствует, так как Q-all-gather там не является отдельным коллективом.
- `--quantization`: квантованный `q_b_proj` исключает слой из оптимизации.
- `--kv-cache-dtype`: не связан напрямую, но влияет на выбор absorb-пути; условие оптимизации требует, чтобы `w_kc` был bf16/fp16.
- `--tp-size`: определяет исходное шардирование голов, которое и собирается обратно.

## Типовые проблемы и диагностика

- `ValueError: --dcp-replicate-q-proj requires --dcp-size > 1.`
- `ValueError: --dcp-replicate-q-proj only applies to the a2a/fi_a2a DCP communication backend (it removes the head-dim Q all-gather); got --dcp-comm-backend=ag_rs.`
- `dcp_replicate_q_proj: prepared full-head Q weights for 0 MLA layers` — оптимизация не применилась ни к одному слою: смотрите предшествующие предупреждения `skipping quantized q-proj/w_kc (bf16/fp16 only)`.
- Рост потребления VRAM после включения — ожидаем: добавились полноголовые копии весов. Компенсируйте `--mem-fraction-static`.
- Значение включилось само — модельный override Kimi-K3; строка `Kimi-K3 DCP enables replicated Q projection by default.` Отключается явным `--no-dcp-replicate-q-proj`.
- Что смотреть в логе: `dcp_replicate_q_proj=` в дампе `server_args=` и строку `prepared full-head Q weights for N MLA layers`.

## Примеры

```bash
python -m sglang.launch_server --model-path deepseek-ai/DeepSeek-V3 --tensor-parallel-size 8 --decode-context-parallel-size 4 --dcp-comm-backend a2a --dcp-replicate-q-proj
```

```bash
python -m sglang.launch_server --model-path moonshotai/Kimi-K2-Instruct --tensor-parallel-size 8 --decode-context-parallel-size 4 --dcp-comm-backend a2a --no-dcp-replicate-q-proj
```

## Источники

- `sglang/python/sglang/srt/server_args.py`
- `sglang/python/sglang/srt/model_executor/model_runner.py`
- `sglang/python/sglang/srt/models/deepseek_common/attention_forward_methods/forward_mla.py`
- `sglang/python/sglang/srt/models/deepseek_common/attention_forward_methods/forward_mla_rocm.py`
- `sglang/python/sglang/srt/arg_groups/overrides.py`
- `sglang/python/sglang/srt/layers/dcp/comm.py`
